# dsh-brief-pack

**把 30 万字的报告，压成一个 8000-token 的任务包。子代理只读这一个文件，不再去翻原文。**

[![DSH plugin](https://img.shields.io/badge/DSH-plugin-2ea44f)](https://github.com/dcd887/dsh-brief-pack) [![MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

---

## 解决什么问题

你让一个子代理去分析一份 30 万字的报告。它为了找到相关内容，读了一遍全文。

如果派出 5 个子代理，就是读 5 遍。

`brief-pack` 把「读」这件事从子代理手里拿走：**主代理先读一遍，只把命中的片段写成一个任务包；子代理只读这一个文件。**

```
没有 brief-pack：          有了 brief-pack：
子代理 A ──读 30 万字      主代理 ──读一遍──→ brief（8000 token）
子代理 B ──读 30 万字                        ├─→ 子代理 A 只读 brief
子代理 C ──读 30 万字                        ├─→ 子代理 B 只读 brief
...                                          └─→ 子代理 C 只读 brief
```

## 安装

```bash
dsh plugin add github:dcd887/dsh-brief-pack
```

装完重开 DSH（新工具要重开会话才进工具面）。

## 30 秒上手

**第 1 步：打包**

```js
pack_brief({
  task: "找出所有未通过的测试用例",
  files: [{ path: "C:\\reports\\full-run.md", hint: "失败 通过率" }]
})
```

返回（**不含任务包全文**，只给路径和统计）：

```json
{
  "briefPath": "...\\briefs\\summary-20261108-021504.md",
  "bytes": 17506,
  "approxTokens": 3590,
  "budgetTokens": 8000,
  "filesPacked": [{ "bytes": 23282, "matchedTerms": ["失败","通过率"], "segments": 6 }]
}
```

**23 KB 的源文件 → 3,590 token 的任务包。**

**第 2 步：派子代理**

```js
spawn_with_brief({ briefPath: "...\\briefs\\summary-20261108-021504.md" })
```

子代理的 prompt 是固定的：**只读这一个文件 / 不要翻其它文件 / 把完整结果写进报告 / 只回 ≤10 行摘要。**

所以它的中间过程不进入你的上下文。

## 为什么省 token

| | 直接让子代理读原文 | 用 brief-pack |
|---|---|---|
| **主代理** | 不读 | 读一遍 |
| **每个子代理** | 读全文 | **只读 brief（≤8000 token）** |
| **N 个子代理的读取量** | N × 全文 | 全文 + N × 8000 token |
| **子代理的中间过程** | 全进你的上下文 | **不进**（只回 ≤10 行） |

## 两个工具

### `pack_brief`

| 参数 | 必填 | 说明 |
|---|---|---|
| `task` | ✅ | 这一包要支撑的任务，写进标题 |
| `files` | ✅ | `[{ path, hint? }]`，`hint` 为空则只放结构摘要 |
| `budgetTokens` | | 默认 8000（最小 1500）|
| `outDir` | | 默认 `<用户目录>/DSH输出/briefs` |

### `spawn_with_brief`

| 参数 | 必填 | 说明 |
|---|---|---|
| `briefPath` | ✅ | `pack_brief` 返回的路径 |
| `reportPath` | | 子代理写完整结果的位置 |
| `label` | | 子代理显示名 |
| `extra` | | 追加到 prompt 末尾 |
| `timeoutSeconds` | | 默认 600，上限 1800 |

## 已知限制

1. **token 是估算**：汉字 ≈ 1/1.5 token、ASCII ≈ 4 字符/token，与真实 tokenizer 有 ±20% 偏差。返回值里标了 `tokenEstimateNote`。
2. **`spawn_with_brief` 是阻塞调用**：默认最多等 600 秒。
3. **没有 `subagents` 服务时会明确降级**：返回 `degraded: true` + 缺什么，不假装成功。
4. **不做二进制/超长单行处理**：按文本读，`.md` 之外的格式没有专门语法解析。

## 实现

纯 Node，**零外部依赖**（无 Python、无外部进程、无网络）。`index.js` 单文件。

<details>
<summary>给要改代码的人（点开）</summary>

### 生效矩阵

| 改动 | 生效方式 |
|---|---|
| `index.js` | `plugin_manager` `remove_bundle` + `install_bundle` 即生效，**不用重启** |
| `entry.js` / `package.json` / `cordis.patch.yml` / `locale` / `icon.svg` | 需重启 Harness，或换包名 |

### 配置（插件行 config）

| 键 | 默认 | 说明 |
|---|---|---|
| `outDir` | `<用户目录>/DSH输出/briefs` | 默认输出目录 |
| `budgetTokens` | 8000 | 默认预算（最小 1500）|
| `subagentProvider` | `spawn` | `ctx.subagents.start(...)` 用的 provider 名 |
| `timeoutSeconds` | 600 | 等子代理的上限 |

### 自测

```bash
node _selftest/jsoncheck.mjs     # 校验 package.json / locale/*.json 无 BOM 且合法
node _selftest/sessioncheck.mjs  # 解压 session.v4.jsonl.zstd（多帧拼接）
```

</details>

## License

MIT
