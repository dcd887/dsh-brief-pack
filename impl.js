/**
 * Real implementation of the 任务包打包器 (`@local/dsh-brief-pack`).
 *
 * Loaded by `entry.js` through a dynamic import whose URL carries this file's
 * mtime, so editing this file and reinstalling the bundle changes behaviour
 * without a process restart.
 *
 * Two Host Tools:
 *   - `pack_brief`       reads the listed files ONCE (here, not in the child
 *                        agent's context), extracts hint-located snippets with
 *                        line numbers, and writes one budget-bounded brief.
 *   - `spawn_with_brief` delegates ONE child agent whose prompt is a fixed
 *                        template: read only that brief, write a report, reply
 *                        with a bounded summary.
 *
 * Everything the tools read is real filesystem content; nothing is synthesized.
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'

/* ------------------------------------------------------------------ *
 * Budget accounting
 * ------------------------------------------------------------------ */

/**
 * Coarse token estimate for mixed CJK / ASCII text, deliberately labelled an
 * estimate everywhere it surfaces: CJK code points count as 1/1.5 tokens and
 * ASCII words as length/4.
 */
function estimateTokens(text) {
  let cjk = 0
  for (const ch of text) {
    const cp = ch.codePointAt(0)
    if ((cp >= 0x2e80 && cp <= 0x9fff) || (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xff00 && cp <= 0xffef)) cjk += 1
  }
  const asciiWords = text.replace(/[^\x00-\x7f]/g, ' ').split(/\s+/).filter((word) => word.length > 0)
  const asciiChars = asciiWords.reduce((sum, word) => sum + word.length, 0)
  return Math.ceil(cjk / 1.5 + asciiChars / 4)
}

function utf8Bytes(text) {
  return Buffer.byteLength(text, 'utf8')
}

/* ------------------------------------------------------------------ *
 * Hint matching and snippet extraction
 * ------------------------------------------------------------------ */

const MAX_HINT_TERMS = 12
const MAX_SEGMENTS_PER_FILE = 40
const STRUCTURAL_MAX_LINES = 200
const DEFAULT_CONTEXT_LINES = 8
const MAX_CONTEXT_LINES = 40
const MAX_SECTIONS = 12

/** Split a hint into terms on whitespace, ASCII commas, slashes, and CJK punctuation. */
function hintTerms(hint) {
  return String(hint ?? '')
    .split(/[\s,，、;；/|]+/u)
    .map((term) => term.trim())
    .filter((term) => term.length > 0)
    .slice(0, MAX_HINT_TERMS)
}

function lineMatches(line, terms) {
  const lower = line.toLowerCase()
  for (const term of terms) {
    if (lower.includes(term.toLowerCase())) return term
  }
  return undefined
}

/** Clamp `contextLines` to its documented 0-40 range; absent/invalid values mean the default 8. */
function resolveContextLines(value) {
  if (value === undefined || value === null || value === '') return DEFAULT_CONTEXT_LINES
  const number = Number(value)
  if (!Number.isFinite(number)) return DEFAULT_CONTEXT_LINES
  return Math.min(MAX_CONTEXT_LINES, Math.max(0, Math.floor(number)))
}

/** Normalize the requested `section` list: strings only, trimmed, deduplicated, capped. */
function resolveSections(value) {
  if (!Array.isArray(value)) return []
  const out = []
  for (const item of value) {
    const text = String(item ?? '').trim()
    if (text.length === 0 || out.includes(text)) continue
    out.push(text)
    if (out.length >= MAX_SECTIONS) break
  }
  return out
}

/** Sort and merge touching or overlapping ranges. Ranges are 0-based, both ends inclusive. */
function mergeRanges(ranges) {
  const sorted = [...ranges].sort((a, b) => a.start - b.start)
  const merged = []
  for (const range of sorted) {
    const previous = merged[merged.length - 1]
    if (previous !== undefined && range.start <= previous.end + 1) previous.end = Math.max(previous.end, range.end)
    else merged.push({ start: range.start, end: range.end })
  }
  return merged
}

/**
 * Turn merged ranges into segments: 1-based inclusive line numbers plus the
 * numbered text. `sectionStarts` marks which ranges came from a `section` hit.
 */
function buildSegments(lines, ranges, hitLines, sectionStarts) {
  return mergeRanges(ranges).slice(0, MAX_SEGMENTS_PER_FILE).map((range) => ({
    start: range.start + 1,
    end: range.end + 1,
    hitLines: hitLines.filter((hit) => hit >= range.start && hit <= range.end).map((hit) => hit + 1),
    kind: sectionStarts.has(range.start) ? 'section' : 'hint',
    text: lines.slice(range.start, range.end + 1).join('\n'),
  }))
}

/** Widen each matching line by `context` lines on both sides, clamped to the file. */
function rangesFromHits(hitLines, context, lineCount) {
  return hitLines.map((hit) => ({
    start: Math.max(0, hit - context),
    end: Math.min(lineCount - 1, hit + context),
  }))
}

/**
 * No-hint fallback: a structural digest of the file (its opening context plus
 * heading / list / table lines) rather than the whole file.
 */
function structuralSegments(lines) {
  const picked = new Map()
  const push = (index) => picked.set(index, lines[index])
  for (let i = 0; i < Math.min(lines.length, 12); i += 1) if (lines[i].trim().length > 0) push(i)
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    if (/^\s{0,3}#{1,6}\s/.test(line)) push(i)
    else if (/^\s{0,3}([-*+]|\d+[.)])\s/.test(line)) push(i)
    else if (/^\s{0,3}\|.*\|\s*$/.test(line)) push(i)
  }
  const indices = [...picked.keys()].sort((a, b) => a - b).slice(0, STRUCTURAL_MAX_LINES)
  const segments = []
  for (const index of indices) {
    const previous = segments[segments.length - 1]
    if (previous !== undefined && index === previous.end) {
      previous.end = index + 1
      previous.text += '\n' + lines[index]
    } else {
      segments.push({ start: index + 1, end: index + 1, hitLines: [index + 1], text: lines[index] })
    }
  }
  return { segments, matchedTerms: [], missedTerms: [] }
}

/**
 * Every markdown heading of the file, ignoring `#` lines inside fenced code
 * blocks (a shell comment such as `# 1) 启动器` is not a heading).
 */
function markdownHeadings(lines) {
  const headings = []
  let fence = null
  for (let i = 0; i < lines.length; i += 1) {
    const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(lines[i])
    if (marker !== null) {
      if (fence === null) fence = marker[1][0]
      else if (marker[1][0] === fence) fence = null
      continue
    }
    if (fence !== null) continue
    const heading = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(lines[i])
    if (heading !== null) headings.push({ line: i, level: heading[1].length, text: heading[2].trim() })
  }
  return headings
}

/** Case- and space-insensitive key, so `与 137` matches `6. 与 137/146、144/146 的关系`. */
function headingKey(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[`*_~]/g, '')
    .replace(/\s+/g, '')
}

/**
 * One range per requested section: from its heading line to the line before the
 * next heading of the same or a higher level — i.e. that section's body only.
 */
function locateSections(lines, sections) {
  const headings = markdownHeadings(lines)
  const ranges = []
  const sectionStarts = new Set()
  const matched = []
  const missed = []
  for (const wanted of sections) {
    const needle = headingKey(wanted)
    if (needle.length === 0) continue
    const hit = headings.find((heading) => headingKey(heading.text).includes(needle))
    if (hit === undefined) {
      missed.push(wanted)
      continue
    }
    let end = lines.length - 1
    for (const heading of headings) {
      if (heading.line > hit.line && heading.level <= hit.level) {
        end = heading.line - 1
        break
      }
    }
    if (end < hit.line) end = hit.line
    ranges.push({ start: hit.line, end })
    sectionStarts.add(hit.line)
    matched.push({ requested: wanted, title: hit.text, level: hit.level, start: hit.line + 1, end: end + 1 })
  }
  return { ranges, sectionStarts, matched, missed, headingsFound: headings.length }
}

/**
 * Extract one file's segments. `section` wins over `hint`: when both are given
 * the section bodies are kept in full and the hint-located snippets are merged
 * in as an optional supplement. Neither given → structural digest.
 */
function extractForFile(lines, terms, context, sections) {
  const hitLines = []
  const matchedTerms = new Set()
  for (let i = 0; i < lines.length; i += 1) {
    const term = lineMatches(lines[i], terms)
    if (term === undefined) continue
    hitLines.push(i)
    matchedTerms.add(term)
  }
  const missedTerms = terms.filter((term) => !matchedTerms.has(term))
  if (sections.length > 0) {
    const located = locateSections(lines, sections)
    const ranges = [...located.ranges, ...(terms.length > 0 ? rangesFromHits(hitLines, context, lines.length) : [])]
    return {
      method: terms.length > 0 ? 'section+hint' : 'section',
      segments: buildSegments(lines, ranges, hitLines, located.sectionStarts),
      matchedTerms: [...matchedTerms],
      missedTerms,
      sectionsMatched: located.matched,
      sectionsMissed: located.missed,
      headingsFound: located.headingsFound,
    }
  }
  if (terms.length > 0) {
    return {
      method: 'hint',
      segments: buildSegments(lines, rangesFromHits(hitLines, context, lines.length), hitLines, new Set()),
      matchedTerms: [...matchedTerms],
      missedTerms,
      sectionsMatched: [],
      sectionsMissed: [],
      headingsFound: markdownHeadings(lines).length,
    }
  }
  const structural = structuralSegments(lines)
  return {
    method: 'structural',
    segments: structural.segments,
    matchedTerms: [],
    missedTerms: [],
    sectionsMatched: [],
    sectionsMissed: [],
    headingsFound: markdownHeadings(lines).length,
  }
}

/** Readable heading for one segment, preferring the nearest preceding markdown heading. */
function segmentHeading(lines, startLine) {
  for (let i = Math.min(startLine, lines.length) - 1; i >= 0; i -= 1) {
    const match = /^\s{0,3}(#{1,6})\s+(.*)$/.exec(lines[i])
    if (match !== null) return match[2].trim().slice(0, 80)
  }
  return ''
}

/* ------------------------------------------------------------------ *
 * Brief rendering
 * ------------------------------------------------------------------ */

const BRIEF_INTRO_FOOTER = [
  '> **本包未包含的全文**：以上只含按 hint 命中的片段。',
  '> 需要其它位置或更多上下文时，**再用 `pack_brief` 打包一次**（换更准的 `hint`，或调大 `budgetTokens`）——',
  '> **不要**让子代理直接去读原文件，那正是本插件要消灭的上下文重发。',
]

function numberLines(text, startLine) {
  return text
    .split('\n')
    .map((line, index) => String(startLine + index).padStart(5, ' ') + ' | ' + line)
    .join('\n')
}

function renderSegments(file, segments, note) {
  const out = []
  for (const segment of segments) {
    const heading = segmentHeading(file.lines, segment.start)
    out.push('#### ' + (heading.length > 0 ? heading + ' ' : '') + `(行 ${segment.start}-${segment.end})`)
    if (note !== undefined) out.push(note)
    out.push('```text')
    out.push(numberLines(segment.text, segment.start))
    out.push('```')
  }
  return out.join('\n')
}

function renderFileHeader(file, opts) {
  const lines = []
  lines.push('## ' + file.lines.length + ' 行 · ' + file.bytes + ' 字节 · ' + (file.kind === 'file' ? file.path : file.path + ' (未找到)'))
  if (file.kind !== 'file') {
    lines.push('')
    lines.push('**该路径不存在或不是文件**，本包未包含其任何内容。请核对路径后重新打包。')
    return lines.join('\n')
  }
  lines.push('')
  if (file.method === 'section' || file.method === 'section+hint') {
    lines.push('- 提取方式：**按 `section` 小节标题取整节**（到下一个同级或更高级标题为止）'
      + (file.sectionsMatched.length > 0
        ? '：' + file.sectionsMatched.map((s) => '`' + s.requested + '` → 「' + s.title + '」行 ' + s.start + '-' + s.end).join('、')
        : '：**请求的小节一个都没命中**'))
    if (file.sectionsMissed.length > 0) {
      lines.push('- 未命中的 section：' + file.sectionsMissed.map((s) => '`' + s + '`').join('、') + '（该文件没有这个小节标题，换标题或改用 `hint`）')
    }
    if (file.method === 'section+hint') {
      lines.push('- 另按 `hint` 补充定位 + 上下 ' + opts.context + ' 行，命中关键词：'
        + (file.matchedTerms.length > 0 ? file.matchedTerms.map((t) => '`' + t + '`').join('、') : '（无）'))
      if (file.missedTerms.length > 0) {
        lines.push('- 未命中关键词：' + file.missedTerms.map((t) => '`' + t + '`').join('、') + '（本包内没有这些词，换 hint 或确认文件是否相关）')
      }
    }
    lines.push('- 提取到片段数：' + opts.totalSegments + (opts.droppedSegments > 0 ? '，因预算**丢弃** ' + opts.droppedSegments + ' 段' : ''))
  } else if (opts.hint) {
    lines.push('- 提取方式：按 `hint` 关键词定位 + 上下 ' + opts.context + ' 行')
    lines.push('- 命中关键词：' + (file.matchedTerms.length > 0 ? file.matchedTerms.map((t) => '`' + t + '`').join('、') : '（无）'))
    if (file.missedTerms.length > 0) lines.push('- 未命中关键词：' + file.missedTerms.map((t) => '`' + t + '`').join('、') + '（本包内没有这些词，换 hint 或确认文件是否相关）')
    lines.push('- 提取到片段数：' + opts.totalSegments + (opts.droppedSegments > 0 ? '，因预算**丢弃** ' + opts.droppedSegments + ' 段' : ''))
  } else {
    lines.push('- 提取方式：**未给 hint / section** → 结构摘要（开头上下文 + 标题行 / 列表行 / 表格行，共 ' + opts.totalSegments + ' 段）')
    lines.push('- 想取具体内容请重打包：给 `section`（按小节标题取整节，压缩比最好）或 `hint`（关键词，例如 `hint: "通过数"`）')
  }
  return lines.join('\n')
}

const TRUNCATION_NOTE = '> ⚠️ **此段因 token 预算被截断/丢弃**：只有上面这些片段进入了本包。'
  + '需要被丢弃的部分时，**用更精确的 `hint` 再调用一次 `pack_brief`**（或提高 `budgetTokens`）。'

function slugify(text, fallback) {
  const cleaned = String(text ?? '')
    .replace(/[\s\\/:*?"<>|#`]+/g, '-')
    .replace(/[^\p{Script=Han}A-Za-z0-9-]/gu, '')
    .replace(/-{2,}/g, '-')
    .replace(/^-|-$/g, '')
  const base = cleaned.length > 0 ? cleaned : fallback
  return base.slice(0, 40)
}

function timestamp() {
  const now = new Date()
  const pad = (value) => String(value).padStart(2, '0')
  return now.getFullYear() + pad(now.getMonth() + 1) + pad(now.getDate()) + '-' + pad(now.getHours()) + pad(now.getMinutes()) + pad(now.getSeconds())
}

function defaultOutDir() {
  return path.join(process.env.USERPROFILE || process.env.HOME || '.', 'DSH输出', 'briefs')
}

/* ------------------------------------------------------------------ *
 * pack_brief
 * ------------------------------------------------------------------ */

function readSourceFiles(files, options) {
  const context = options.contextLines
  const sections = options.sections
  return files.map((entry) => {
    const filePath = path.resolve(String(entry.path ?? ''))
    const hint = entry.hint === undefined || entry.hint === null ? '' : String(entry.hint).trim()
    let text = null
    let error = null
    try {
      text = readFileSync(filePath, 'utf8')
    } catch (err) {
      error = err instanceof Error ? err.message : String(err)
    }
    if (text === null) {
      return {
        path: filePath, hint, kind: 'missing', error, bytes: 0, lines: [], method: 'missing',
        matchedTerms: [], missedTerms: [], sectionsMatched: [], sectionsMissed: [], headingsFound: 0, segments: [],
      }
    }
    const lines = text.split(/\r?\n/)
    const terms = hintTerms(hint)
    const extracted = extractForFile(lines, terms, context, sections)
    return {
      path: filePath,
      hint,
      kind: 'file',
      error,
      bytes: utf8Bytes(text),
      lines,
      method: extracted.method,
      matchedTerms: extracted.matchedTerms,
      missedTerms: extracted.missedTerms,
      sectionsMatched: extracted.sectionsMatched,
      sectionsMissed: extracted.sectionsMissed,
      headingsFound: extracted.headingsFound,
      segments: extracted.segments,
    }
  })
}

function assembleBrief(task, files, budget, options) {
  const context = options.contextLines
  const header = [
    '# 任务包（brief）：' + task,
    '',
    '- 生成时间：' + new Date().toISOString(),
    '- token 预算：' + budget + '（**估算**：汉字按 1 字 ≈ 1/1.5 token，ASCII 按 4 字符 ≈ 1 token）',
    '- **本包是节选，不是全文**；全文留在原文件里，没有被读进任何子代理的上下文。',
    '',
  ].join('\n')

  const body = []
  const truncatedFiles = []
  let cost = estimateTokens(header)

  for (const file of files) {
    const headerText = renderFileHeader(file, {
      hint: file.hint,
      context,
      totalSegments: file.segments.length,
      droppedSegments: 0,
    })
    const headerCost = estimateTokens(headerText) + 8
    if (cost + headerCost > budget) {
      truncatedFiles.push({
        path: file.path,
        reason: '剩余预算不足以写入该文件的标题，整个文件未进入本包',
        hintSuggestion: file.hint.length > 0 ? '调小 contextLines、改用 section 取整节，或提高 budgetTokens' : '先给一个 section 或 hint，只打包需要的那几段',
      })
      continue
    }
    cost += headerCost

    const kept = []
    let dropped = 0
    let truncatedInside = false
    for (const segment of file.segments) {
      const rendered = '#### (行 ' + segment.start + '-' + segment.end + ')\n```text\n'
        + numberLines(segment.text, segment.start) + '\n```'
      const segmentCost = estimateTokens(rendered) + 4
      if (cost + segmentCost <= budget) {
        cost += segmentCost
        kept.push(segment)
      } else {
        dropped += 1
      }
    }
    if (dropped > 0) {
      truncatedInside = true
      const noteCost = estimateTokens(TRUNCATION_NOTE) + 4
      if (cost + noteCost <= budget) cost += noteCost
    }

    const effectiveHeader = renderFileHeader(file, {
      hint: file.hint,
      context,
      totalSegments: file.segments.length,
      droppedSegments: dropped,
    })
    const parts = [effectiveHeader, '']
    if (file.kind !== 'file') {
      parts.push('')
    } else if (kept.length === 0) {
      parts.push(TRUNCATION_NOTE, '')
      truncatedFiles.push({
        path: file.path,
        reason: '预算只够写标题，所有片段都被丢弃',
        hintSuggestion: '把 hint 收窄到最关键的一个词、改用 section 取整节，或提高 budgetTokens',
      })
    } else {
      parts.push(renderSegments(file, kept, undefined), '')
      if (truncatedInside) {
        parts.push(TRUNCATION_NOTE, '')
        truncatedFiles.push({
          path: file.path,
          reason: '文件共 ' + file.segments.length + ' 段，本包只含前 ' + kept.length + ' 段，丢弃 ' + dropped + ' 段',
          hintSuggestion: '用更精确的 hint 或 section 再打包一次，即可只取被丢弃的那部分',
        })
      }
    }
    body.push(parts.join('\n'))
  }

  const footer = [
    '',
    '---',
    '',
    '## 本包未包含的全文',
    '',
    ...BRIEF_INTRO_FOOTER,
    '',
    '## 验收标准（执行者填写占位）',
    '',
    '- [ ] （占位）调用方在此写明验收标准；执行者按此自检后再回报。',
    '- [ ] （占位）如需更多原文，**重新打包**而不是直接读原文件。',
    '',
    '## 汇报要求',
    '',
    '- 结果写入简报/报告文件，**只在回复里给 ≤10 行摘要**。',
    '- 不要再去读本包之外的文件。',
    '',
  ].join('\n')

  return { text: header + body.join('\n') + footer, truncatedFiles, approxTokens: estimateTokens(header + body.join('\n') + footer) }
}

/* ------------------------------------------------------------------ *
 * spawn_with_brief
 * ------------------------------------------------------------------ */

function briefTaskLine(briefText, briefPath) {
  const match = /^#\s*任务包（brief）：(.*)$/m.exec(briefText)
  if (match !== null) return match[1].trim()
  return path.basename(briefPath)
}

function briefPromptTemplate(briefPath, reportPath, extra) {
  const lines = [
    '你是一个执行型子代理。任务包已经打包好，**你只需要读这一个文件**：`' + briefPath + '`。',
    '',
    '硬性规则：',
    '1. **只读这一个文件**（以及你在执行中必须读的那几个被明确点名的小文件）。不要再去翻任务包里提到的原文件 / 大报告 —— 那是被刻意排除的，会浪费几十万 token。',
    '2. 任务包里若有「本包未包含的全文」提示，说明节选之外的原文不在包里；如确实缺关键信息，**在摘要里说明缺什么**，不要自己去打开原文件。',
    '3. 把完整结果写进这个报告文件：`' + reportPath + '`（用 UTF-8）。',
    '4. 回复我时**只给 10 行以内的摘要**（结论 / 关键数字 / 产物路径）。不要贴正文，不要复述任务包。',
  ]
  if (typeof extra === 'string' && extra.trim().length > 0) {
    lines.push('', '调用方补充要求：', extra.trim())
  }
  return lines.join('\n')
}

function resultText(result) {
  const blocks = Array.isArray(result?.output) ? result.output : []
  const texts = []
  for (const block of blocks) {
    if (block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') texts.push(block.text)
  }
  return texts.join('\n').trim()
}

function capLines(text, max) {
  const lines = String(text).split(/\r?\n/)
  if (lines.length <= max) return { text: String(text).trim(), dropped: 0 }
  return { text: lines.slice(0, max).join('\n').trim(), dropped: lines.length - max }
}

async function runSpawnWithBrief(ctx, args, exec, cfg) {
  const briefPath = path.resolve(String(args.briefPath ?? ''))
  if (!existsSync(briefPath)) {
    return { error: 'briefPath 不存在：' + briefPath, note: '先用 pack_brief 生成任务包。' }
  }
  const subagents = ctx.get('subagents')
  if (subagents === undefined) {
    return {
      error: 'spawn_with_brief 需要 `subagents` 服务，当前进程没有挂载它。',
      degraded: true,
      note: '缺少的能力：ctx.subagents（由 @deepseek-ai/dsh-subagent + 一个 provider 提供，例如 @deepseek-ai/dsh-subagent-spawn-in-process，provider 名 `spawn`）。',
      workaround: '仍然可以用 pack_brief 打包，然后由调用方自己在自己的工具集里派子代理。',
    }
  }
  const parent = exec.agent
  if (parent === undefined || parent === null) {
    return {
      error: 'spawn_with_brief 需要调用方的 Agent 身份，本次调用没有携带（exec.agent 为空）。',
      degraded: true,
      note: '本工具通过 ctx.subagents.start(name, { parent, ... }) 派子代理；没有父 Agent 就无法建立父子关系。',
    }
  }
  const providers = typeof subagents.list === 'function' ? subagents.list() : []
  const providerName = typeof cfg.subagentProvider === 'string' && providers.includes(cfg.subagentProvider)
    ? cfg.subagentProvider
    : (providers.includes('spawn') ? 'spawn' : (providers[0] ?? ''))
  if (providerName === '') {
    return {
      error: 'spawn_with_brief 找不到任何已注册的 subagent provider。',
      degraded: true,
      note: 'ctx.subagents.list() 返回空。',
      providers,
    }
  }

  const resolvedBrief = readFileSync(briefPath, 'utf8')
  const reportPath = args.reportPath !== undefined && String(args.reportPath).trim().length > 0
    ? path.resolve(String(args.reportPath))
    : path.join(path.dirname(briefPath), path.basename(briefPath).replace(/\.md$/i, '') + '_报告.md')
  const label = args.label !== undefined && String(args.label).trim().length > 0
    ? String(args.label).trim()
    : ('brief:' + slugify(briefTaskLine(resolvedBrief, briefPath), 'task'))
  const timeoutMs = Math.min(Math.max(Number(args.timeoutSeconds ?? cfg.timeoutSeconds) * 1000 || 600000, 30000), 1800000)

  const controller = new AbortController()
  const onOuterAbort = () => controller.abort()
  if (exec.signal !== undefined) exec.signal.addEventListener('abort', onOuterAbort, { once: true })
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  let run
  try {
    run = await subagents.start(providerName, {
      label,
      prompt: [{ type: 'text', text: briefPromptTemplate(briefPath, reportPath, args.extra) }],
      parent,
      signal: controller.signal,
    })
  } catch (err) {
    clearTimeout(timer)
    if (exec.signal !== undefined) exec.signal.removeEventListener('abort', onOuterAbort)
    return {
      error: 'subagents.start 失败：' + (err instanceof Error ? err.message : String(err)),
      degraded: true,
      provider: providerName,
      briefPath,
    }
  }

  let result
  let failure = null
  try {
    result = await run.result
  } catch (err) {
    failure = err instanceof Error ? err.message : String(err)
  }
  clearTimeout(timer)
  if (exec.signal !== undefined) exec.signal.removeEventListener('abort', onOuterAbort)

  const subagentId = run.localAgent !== undefined && run.localAgent !== null && typeof run.localAgent.id === 'string'
    ? run.localAgent.id
    : (typeof run.id === 'string' ? run.id : '')
  const stopReason = result !== undefined && result !== null && typeof result.stopReason === 'string' ? result.stopReason : (failure === null ? 'unknown' : 'error')
  let summary = result === undefined || result === null ? '' : resultText(result)
  let source = 'subagent-reply'
  if (summary.length === 0 && existsSync(reportPath)) {
    summary = readFileSync(reportPath, 'utf8')
    source = 'report-file:' + reportPath
  }
  if (summary.length === 0) {
    summary = result !== undefined && result !== null && typeof result.diagnostic === 'string'
      ? result.diagnostic
      : '(子代理没有返回文本)'
    source = 'diagnostic'
  }
  const capped = capLines(summary, 14)

  return {
    subagentId,
    provider: providerName,
    label,
    briefPath,
    reportPath,
    reportWritten: existsSync(reportPath),
    briefBytes: utf8Bytes(resolvedBrief),
    stopReason,
    summary: capped.text,
    summaryLinesReturned: capped.text.split(/\r?\n/).length,
    summaryLinesDropped: capped.dropped,
    summarySource: source,
    ...(failure === null ? {} : { error: failure }),
    note: failure === null
      ? '摘要已按 ≤10 行要求截断（含空行最多 14 行）；完整结果在 reportPath。'
      : '子代理结果 promise 拒绝：' + failure + '；摘要来自可用的回退来源。',
  }
}

/* ------------------------------------------------------------------ *
 * Plugin face
 * ------------------------------------------------------------------ */

export const CONFIG_KEYS = ['outDir', 'budgetTokens', 'subagentProvider', 'timeoutSeconds']

const DEFAULTS = {
  outDir: '',
  budgetTokens: 8000,
  subagentProvider: 'spawn',
  timeoutSeconds: 600,
}

function normalizeConfig(config) {
  const raw = config !== null && typeof config === 'object' ? config : {}
  const out = { ...DEFAULTS }
  if (typeof raw.outDir === 'string') out.outDir = raw.outDir
  const budget = Number(raw.budgetTokens)
  if (Number.isFinite(budget) && budget >= 1500) out.budgetTokens = Math.floor(budget)
  if (typeof raw.subagentProvider === 'string' && raw.subagentProvider.trim().length > 0) out.subagentProvider = raw.subagentProvider.trim()
  const timeout = Number(raw.timeoutSeconds)
  if (Number.isFinite(timeout) && timeout >= 30) out.timeoutSeconds = Math.floor(timeout)
  return out
}

const packParameters = {
  type: 'object',
  properties: {
    task: {
      type: 'string',
      description: '这一包要支撑的任务，一句话（会写进任务包标题和执行者的任务说明）。',
    },
    files: {
      type: 'array',
      description: '要打包的文件清单。优先用顶层 `section` 取整节；否则每个文件给一个 `hint` 关键词取片段；两者都没有时该文件只放结构摘要。',
      items: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '文件的绝对路径。' },
          hint: {
            type: 'string',
            description: '定位这一段内容的关键词，用空格分隔多个词（例如 "通过数 失败 建议"）。命中行的前后各 `contextLines` 行（默认 8）会一起进入本包。缺省 = 该文件按结构摘要处理（标题行 / 列表行 / 表格行）。给了顶层 `section` 时它只作补充。',
          },
        },
        required: ['path'],
        additionalProperties: false,
      },
    },
    contextLines: {
      type: 'integer',
      minimum: 0,
      maximum: 40,
      description: '`hint` 命中行的前后各取多少行，默认 8，范围 0-40（越界会被夹到边界）。取 0 = 只取命中行本身，取 2 = 前后各 2 行。给 `section` 时此值只作用于 `hint` 补充片段，不影响整节内容。',
    },
    section: {
      type: 'array',
      items: { type: 'string' },
      description: '按 markdown 小节标题定位，每个元素匹配一个标题行（如 ["3. 结果汇总", "简历怎么写"]），取该节直到下一个同级或更高级标题；标题匹配忽略空格与 `*`/`_`/反引号，只要求是标题文本的子串。给了 `section` 就优先用它，`hint` 变成可选补充；两种都没命中时返回里会逐条列出未命中的标题。',
    },
    budgetTokens: {
      type: 'integer',
      description: '本包允许的 token 估算上限，默认 8000（插件配置可改，最小 1500）。超限即截断并在 truncatedFiles 里逐条标注，不会静默超预算。',
    },
    outDir: {
      type: 'string',
      description: '任务包输出目录。未配置时落到 <用户目录>/DSH输出/briefs。',
    },
  },
  required: ['task', 'files'],
  additionalProperties: false,
}

const packOutput = {
  schema: {
    type: 'object',
    properties: {
      briefPath: { type: 'string' },
      bytes: { type: 'integer' },
      approxTokens: { type: 'integer' },
      budgetTokens: { type: 'integer' },
      tokenEstimateNote: { type: 'string' },
      filesPacked: { type: 'array', items: { type: 'object' } },
      truncatedFiles: { type: 'array', items: { type: 'object' } },
      preview: { type: 'string' },
      error: { type: 'string' },
    },
  },
  render: (_args, value) => [{
    type: 'text',
    text: '任务包已写出：' + value.briefPath
      + '\n体积：' + value.bytes + ' 字节 / 约 ' + value.approxTokens + ' tokens（估算，预算 ' + value.budgetTokens + '）'
      + '\n已打包文件：' + value.filesPacked.length + '，被截断文件：' + value.truncatedFiles.length
      + '\n实际用法：' + value.filesPacked.map((file) => {
        const used = String(file.method ?? '?')
        const sections = Array.isArray(file.sectionsMatched) && file.sectionsMatched.length > 0
          ? '{' + file.sectionsMatched.map((s) => s.requested + '=行' + s.start + '-' + s.end).join(' ') + '}'
          : ''
        const missed = Array.isArray(file.sectionsMissed) && file.sectionsMissed.length > 0
          ? ' 未命中section[' + file.sectionsMissed.join('|') + ']'
          : ''
        return used + sections + missed
      }).join('，')
      + (value.truncatedFiles.length > 0
        ? '\n' + value.truncatedFiles.map((item) => '- 截断：' + item.path + '（' + item.reason + '；' + item.hintSuggestion + '）').join('\n')
        : '')
      + '\n\n前 30 行预览：\n' + String(value.preview ?? ''),
  }],
}

const spawnParameters = {
  type: 'object',
  properties: {
    briefPath: {
      type: 'string',
      description: 'pack_brief 返回的 briefPath（任务包绝对路径）。子代理只会读这一个文件。',
    },
    reportPath: {
      type: 'string',
      description: '要求子代理写入完整结果的报告文件绝对路径。缺省 = 任务包同目录下的 `<任务包名>_报告.md`。',
    },
    label: { type: 'string', description: '子代理显示名，缺省由任务包标题生成。' },
    extra: { type: 'string', description: '附加到固定 prompt 模板末尾的补充要求（可选）。' },
    timeoutSeconds: {
      type: 'integer',
      description: '等待子代理完成的上限秒数，默认取插件配置（出厂 600），上限 1800。超时后按 aborted 返回。',
    },
  },
  required: ['briefPath'],
  additionalProperties: false,
}

const spawnOutput = {
  schema: {
    type: 'object',
    properties: {
      subagentId: { type: 'string' },
      provider: { type: 'string' },
      label: { type: 'string' },
      briefPath: { type: 'string' },
      reportPath: { type: 'string' },
      reportWritten: { type: 'boolean' },
      briefBytes: { type: 'integer' },
      stopReason: { type: 'string' },
      summary: { type: 'string' },
      summaryLinesReturned: { type: 'integer' },
      summaryLinesDropped: { type: 'integer' },
      summarySource: { type: 'string' },
      note: { type: 'string' },
      providers: { type: 'array', items: { type: 'string' } },
      workaround: { type: 'string' },
      degraded: { type: 'boolean' },
      error: { type: 'string' },
    },
  },
  render: (_args, value) => [{
    type: 'text',
    text: (value.error !== undefined ? '子代理未成功完成：' + value.error + '\n' : '')
      + (value.subagentId !== undefined ? '子代理 id：' + value.subagentId + '（provider ' + value.provider + '，stopReason ' + value.stopReason + '）\n' : '')
      + (value.degraded === true ? '降级说明：' + String(value.note ?? '') + '\n' : '')
      + (value.reportPath !== undefined ? '报告：' + value.reportPath + (value.reportWritten === true ? '（已写入）' : '（未检出，子代理可能未写）') + '\n' : '')
      + '\n子代理 ≤10 行摘要：\n' + String(value.summary ?? ''),
  }],
}

function packBrief(args, cfg) {
  const task = String(args.task ?? '').trim()
  if (task.length === 0) return { error: 'task 不能为空', briefPath: '', bytes: 0, approxTokens: 0, budgetTokens: 0, filesPacked: [], truncatedFiles: [] }
  const requested = Array.isArray(args.files) ? args.files : []
  if (requested.length === 0) return { error: 'files 不能为空', briefPath: '', bytes: 0, approxTokens: 0, budgetTokens: 0, filesPacked: [], truncatedFiles: [] }
  const configured = cfg.budgetTokens
  const budget = Math.max(1500, Math.floor(Number(args.budgetTokens ?? configured) || configured))
  const outDir = args.outDir !== undefined && String(args.outDir).trim().length > 0
    ? path.resolve(String(args.outDir))
    : path.resolve(cfg.outDir.length > 0 ? cfg.outDir : defaultOutDir())

  const contextLines = resolveContextLines(args.contextLines)
  const sections = resolveSections(args.section)
  const files = readSourceFiles(requested, { contextLines, sections })
  const assembled = assembleBrief(task, files, budget, { contextLines })
  mkdirSync(outDir, { recursive: true })
  const briefPath = path.join(outDir, slugify(task, 'brief') + '-' + timestamp() + '.md')
  writeFileSync(briefPath, assembled.text, 'utf8')

  const previewLines = assembled.text.split(/\r?\n/).slice(0, 30).join('\n')
  return {
    briefPath,
    bytes: utf8Bytes(assembled.text),
    approxTokens: assembled.approxTokens,
    budgetTokens: budget,
    tokenEstimateNote: '估算：汉字 ≈ 1/1.5 token，ASCII ≈ 4 字符/token；非精确计数。',
    filesPacked: files.map((file) => ({
      path: file.path,
      bytes: file.bytes,
      lines: file.lines.length,
      kind: file.kind,
      method: file.method,
      contextLines,
      headingsFound: file.headingsFound,
      hint: file.hint,
      matchedTerms: file.matchedTerms,
      missedTerms: file.missedTerms,
      sectionsMatched: file.sectionsMatched,
      sectionsMissed: file.sectionsMissed,
      segments: file.segments.length,
      ...(file.error === null || file.error === undefined ? {} : { error: file.error }),
    })),
    truncatedFiles: assembled.truncatedFiles,
    preview: previewLines,
    outDir,
  }
}

export function apply(ctx, config) {
  const cfg = normalizeConfig(config)

  ctx.effect(() => ctx.tools.register({
    name: 'pack_brief',
    description: '把若干大文件按关键词或 markdown 小节压成一个 ≤8000 token 的任务包（brief），供子代理只读这一个文件，'
      + '从而避免"每个子代理各自去翻大报告"造成的上下文重发。'
      + '什么时候用：要把大报告 / 大日志 / 大源码交给子代理或另一次对话之前；尤其当你只需要其中几节时。'
      + '什么时候不用：目标内容你自己只需要看几行（直接读那个文件更省），或源文件本来就很短（省不下多少）。'
      + '两种定位方式：① `section` 按 markdown 小节标题取整节（推荐，压缩比最好，整节不截断）；'
      + '② 每个文件给 `hint` 关键词，命中行前后各取 `contextLines` 行。'
      + '**给了 `section` 就优先用它**，此时 `hint` 只作可选补充；两者都没给才退回结构摘要（标题行 / 列表行 / 表格行）。'
      + '`contextLines` 默认 8，范围 0-40（0 = 只取命中行）。'
      + '推荐流程：先 `pack_brief`，再 `spawn_with_brief`。'
      + '返回 briefPath / bytes / approxTokens / filesPacked（每项含实际用的 method、命中的 section 行号区间）/ truncatedFiles'
      + '——**不返回任务包全文**，要内容请让子代理去读 briefPath。'
      + '超预算会截断并在 truncatedFiles 里逐条标注如何用更窄的 hint / section 取回。',
    parameters: packParameters,
    output: packOutput,
    execute: (args) => Promise.resolve(packBrief(args ?? {}, cfg)),
    isConcurrencySafe: () => true,
  }), 'brief-pack: pack_brief tool')

  ctx.effect(() => ctx.tools.register({
    name: 'spawn_with_brief',
    description: '派一个子代理，它的 prompt 被写死为"只读这一个任务包文件、不要再去翻其它文件、把完整结果写进报告文件、'
      + '只回 ≤10 行摘要"。'
      + '什么时候用：任务包（pack_brief 的产物）已经就绪，需要有人真正执行/汇总时。'
      + '什么时候不用：还没有任务包（先 pack_brief），或子代理需要大量交叉阅读多个来源（本工具的设计目标正是不让它那样做）。'
      + '本工具会等到子代理跑完，返回 subagentId、报告路径与摘要；子代理的完整输出只在报告文件里，'
      + '所以它的中间过程不会进入你的上下文。若本进程没有 `subagents` 服务，它会明确降级报错，不会假装成功。',
    parameters: spawnParameters,
    output: spawnOutput,
    execute: (args, exec) => runSpawnWithBrief(ctx, args ?? {}, exec, cfg),
    isConcurrencySafe: () => false,
    timeoutMs: 1800000,
  }), 'brief-pack: spawn_with_brief tool')
}
