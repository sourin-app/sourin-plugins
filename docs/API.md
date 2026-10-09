# 插件 API 契约

> **这份文档是照着代码写的，不是设计稿。**
> 每条都核对过 `src-tauri/src/plugins/mod.rs` 的实现。
>
> ⚠️ 早期有一份 `research/插件API契约设计.md`（v1 草案），
> 里面写了 `host.crypto` 和 `host.util` —— **那两个在实现里根本不存在**。
> 本文档以实际实现为准。
>
> ★ **现在有机器可读的版本了**：`src/types.ts` 与 `src/host.d.ts` 把下面每条契约
> 都写成了 TypeScript 类型（同样是照着实现核的）。用 TS 写插件时，
> 这些约束会在编辑器里直接提示，不用回来翻文档 —— 见 [`TYPESCRIPT.md`](TYPESCRIPT.md)。

## 目录

- [一、插件文件形态](#一插件文件形态)
- [二、宿主注入的 API](#二宿主注入的-api)
- [三、插件必须导出的对象](#三插件必须导出的对象)
- [四、方法契约](#四方法契约)
- [五、数据结构](#五数据结构)
- [六、错误处理](#六错误处理)
- [七、执行模型](#七执行模型)
- [八、实测踩过的坑](#八实测踩过的坑)

---

## 一、插件文件形态

一个 `.js` 文件，**没有构建步骤、没有 npm、没有 import**。

```js
/**
 * @id          my-source
 * @name        我的源
 * @version     1.0.0
 * @author      you
 * @description 一句话说明这个源是什么
 * @homepage    https://example.com
 */

globalThis.plugin = { /* ... */ }
```

### 头部注释字段

| 字段 | 必填 | 说明 |
|---|---|---|
| `@id` | **是** | 唯一标识。**只能用小写字母、数字、`-`、`_`** |
| `@name` | **是** | 界面上显示的名字 |
| `@version` | 否 | 版本号（建议写，便于排查）|
| `@author` | 否 | 作者 |
| `@description` | 否 | 一句话描述 |
| `@homepage` | 否 | 主页/仓库地址 |

⚠️ `@id` 缺了会直接被拒：

```text
这不是合法插件（缺少 @id 头部注释）
```

---

## 二、宿主注入的 API

宿主往全局注入一个 `host` 对象。**不用 import，直接用。**

```text
host.http     网络请求
host.store    插件私有存储
host.config   读用户配置
host.log      日志
```

**只有这四个。** 没有 `host.crypto`，没有 `host.util`。

### 2.1 `host.http`

```ts
host.http.get(url: string, options?: { headers?: Record<string, string> }): Promise<string>
host.http.post(url: string, body?: string, options?: { headers?: Record<string, string> }): Promise<string>
```

| 参数 | 说明 |
|---|---|
| `url` | 完整 URL |
| `options.headers` | 请求头对象（**可选**，但很多站点必须要 Referer）|
| 返回 | **响应正文文本**（不是对象！要自己 `JSON.parse`）|

#### ★★★ 它**不抛异常**

网络失败时返回一个以 `__ERR__` 开头的**字符串**：

```js
// ★ 错 —— 报错完全看不出是网络问题
const d = JSON.parse(await host.http.get(url))
// SyntaxError: unexpected token: '__ERR__'
```

```js
// ✅ 对 —— 必须包一层
async function getJson(url) {
  const text = await host.http.get(url, { headers: HDRS })
  if (text.startsWith('__ERR__')) {
    throw new Error('network: ' + text.slice(7))
  }
  return JSON.parse(text)
}
```

**为什么要带 `network:` 前缀**：宿主据此把错误归类成
`ErrorKind::Network`，界面上就会显示「网络问题」而不是「解析失败」。
不带前缀的话，用户看到的是"数据格式错误"，会往错的方向查。

#### ★★ `headers` 少传 = 静默拿到错误页

很多站点（尤其国内视频站）**必须**带 `Referer`，
否则**不报错**，而是返回一个「请从正确入口访问」的 HTML 页面。

表现：请求成功、`JSON.parse` 失败或字段全是空的。

⚠️ 宿主内部曾经有过一个 bug：**把第二个参数整个丢掉**，
于是插件的 `Referer` 从来没发出去过。这种 bug 不报错、
只是偶尔拿到错误页，极难查。所以拿不到数据时**先怀疑 Referer**。

#### 超时与默认头

- 超时 **15 秒**（`HTTP_TIMEOUT_SECS`）
- 默认 `User-Agent` 是 Chrome 143
- 站点代理（如果用户在设置里配了）**会自动生效**，插件不用管

### 2.2 `host.store`

插件私有存储，按插件 id 隔离（落盘在 `plugins/.data/<id>.json`）。

```ts
host.store.get(key: string): string | null      // 同步
host.store.set(key: string, value: string): void // 同步
host.store.remove(key: string): void             // 同步
```

⚠️ **只能存字符串**。存对象要先 `JSON.stringify`。

**用途**：存 token、cookie、缓存。

**⚠️ 绝不要存的东西**：播放地址（`resolve()` 的结果）。
很多源的地址带**时效签名**，缓存了下次拿到的是失效地址，
表现为"昨天能看今天不能看"，而且极难排查。

### 2.3 `host.config`

读用户在界面上填的配置（插件在 manifest 里声明 `config` 字段，
宿主会自动生成设置界面）。

```ts
host.config.get(key: string): string          // 同步，返回 **JSON 文本**
host.config.getBool(key: string, def: boolean): boolean
host.config.getNumber(key: string, def: number): number
host.config.getString(key: string, def: string): string
host.config.all(): string                     // JSON 文本
```

**全部是同步的**（不是 Promise）。

⚠️ **`get()` 返回的是 JSON 文本，不是值** ——
因为配置值类型不定（bool / number / string），
宿主统一转成 JSON 字符串。所以：

```js
// ★ 错 —— 拿到的是字符串 "true"，不是布尔 true
if (host.config.get('useProxy')) { /* 永远是 true，连 "false" 也是真值 */ }

// ✅ 对 —— 用便捷方法
if (host.config.getBool('useProxy', false)) { /* ... */ }

// ✅ 或者自己解析
const v = JSON.parse(host.config.get('useProxy'))
```

⚠️ 这个坑很隐蔽：`"false"` 在 JS 里是**真值**，
所以 `if (host.config.get('开关'))` 永远为真。

### 2.4 `host.log`

```ts
host.log.debug(msg: string): void
host.log.info(msg: string): void
host.log.warn(msg: string): void
host.log.error(msg: string): void
```

日志会自动带上插件 id 前缀：`[plugin:my-source] ...`

⚠️ 环境里**没有 `console`** —— 想打日志必须用 `host.log`。

---

## 三、插件必须导出的对象

```js
globalThis.plugin = {
  id: 'my-source',        // 建议与 @id 一致
  // name 可省 —— 宿主显示名取自头部注释的 @name，不读这里
  version: '1.0.0',
  author: 'you',
  description: '...',

  capabilities: {
    vod: true,            // 点播
    search: true,         // 搜索
    // live: true,        // 直播
    // loginRequired: true,   // 必须登录才能取流（游客完全用不了）
    // loginSupported: true,  // ★ 可以登录，但游客也能用（见下）
    // loginHint: '说明文字',
    // loginNeedsUsername: false,
  },

  // 方法（用不到的不用写）
  async home() {},
  async categories() {},
  async list(req) {},
  async search(keyword, page) {},
  async detail(id) {},
  async resolve(id) {},   // ★ 唯一必须实现的
}
```

> ⚠️ 对象上的 `id` / `name` 宿主**都不读** —— 元信息一律由头部注释解析（`parse_meta`）。
> 写在这里只是给人和工具看的。**`@id` 和 `@name` 才是必填的。**

### 能力声明

⚠️ **只声明你真正实现了的。**

声明了却没实现 → 界面上会出现一个「永远空白」的区块，
用户会以为是软件坏了。

| 能力 | 含义 | 需要实现 |
|---|---|---|
| `vod` | 点播 | `home` / `list` / `detail` / `resolve` |
| `search` | 搜索 | `search` |
| `live` | 直播 | `liveChannels` / `liveStream` |
| `loginRequired` | **必须**登录才能用 | `login` / `session` |
| `loginSupported` | 可以登录，游客也能用 | `login` / `session` |

#### ★★★ `loginRequired` 与 `loginSupported` 的区别（很重要）

```text
loginRequired: true     游客完全用不了 —— 宿主的 ensure_session 会拦住
loginSupported: true    游客照常，登录是**可选增强**
```

⚠️ **如果你的源游客也能用，就必须用 `loginSupported` 而不是
`loginRequired`** —— 后者会让没登录的用户**彻底无法使用这个源**。

典型场景：某站不登录能看 1080P，登录后能同步收藏 ——
那就该用 `loginSupported`。

**配套的两个可选字段**：

| 字段 | 默认 | 用途 |
|---|---|---|
| `loginHint` | 无 | 显示在登录弹窗里的说明（告诉用户怎么操作）|
| `loginNeedsUsername` | `true` | 登录是否需要「账号」字段 |

`loginNeedsUsername: false` 的典型用途：**Cookie 导入**式的登录 ——
用户只粘贴一段 Cookie，没有账号可填。

#### ⚠️ `login()` 的参数是**两个位置参数**，不是对象

```js
async function login(username, password) { ... }
```

**不是** `login(credentials)`。

实测踩过：写成 `async function login(cred)` 然后读 `cred.password` ——
`cred` 其实是字符串，读属性得到 `undefined`，
表现是**永远报「没有收到凭据」**，而前端的值其实是传过来了。

（若你的源只需要一个字段，把 `loginNeedsUsername` 设成 `false`，
用户输入会落在**第二个参数**里。）

#### 登录方法的契约

| 方法 | 返回 | 说明 |
|---|---|---|
| `login(username, password)` | `Session` 或抛错 | 校验凭据；失败要**抛错**，不能返回空 |
| `logout()` | 无 | 清掉本地凭据 |
| `session()` | `Session` 或 `null` | 当前会话（可只读本地缓存，别每次都发请求）|
| `refreshSession()` | `Session` 或 `null` | ★ **真的发请求校验**；失效时返回 `null` 并清掉本地凭据 |
| `sessionNeedsRefresh()` | `boolean` | 是否需要续期（Cookie 类返回 `false`）|

⚠️ `refreshSession()` 里**校验失败必须清掉本地凭据**，
否则设置页会一直显示「已登录」而每次请求都失败 ——
用户看到的是一个**骗人的状态**。

---

## 四、方法契约

### 4.1 `home()` → Section[]

首页分区。**只返回区块声明，不含内容** ——
宿主会按 `source.categoryId` 再去调 `list()` 懒加载。

这样设计是为了让首页首屏**不用等所有区块都拉完**。

```js
async home() {
  const data = await getJson(`${API}/home`)
  return data.sections.map((s) => ({
    id: `demo-${s.id}`,
    title: s.title,
    source: { type: 'category', categoryId: String(s.id) },
  }))
}
```

### 4.2 `categories()` → Category[]

浏览页左侧的分类树。

```js
async categories() {
  const data = await getJson(`${API}/categories`)
  return data.list.map((c) => ({ id: String(c.id), name: c.name, children: [] }))
}
```

### 4.3 `list(req)` → { items, page, total }

```ts
list(req: { categoryId?: string, page?: number })
  → { items: MediaItem[], page: number, total: number }
```

```js
async list(req) {
  const page = req.page || 1
  const d = await getJson(`${API}/list?cat=${encodeURIComponent(req.categoryId)}&page=${page}`)
  return {
    items: d.list.map((x) => ({
      id: String(x.id),        // ★ 插件内部的 id，宿主会自动加前缀
      title: x.name,
      cover: x.pic,
      subtitle: x.remarks,     // 卡片副标题（"更新至第 12 集"）
      kind: 'movie',           // 'movie' | 'series'
    })),
    page,
    total: d.total,            // ★ 不是 hasMore
  }
}
```

⚠️ **`id` 不要自己拼前缀** —— 宿主会自动加 `demo:`，
自己拼了会变成 `demo:demo:123`。

### 4.4 `search(keyword, page)` → { items, page, total }

结构同 `list()`。

```js
async search(keyword, page) {
  const p = page || 1
  const d = await getJson(`${API}/search?wd=${encodeURIComponent(keyword)}&page=${p}`)
  return {
    items: d.list.map((x) => ({ id: String(x.id), title: x.name, cover: x.pic })),
    page: p,
    total: d.total,
  }
}
```

### 4.5 `detail(id)` → MediaDetail

```js
async detail(id) {
  const d = await getJson(`${API}/detail?id=${encodeURIComponent(id)}`)
  return {
    id,
    title: d.name,
    cover: d.pic,
    description: d.content,
    kind: 'series',
    sources: (d.playFrom || []).map((s) => ({   // 线路
      code: s.code,
      title: s.name,
      count: (s.episodes || []).length,
    })),
    episodes: (d.playFrom?.[0]?.episodes || []).map((e, i) => ({
      id: String(e.id),       // ★ 必须字符串
      title: e.name,
      order: i + 1,           // ★ 决定排序，不是数组下标
    })),
  }
}
```

三个容易搞错的地方：

1. **`sources`（线路）与 `episodes`（剧集）是分开的** ——
   多线路站点每条线路的剧集列表可能不一样，这里只取第一条
2. **`episodes[].id` 必须是字符串**，且会被**原样**传给 `resolve()`。
   需要"从哪条线路、哪一集取流"就把信息**编码进这个 id**
   （如 `${vodId}@${line}@${index}`），在 `resolve()` 里拆开
3. **`order` 决定排序** —— 有些站点返回顺序是乱的，显式给最稳

### 4.6 `resolve(id)` → PlayCandidate[] ★ 唯一必须实现

```js
async resolve(id) {
  const d = await getJson(`${API}/play?id=${encodeURIComponent(id)}`)
  return [
    {
      url: d.url,
      quality: d.quality || '原画',                   // ★ 显示用的字段
      kind: d.url.includes('.m3u8') ? 'hls' : 'mp4',  // ★ 如实填
      // headers: { Referer: 'https://example.com/' }, // 需要防盗链时加
      // drmProtected: false,                          // 受保护的内容标 true
    },
  ]
}
```

⚠️ **返回的是数组**（多清晰度/多线路给多个候选），不是单个对象。

⚠️ 字段名是 **`kind`** 不是 `format`。

⚠️ `kind` **填错会让宿主用错解码路径**，
表现是「一直转圈但没有任何报错」，极难排查。

⚠️ **绝不要把结果缓存**（理由见 `host.store` 一节）。

---

## 五、数据结构

### MediaItem（列表项）

```ts
{
  id: string          // 插件内部 id（宿主自动加前缀）
  title: string
  cover?: string
  subtitle?: string   // 卡片副标题
  kind?: string       // 'movie' | 'series'
}
```

### Episode（剧集）

```ts
{
  id: string          // 原样传给 resolve()
  title: string
  order?: number      // 排序用
}
```

### PlayCandidate（播放候选）

```ts
{
  url: string
  quality?: string       // 显示用（"原画" / "1080P"）
  kind?: string          // 'hls' | 'mp4'
  // 两种形态都合法（宿主都认）：对象 { Referer: "..." } 或数组 [["Referer", "..."]]
  headers?: Record<string, string> | [string, string][]
  drmProtected?: boolean
}
```

---

## 六、错误处理

抛异常即可。宿主会**把 message 转成小写后做子串匹配**，
据此归类成不同的错误类型：

| message 里含 | 归类 | 界面显示 |
|---|---|---|
| `unauthorized` 或 `401` | 需要登录 | 「需要登录或登录已失效」|
| `not_found` 或 `404` | 找不到 | 原消息 |
| `unsupported` | 不支持 | 原消息 |
| `network` 或 `timeout` | 网络问题 | 原消息 |
| 其它 | 其它 | `插件报错: <原消息>` |

⚠️ **是子串匹配、不是前缀匹配**，所以：

```js
throw new Error('network: 连接超时')      // → 网络问题 ✅
throw new Error('请求超时 timeout')       // → 网络问题 ✅（含 timeout）
throw new Error('该内容需要 VIP')          // → 其它（会显示「插件报错: ...」）
```

**推荐写法**（用前缀，一眼能看出归类）：

```js
throw new Error('network: 连接超时')
throw new Error('unauthorized: 登录已失效')
throw new Error('not_found: 该内容已下架')
throw new Error('unsupported: 不支持这类内容')
```

⚠️ **没有 `parse:` 这个归类** —— 写 `parse:` 会落到「其它」，
界面显示成「插件报错: parse: xxx」。

⚠️ **不要吞掉异常**。吞了会让界面一直转圈，
而真正的原因完全看不见。

---

## 七、执行模型

### 每次调用新建 Runtime

宿主**每次调用插件方法都会新建一个 QuickJS Runtime**，
执行完就销毁。

实测代价可忽略（毫秒级），换来的是：

- 插件之间**完全隔离**（改不到别人的全局变量）
- 插件崩了不会污染下一次调用
- 不用管状态清理

**副作用**：插件**不能**用模块级变量做缓存 —— 每次调用都是新的。

```js
// ★ 无效 —— 下次调用时 cached 又变成 undefined
let cached = null
async function getToken() {
  if (cached) return cached
  cached = await fetchToken()
  return cached
}
```

要持久化就用 **`host.store`**。

### 超时

单次调用 **15 秒**超时（`HTTP_TIMEOUT_SECS`）。

### 熔断

连续失败会被熔断，界面上标记为不可用。成功一次即恢复。

---

## 八、实测踩过的坑

按"踩到时的迷惑程度"排序。

### 1. `__ERR__` 不是合法 JSON

```text
SyntaxError: unexpected token: '__ERR__'
```

看不出是网络问题。**用 `getJson()` 包一层。**

### 2. 没有 `setTimeout`

写重试逻辑时才发现。**环境里没有定时器**，
所以**不能做轮询、不能做退避重试**。

需要重试就在一次调用里用 `for` 循环 + `await`。

### 3. 没有 `console`

`console.log` 会抛 `console is not defined`。
**用 `host.log.info()`。**

### 4. 没有 `URL` / `TextEncoder` / `Buffer`

要解析 URL 参数就自己 `split`，要 base64 就自己实现。

### 5. 没有 `host.crypto`

需要 MD5/SHA 得自己写纯 JS 实现，或者避开需要签名的接口。

### 6. `resolve()` 返回数组不是对象

写错的话宿主会报
`resolve() 返回格式不符`，但错误信息里不会告诉你"应该是数组"。

### 7. 播放地址缓存后失效

很多源用**时效签名**。缓存 = 下次拿到失效地址。
**每次播放都重新 `resolve()`。**

### 8. `Referer` 缺了会拿到 HTML 错误页

不报错、只是字段全是空的。**先怀疑 Referer。**

### 9. 剧集 id 前缀问题

`detail()` 返回的 `episodes[].id` 会被加上 `{provider}:` 前缀
（避免跨源撞 id），但宿主传给 `resolve()` 前会**剥掉**。

⚠️ 如果你的 id 里**自己**带了 `:`，要小心这个剥离逻辑。
建议 id 里只用 `@` / `-` / `_` 做分隔符。

---

## 附：完整示例

见 [`plugins/bilibili.ts`](../plugins/bilibili.ts) ——
那份文件**是真实在用的插件**（不是伪代码），把本文档的每个方法都实现了一遍。

装进播放器的是**构建产物**：`pnpm run build` → `dist/plugins/bilibili.js`。
