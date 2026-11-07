// 自测：直接调 pack_brief 的实现，用仓库内自带样例（test/fixtures/sample.md）。
// 覆盖两种定位方式（顶层 section 取整节、每文件 hint 取命中行前后）、预算下限夹取、返回值结构。
// 任一断言失败，退出码为 1。
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'

import { apply } from './impl.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const fixture = path.join(here, 'test', 'fixtures', 'sample.md')
if (!fs.existsSync(fixture)) {
  console.error(`样例文件不存在：${fixture}`)
  process.exit(1)
}

const registered = {}
const ctx = {
  effect: (fn) => { fn(); return () => {} },
  tools: { register: (d) => { registered[d.name] = d; return () => {} } },
}
apply(ctx, {})

const pack = registered['pack_brief']
if (!pack) {
  console.error('pack_brief 未注册')
  process.exit(1)
}

let failures = 0
const check = (label, ok, detail) => {
  if (!ok) failures++
  console.log(`  ${ok ? 'PASS' : 'FAIL'} ${label}${detail ? ' — ' + detail : ''}`)
}

// 输出目录放到系统临时目录，不在仓库里留产物
const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'brief-pack-selftest-'))
const run = (args) => pack.execute({ outDir, ...args })

console.log(`样例：${path.relative(here, fixture)}（${fs.statSync(fixture).size} 字节）`)
console.log(`输出：${outDir}`)

// 1) 顶层 section 取整节
{
  const r = await run({ task: 'selftest-section', files: [{ path: fixture }], section: ['3. 建议与优先级'] })
  console.log('\n【section】')
  check('返回 briefPath', typeof r.briefPath === 'string' && r.briefPath.length > 0)
  check('打包字节 > 0', r.bytes > 0, `bytes=${r.bytes}`)
  check('估算 token > 0', r.approxTokens > 0, `tokens=${r.approxTokens}`)
  check('method 是 section', r.filesPacked?.[0]?.method === 'section', `method=${r.filesPacked?.[0]?.method}`)
  const body = fs.readFileSync(r.briefPath, 'utf8')
  check('含目标小节标题', body.includes('建议与优先级'))
  check('不含未请求的小节', !body.includes('失败明细'))
}

// 2) 每文件 hint 取命中行
{
  const r = await run({ task: 'selftest-hint', files: [{ path: fixture, hint: '通过数 失败 建议' }], contextLines: 2 })
  console.log('\n【hint】')
  check('返回 briefPath', typeof r.briefPath === 'string' && r.briefPath.length > 0)
  check('method 是 hint', r.filesPacked?.[0]?.method === 'hint', `method=${r.filesPacked?.[0]?.method}`)
  const body = fs.readFileSync(r.briefPath, 'utf8')
  check('含命中的关键词', body.includes('通过数'))
}

// 3) budgetTokens 下限：传 200 应被夹到 >=1500
{
  const r = await run({ task: 'selftest-budget', files: [{ path: fixture }], budgetTokens: 200 })
  console.log('\n【budget】')
  check('返回 budgetTokens', typeof r.budgetTokens === 'number', `budgetTokens=${r.budgetTokens}`)
  check('预算被夹到 >=1500', r.budgetTokens >= 1500, `budgetTokens=${r.budgetTokens}`)
}

fs.rmSync(outDir, { recursive: true, force: true })
console.log(`\n结果：${failures === 0 ? '全部通过' : failures + ' 项失败'}`)
process.exitCode = failures === 0 ? 0 : 1
