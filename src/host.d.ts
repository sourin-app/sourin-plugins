// ═══════════════════════════════════════════════════════════════════════
//  宿主注入的 API —— 全局 `host`
// ═══════════════════════════════════════════════════════════════════════
//
// 这些对象由播放器在插件运行前注入到 QuickJS 全局作用域，
// **不需要 import / require**，直接写 `host.xxx` 即可。
//
// ⚠️ 这份类型是**照着宿主实现逐条核出来的**，不是设计稿：
//    rust/sourin_core/src/plugins/mod.rs —— 注入点是那个 `globalThis.host = {...}`
//    每次核对都写明了对应的 Rust 行为，改宿主时请一并改这里。
//
// ───────────────────────────────────────────────────────────────────────
//  运行环境是 QuickJS，不是 Node、也不是浏览器
// ───────────────────────────────────────────────────────────────────────
//
// 有：  `Promise` / `JSON` / `Math` / `Date` / `RegExp` / 基本类型 / `encodeURIComponent`
// 没有：fetch / XMLHttpRequest / console / URL / TextEncoder / Buffer /
//       require / import / process / localStorage / atob / btoa
//
// ⚠️ `setTimeout` / `setInterval` **本身没有**，但 `host.util.sleep(ms)` 是
//    宿主提供的替代（内部就是 `new Promise(r => setTimeout(r, ms))`，见下面）。
//    轮询式接口请用 `await host.util.sleep(ms)` 循环。

/** GET / POST 的选项。**只有 headers 一项**（没有 body / method / timeout）。 */
export interface HttpOptions {
  /** 请求头。**很多站点必须带 `Referer`**，缺了会返回一个「请从正确入口访问」的 HTML 页，而不是报错。 */
  headers?: Record<string, string>;
}

/**
 * `host.http.raw` 的返回 —— **JSON 文本**，要自己 `JSON.parse`。
 *
 * 之所以给文本而不是对象：跨 QuickJS 边界传对象不如传字符串稳，
 * 与 `host.config.get` 是同一种做法。
 */
export interface RawResponse {
  /** HTTP 状态码。 */
  status: number;
  /** 响应正文。 */
  body: string;
  /**
   * 所有 `Set-Cookie` 响应头，**逐条**放在数组里。
   *
   * ⚠️ 为什么不是拼成一个字符串：Cookie 的 `Expires` 属性里含逗号，
   *    拼接后按逗号切分会产生歧义。
   */
  setCookie: string[];
}

export interface HttpApi {
  /**
   * 发一个 GET，返回**响应正文文本**。
   *
   * ⚠️⚠️ **它不抛异常**。网络失败时返回一个以 `__ERR__` 开头的字符串，
   * 直接 `JSON.parse` 会得到「unexpected token: '__ERR__'」这种
   * 完全看不出是网络问题的报错。请用 `@sourin/plugin` 里的 `getText` / `getJson` 包一层。
   *
   * 超时 15 秒；默认 `User-Agent` 是 Chrome 143；
   * 用户若在设置里配了站点代理，会**自动生效**（插件不用管）。
   */
  get(url: string, options?: HttpOptions): Promise<string>;
  /**
   * 发一个 POST，返回**响应正文文本**。
   *
   * `body` 传字符串就原样发；传对象会被宿主 `JSON.stringify`。
   * 与 `get` 一样：**不抛异常**，失败返回 `__ERR__...`。
   */
  post(url: string, body?: string | unknown, options?: HttpOptions): Promise<string>;
  /**
   * 带**响应头**的请求 —— 返回 **JSON 文本**，要自己 `JSON.parse`。
   *
   * 唯一能拿到 `Set-Cookie` 的接口，所以扫码登录这类
   * 「凭据在响应头里下发」的场景只能用它。
   *
   * ```ts
   * const r = JSON.parse(await host.http.raw('GET', url, { headers })) as RawResponse
   * const sessdata = r.setCookie.find(c => c.startsWith('SESSDATA='))
   * ```
   */
  raw(method: string, url: string, options?: HttpOptions): Promise<string>;
}

/** 插件私有存储（按插件 id 隔离，落盘在 `plugins/.data/<id>.json`）。**全部同步**。 */
export interface StoreApi {
  /** 读一个键；不存在返回 `null`。 */
  get(key: string): string | null;
  /** 写一个键。⚠️ **只能存字符串**，对象要先 `JSON.stringify`。 */
  set(key: string, value: string): void;
  /** 删一个键。 */
  remove(key: string): void;
}

export interface ConfigApi {
  /**
   * 读配置，返回 **JSON 文本**（不是值！），没配过返回 `'null'`。
   *
   * ⚠️ ``get('开关')`` 拿到的是字符串 `"false"` —— 在 JS 里是**真值**，
   *    所以 `if (host.config.get('开关'))` 永远成立。要用 `getBool` 或自己 `JSON.parse`。
   */
  get(key: string): string;
  /** 读布尔，缺省时用 `def`。**优先用这个**，别用 `get`。 */
  getBool(key: string, def: boolean): boolean;
  /** 读数字，缺省时用 `def`。 */
  getNumber(key: string, def: number): number;
  /** 读字符串，缺省时用 `def`。 */
  getString(key: string, def: string): string;
  /** 一次读全部配置，返回 **JSON 文本**（对象）。 */
  all(): string;
}

/** 日志。会自动加上 `[plugin:<插件id>]` 前缀。 */
export interface LogApi {
  debug(msg: string): void;
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

/** 小工具。 */
export interface UtilApi {
  /** `encodeURIComponent(String(s))` */
  urlEncode(s: unknown): string;
  /** `decodeURIComponent(String(s))` */
  urlDecode(s: unknown): string;
  /** 等待若干毫秒（`await` 它）。替代环境里没有的 `setTimeout`。 */
  sleep(ms: number): Promise<void>;
}

/** 宿主注入的全部 API。 */
export interface Host {
  http: HttpApi;
  store: StoreApi;
  config: ConfigApi;
  log: LogApi;
  util: UtilApi;
}

declare global {
  /**
   * 宿主注入的 API（不用 import）。
   *
   * ⚠️ 只声明在 `globalThis` 上，**不要**在插件里再写一遍
   *    `const host = ...`，那会把宿主的实现遮掉。
   */
  const host: Host;
}
