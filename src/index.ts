// ═══════════════════════════════════════════════════════════════════════
//  源影插件 SDK —— 类型 + 两个必需的小工具
// ═══════════════════════════════════════════════════════════════════════
//
// 插件用 TypeScript 写，构建时会被打成一个**普通的 JS 文件** ——
// 插件运行在 QuickJS 里，没有 import / require，所以最终产物必须是
// **单文件、无模块语法**的脚本（见 build.mjs）。
//
// 用法：
//
//   import { definePlugin, getJson } from "../src/index"
//
//   definePlugin({
//     id: "my-source",
//     name: "我的源",
//     capabilities: { vod: true, search: true },
//     async list(req) { ... },
//     async resolve(id, req) { ... },
//   })

import type { Plugin } from './types'

export * from './types'
export type { Host, HttpOptions, RawResponse, HttpApi, StoreApi, ConfigApi, LogApi, UtilApi } from './host'

/**
 * 定义一个插件。
 *
 * 这个函数只做两件事：**给类型提示** + 把对象挂到 globalThis.plugin。
 * 它没有别的魔法 —— 直接写 globalThis.plugin = { ... } 也是合法的，
 * 但那样每个方法都要自己标参数类型。
 *
 *   definePlugin({
 *     id: "demo",
 *     name: "示例源",
 *     capabilities: { vod: true, search: true },
 *     async home() {
 *       const d = await getJson<{ sections: { id: number; title: string }[] }>(API + "/home")
 *       return d.sections.map(s => ({
 *         id: "demo-" + s.id,
 *         title: s.title,
 *         source: { type: "category", categoryId: String(s.id) },
 *       }))
 *     },
 *     async resolve(id, req) {
 *       return [{ url: "https://...", kind: "hls", quality: "原画" }]
 *     },
 *   })
 */
export function definePlugin(plugin: Plugin): Plugin {
  // QuickJS 的全局对象：宿主就是从这里读 plugin
  ;(globalThis as { plugin?: Plugin }).plugin = plugin
  return plugin
}

/**
 * 发 GET 拿**正文文本**；网络失败时**抛错**。
 *
 * host.http 有个反直觉的设计：它**不抛异常**，失败时返回一个以
 * __ERR__ 开头的字符串。直接 JSON.parse 会得到
 * 「unexpected token: '__ERR__'」—— 完全看不出是网络问题。
 * 这个函数把那层封装掉。
 *
 * 抛出的 message 带 network: 前缀 —— 宿主据此把错误归类成「网络问题」，
 * 不带前缀的话用户看到的是「数据格式错误」，会往错的方向查。
 */
export async function getText(url: string, headers?: Record<string, string>): Promise<string> {
  const text = await host.http.get(url, headers ? { headers } : undefined)
  if (text.startsWith('__ERR__')) {
    throw new Error('network: ' + text.slice(7))
  }
  return text
}

/**
 * 发 GET 并解析 JSON（内部走 getText，所以同样会抛错）。
 *
 *   const d = await getJson<{ list: Row[] }>(url, { Referer: "https://example.com/" })
 *
 * ⚠️ 很多站点**必须带 Referer**，否则不报错、而是返回一个
 *    「请从正确入口访问」的 HTML 页 —— 表现是「请求成功但字段全是空的」。
 *    拿不到数据时**先怀疑 Referer**。
 */
export async function getJson<T = unknown>(
  url: string,
  headers?: Record<string, string>,
): Promise<T> {
  const text = await getText(url, headers)
  try {
    return JSON.parse(text) as T
  } catch {
    // 带上响应开头，方便判断是「返回了 HTML 登录页」还是「真的不是 JSON」
    throw new Error('parse: 返回不是合法 JSON — ' + text.slice(0, 120))
  }
}
