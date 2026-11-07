# dsh-brief-pack · 任务包打包器

把"每个子代理各自去翻大报告"换成"**读只发生一次**"：`pack_brief` 在一次性的打包步骤里读完大文件、
只把按关键词命中的片段写成一个 ≤8000 token 的任务包；子代理只读这**一个**文件。

两个 Host 工具都是纯 Node 实现（无 Python、无外部进程、无网络）。

---

## 工具

### `pack_brief`

| 参数 | 类型 | 说明 |
|---|---|---|
| `task` | string（必填） | 这一包要支撑的任务，写进任务包标题 |
| `files` | array（必填） | `[{ path, hint? }]`；`path` 为绝对路径，`hint` 为空则只放该文件的结构摘要 |
| `budgetTokens` | integer | token 预算上限，默认取插件配置（出厂 8000，最小 1500） |
| `outDir` | string | 输出目录，默认取插件配置（出厂 `<用户目录>/DSH输出/briefs`） |

返回（**不含任务包全文**，避免"省下来的又还回去"）：

```json
{
  "briefPath": "...\\briefs\\summary-20261108-021504.md",
  "bytes": 17506,
  "approxTokens": 3590,
  "budgetTokens": 8000,
  "tokenEstimateNote": "估算：汉字 ≈ 1/1.5 token，ASCII ≈ 4 字符/token；非精确计数。",
  "filesPacked": [{ "path": "...", "bytes": 23282, "lines": 315, "kind": "file",
                    "hint": "真实通过数 16 条失败 建议优先级", "matchedTerms": ["真实通过数","16","条失败"],
                    "missedTerms": ["建议优先级"], "segments": 6 }],
  "truncatedFiles": [],
  "preview": "（任务包前 30 行）"
}
```

`hint` 缺省时取**结构摘要**：开头上下文 + 标题行（`#`）/ 列表行（`-` `1.`）/ 表格行（`| ... |`），
**不会**把全文塞进去。

### `spawn_with_brief`

| 参数 | 类型 | 说明 |
|---|---|---|
| `briefPath` | string（必填） | `pack_brief` 返回的任务包路径 |
| `reportPath` | string | 子代理写完整结果的报告路径；缺省 `<任务包名>_报告.md` 同目录 |
| `label` | string | 子代理显示名；缺省由任务包标题生成 |
| `extra` | string | 追加到固定 prompt 末尾的补充要求 |
| `timeoutSeconds` | integer | 等待上限，默认取插件配置（出厂 600），上限 1800 |

派出的子代理 prompt 是**固定模板**：只读 `briefPath` 这一个文件 / 不要再去翻其它文件（并说明包里
哪些内容是刻意排除的）/ 把完整结果写进 `reportPath` / **只回 ≤10 行摘要**。工具等到子代理跑完，
返回 `subagentId`、`reportPath`、`reportWritten`、`stopReason` 与摘要（最多 14 行含空行）。
子代理的中间过程因此不进入调用方上下文。

---

## 生效矩阵

| 改动 | 生效方式 |
|---|---|
| `impl.js` | `plugin_manager` `remove_bundle` + `install_bundle` 即生效，**不用重启**（entry 用 mtime 化动态 import 拉 impl） |
| `entry.js` / `package.json` / `cordis.patch.yml` / `locale` / `icon.svg` | 需重启 Harness，或换包名（entry 的模块解析与命名空间在进程内被钉死） |
| 插件配置 | 直接改 `profiles\web\cordis.patch.yml` 的 `brief-pack` 行 config |
| 判断插件是否活着 | 用 `cordis_inspect_query`（Host `Tool.listTools`）看 `pack_brief` / `spawn_with_brief` 是否可见；**不要**只看 `Config.status` |

## 配置（插件行 config）

| 键 | 默认 | 说明 |
|---|---|---|
| `outDir` | 空 → `<用户目录>/DSH输出/briefs` | 任务包默认输出目录 |
| `budgetTokens` | 8000 | 默认 token 预算（最小 1500） |
| `subagentProvider` | `spawn` | `ctx.subagents.start(name, ...)` 用的 provider 名；不在注册表里时自动回退到首个可用 provider |
| `timeoutSeconds` | 600 | 等子代理的上限 |

---

## 已知限制 / 需核实项

1. **token 是估算**：汉字 ≈ 1/1.5 token、ASCII ≈ 4 字符/token。硬预算是**估算上限**，不是真实分词计数；
   与真实 tokenizer 可能有 ±20% 级偏差。返回值与任务包正文都标注了这一点。
2. **无 `subagents` 服务时会明确降级**：返回 `degraded: true` + 缺什么能力的说明，不假装成功。
   `spawn_with_brief` 依赖 `ctx.subagents.start(provider, { parent, prompt, signal, label })`
   （Host `Service.listService` 实测签名）与 `exec.agent`；本机 profile 的 `spawn` provider 由
   `@deepseek-ai/dsh-subagent-spawn-in-process` 注册（`providerName: spawn`）。
3. **`spawn_with_brief` 是阻塞调用**：默认最多等 600 秒。子代理很慢时会阻塞调用方这一轮。
4. **`exec.agent` 为空时**（理论上无 Agent 的调用）会拒绝执行，不建孤儿会话。
5. **结构摘要上限**：无 `hint` 时最多取 200 条结构行、单文件最多 40 段命中片段——极长文档的超长
   结构摘要可能被这两条上限截掉，此时以逐文件 header 里的段数为准。
6. **只读/写文件系统用 Node `fs`**：任务包与原文件路径都按绝对路径处理，不受工作区沙箱相对路径影响；
   但 `outDir` 必须是当前进程可写的目录。
7. **未做**：二进制/超长单行文件的专门处理（按文本读取）；`.md` 之外格式没有专门语法解析。

## 自测脚本（`_selftest/`）

| 文件 | 用途 |
|---|---|
| `jsoncheck.mjs` | 校验 `package.json` / `locale/*.json` 是合法 JSON 且 UTF-8 字节数正确（PowerShell 会把 UTF-8 读成乱码，必须用 node 验） |
| `sessioncheck.mjs` | 解压 `sessions\**\session.v4.jsonl.zstd`（**多帧拼接**，`zstdDecompressSync` 只能读第一帧，需按 frame magic 分帧）并列出某会话的全部 tool call——用来证明子代理只读了任务包 |

用法（node 路径见 `$env:DSH_*` 所在运行时）：

```powershell
```
