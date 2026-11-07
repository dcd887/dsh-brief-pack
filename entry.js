/**
 * Host entry point of the 任务包打包器 bundle (`exports["."]`).
 *
 * Thin, deliberately stable shim — the same pattern proven by
 * `dsh-plugin-work/project-dashboard`: the Harness Host pins the module
 * resolution and namespace of the entry file for the process lifetime, so code
 * living directly here could not be replaced by editing or reinstalling. This
 * file therefore exports the stable module face (`name`, `inject`, `Config`)
 * the loader reads at activation, and pulls the real implementation from
 * `impl.js` through a dynamic import whose URL carries impl.js's mtime — so
 * editing impl.js + reinstalling the bundle changes behaviour without a
 * process restart or a package rename.
 *
 * cordis awaits a promise returned from `apply`, so returning the
 * implementation's disposer from an async `apply` keeps effect ownership
 * identical to a synchronous plugin.
 *
 * Config is a real Schemastery instance, exactly like the shipped `dsh-ears`
 * Host plugin (`dsh-ears/lib/index.js`: `import s from
 * "@deepseek-ai/schemastery"`). A bare JSON Schema object makes activation
 * fail with "Cannot read properties of undefined (reading 'validate')", and a
 * hand-written `~standard` object loads but leaves `Config.listConfigs` at
 * `status: "unsupported"`, so the Settings page renders no fields — that status
 * requires `Symbol.for('schemastery') === true` plus a string `type` and an
 * object `meta` (`isNativeConfigSchema` in dsh).
 *
 * The defaults mirror `impl.js`'s own `normalizeConfig`, which stays the
 * operative guard, so `config: {}` behaves exactly as before.
 */
import { statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import s from '@deepseek-ai/schemastery'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const IMPL_FILE = path.join(HERE, 'impl.js')

export const name = 'brief-pack'
export const inject = ['tools']

export const Config = s.object({
  outDir: s.string().default('')
    .description('任务包输出目录；留空用插件的出厂目录'),
  budgetTokens: s.number().default(8000)
    .description('任务包 token 上限（最小 1500）'),
  subagentProvider: s.string().default('spawn')
    .description('派子代理用的 provider 名'),
  timeoutSeconds: s.number().default(600)
    .description('等待子代理完成的上限秒数（最小 30）'),
}).description('任务包打包器配置')

let cached = null

function loadImplementation() {
  const revision = String(statSync(IMPL_FILE).mtimeMs)
  if (cached !== null && cached.revision === revision) return cached.promise
  const url = pathToFileURL(IMPL_FILE).href + '?rev=' + revision
  const promise = import(url).catch((error) => {
    cached = null
    throw error
  })
  cached = { revision, promise }
  return promise
}

export async function apply(ctx, config) {
  const implementation = await loadImplementation()
  return implementation.apply(ctx, config)
}
