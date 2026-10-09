// ═══════════════════════════════════════════════════════════════════════
//  构建 —— TypeScript → 单文件 JS 插件
// ═══════════════════════════════════════════════════════════════════════
//
// 为什么要构建：插件运行在 QuickJS 里，**没有 import / require**，
// 所以 TS 源码必须被打成一个自包含的普通脚本。
//
//   plugins/*.ts  →  dist/plugins/*.js
//
// 用法：
//   pnpm run build            构建一次
//   pnpm run build:watch      改一个文件编一个
//
// ⚠️ 三条硬约束（构建后会**逐条断言**，不满足就报错退出）：
//   ① 产物必须保留头部注释 —— 宿主靠 /** @id xxx */ 识别插件
//   ② 产物里不能出现 import / export（QuickJS 不支持模块语法）
//   ③ 产物不能是空的

import { build, context } from 'esbuild'
import { readdirSync, readFileSync, mkdirSync, existsSync } from 'node:fs'
import { join, basename } from 'node:path'

const ROOT = new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const WATCH = process.argv.includes('--watch')

/** 收集某个目录下的入口（目录不存在就跳过） */
function entriesOf(dir) {
  const abs = join(ROOT, dir)
  if (!existsSync(abs)) return []
  return readdirSync(abs)
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.d.ts'))
    .map((f) => ({ in: join(abs, f), out: join(ROOT, "dist", dir, f.replace(/\.ts$/, ".js")) }))
}

const groups = [entriesOf("plugins")]
const all = groups.flat()
if (all.length === 0) {
  console.error("没有找到任何入口（plugins/*.ts）")
  process.exit(1)
}

/** 构建后断言：产物必须满足上面那三条硬约束 */
function assertOutput(entry) {
  const code = readFileSync(entry.out, "utf8")
  const problems = []
  if (code.trim().length === 0) problems.push("产物是空的")
  if (!code.includes("@id")) problems.push("头部注释丢了（宿主靠 /** @id xxx */ 识别插件）")
  if (/^\s*(import|export)\s/m.test(code)) problems.push("产物里出现了 import / export，QuickJS 不支持")
  return problems
}

/**
 * 取出源文件开头的块注释 —— 那是宿主识别插件的元信息（@id / @name ...）。
 *
 * ⚠️ esbuild 会丢掉普通注释（它只保留 legalComments），
 *    所以头部注释必须**单独捞出来**再用 banner 贴回去。
 *    这是本项目踩过的坑：产物里没有 @id，插件根本装不上。
 */
function headerOf(file) {
  const src = readFileSync(file, "utf8")
  const m = src.match(/^\s*(\/\*\*[\s\S]*?\*\/)/)
  return m ? m[1] + "\n" : ""
}

const options = {
  bundle: true,
  // iife：包成一个立即执行函数，不产生模块语法（QuickJS 能直接 eval）
  format: "iife",
  // neutral：不假设 node / browser 的全局对象 —— 这个环境两者都不是
  platform: "neutral",
  target: "es2020",
  // 中文注释与字符串原样保留，不做转义
  charset: "utf8",
  // 不压缩：插件是要给人读的，压缩后报错行号全无意义
  minify: false,
  // 保留注释（头部 @id 就是注释）
  legalComments: "inline",
  logLevel: "info",
}

async function runOnce() {
  for (const entry of all) {
    mkdirSync(join(entry.out, ".."), { recursive: true })
    await build({
      ...options,
      entryPoints: [entry.in],
      outfile: entry.out,
      banner: { js: headerOf(entry.in) },
    })
    const problems = assertOutput(entry)
    const rel = entry.out.slice(ROOT.length)
    if (problems.length) {
      console.error("✗ " + rel + " —— " + problems.join("；"))
      process.exitCode = 1
    } else {
      console.log("✓ " + rel)
    }
  }
}

if (WATCH) {
  const ctxs = await Promise.all(
    all.map((entry) => {
      mkdirSync(join(entry.out, ".."), { recursive: true })
      return context({
        ...options,
        entryPoints: [entry.in],
        outfile: entry.out,
        banner: { js: headerOf(entry.in) },
      }).then((c) => c.watch())
    }),
  )
  console.log("监听中……（Ctrl+C 退出）")
  process.on("SIGINT", async () => {
    await Promise.all(ctxs.map((c) => c.dispose()))
    process.exit(0)
  })
} else {
  await runOnce()
}
