<div align="center">

# 源影插件 · Sourin Plugins

**源影（Sourin）播放器的插件写法示例 —— TypeScript 编写，类型提示完整**

[播放器仓库](https://github.com/sourin-app/sourin) · [插件 API 文档](docs/API.md) · [示例插件](plugins/bilibili.ts)

</div>

---

> ⚠️ **本仓库是一份「怎么写插件」的示例，不是插件集合。**
> 里面只有**一个**示例插件，用来演示完整写法；不收录、不分发其它源。
> 播放器本身**不自带任何内容源** —— 这是刻意的设计，见下。

> **组织**：[sourin-app](https://github.com/sourin-app) —— 本仓库与播放器仓库
> [sourin](https://github.com/sourin-app/sourin) 是配套的两个仓库：
> 播放器只提供播放能力，内容源由使用者自己写。

## 为什么播放器是空壳

源影只提供**播放能力**，不提供**内容**。

视频内容的来源、可用性、合法性都由使用者自行判断与负责。
把源写在程序里，等于替所有使用者做了这个决定 ——
那不是播放器该做的事。

所以：**程序只提供能力，不提供内容**。内容通过插件接入。

## 目录结构

```text
sourin-plugins/
├── src/                 ★ 插件 SDK（TypeScript 类型 + 工具）
│   ├── types.ts             契约：MediaItem / StreamCandidate / Session ...
│   ├── host.d.ts            宿主注入的 host.http / store / config / log / util
│   └── index.ts             definePlugin() / getText() / getJson()
├── plugins/
│   └── bilibili.ts      ★ **唯一的示例**：一份完整、真跑过的插件
├── docs/
│   ├── API.md           完整接口契约（方法签名、返回结构、坑）
│   └── TYPESCRIPT.md    用 TS 写插件：命令、构建、三条硬断言
├── dist/                构建产物（.js）—— **这个才是丢给播放器的文件**
└── README.md
```

## 从哪开始看

按这个顺序，半小时能把插件怎么写搞明白：

1. **[`plugins/bilibili.ts`](plugins/bilibili.ts)** —— 直接看例子。1180 行，
   首页/分类/列表/排行/搜索/详情/取流/登录全都实现了，注释里全是实测结论。
2. **[`src/types.ts`](src/types.ts)** —— 契约的全部数据结构。
   每个字段都写了宿主要求与踩坑记录。
3. **[`docs/API.md`](docs/API.md)** —— 文字版契约，含错误处理与执行模型
   （QuickJS 沙箱里没有什么）。
4. **[`docs/TYPESCRIPT.md`](docs/TYPESCRIPT.md)** —— 怎么构建、为什么必须构建。

## 用 TypeScript 写插件（推荐）

插件源码用 TS，构建成**单个 JS 文件**后装进播放器 —— 插件运行的 QuickJS 环境没有 `import`，
所以必须打包（`build.mjs`，esbuild）。

```bash
pnpm install
pnpm run typecheck     # 类型检查
pnpm run build         # → dist/plugins/bilibili.js
```

拿到类型提示之后，原来最容易出错的三类事情变成**编译期**就能发现：

```ts
// ① 上游字段拼错 —— 声明 interface 后立刻报红，不用等到运行时
const d = await getJson<{ list: { vod_name: string }[] }>(url)
d.list[0].vod_nmae   // ✗ Property 'vod_nmae' does not exist

// ② 契约字段写错 —— 补全列表直接告诉你有哪些
return [{ url, kind: 'hls', quality: '1080P', notWebReady: true }]
//                            ^ 只能是 'hls' | 'dash' | 'mp4' | 'web_embed' | 'audio_only'

// ③ host API 用错 —— 比如把 host.log 当函数调
host.log('x')        // ✗ This expression is not callable
host.log.info('x')   // ✓
```

> 不想用 TS 也完全可以：插件最终就是个 JS 文件，手写 `globalThis.plugin = { ... }` 一样能跑。
> 只是没有上面那些提示。

## 示例插件的关键实现（踩坑记录）

`plugins/bilibili.ts` 里有几处是**反直觉但必须那样写**的，单独拎出来：

### 「必须登录」与「支持登录」是两件事

```js
capabilities: {
  loginRequired: false,      // 绝不能设 true（见下）
  loginSupported: true,      // 可以登录，但游客也能用
  loginHint: '……',            // 登录弹窗里的说明
  loginNeedsUsername: false, // Cookie 导入不需要账号框
}
```

★ **绝不能**为了显示登录入口而设 `loginRequired: true` ——
那会让宿主的 `ensure_session` **挡住游客播放**
（`if !login_required { return Some(true) }` 那条捷径失效），
而「不登录也能看 1080P」正是这个插件的核心能力。

所以宿主那边：
- 设置页显示登录入口 → `loginRequired || loginSupported`
- 会话校验只看 → `loginRequired`（游客路径原样不动）

### 用 DASH 而不是 durl（这是拿到 1080P 的关键）

```text
fnval=1  (durl)               → 恒 720P
                                传 qn=80/116/120 都没用
                                ffprobe 确认 1280x720，format="mp4720"
fnval=16 (DASH) 不带 try_look → 最高 480P
fnval=16 (DASH) + try_look=1  → ★ 15/15 拿到 1920x1080
```

★ 关键就是 **`try_look=1`** —— 它是"试看"参数，
但实测副作用是**放开了清晰度限制**，让游客也能拿 1080P。

⚠️ 网上常见说法是「游客最高 720P」，那是**只测了 durl** 得出的结论。

### 必须挑 avc1，不能挑 hvc1（HEVC）

B 站对每个清晰度**同时提供**两条流，而实测浏览器的 MSE：

```text
isTypeSupported('video/mp4; codecs="avc1.640032"')      → true  ✅
isTypeSupported('video/mp4; codecs="hvc1.1.6.L150.90"') → false ★
```

选了 HEVC 会**黑屏** —— 有声音、有进度，就是没画面。

### 代价：音视频分离

DASH 的视频轨与音频轨是**两个文件**，所以用 `audioUrl` 声明音频轨，
由播放器用 `<video>` + `<audio>` 双元素同步播放。

之所以可行：B 站的 DASH 轨是**单个 fMP4 文件**（不是分片列表，
`moov` 在最前面，偏移 36），`<video>` 能直接流式播 ——
不需要 dash.js 那一整套 MSE。

## 三分钟上手

### 1. 装一个插件

三种方式，任选：

| 方式 | 怎么做 |
|---|---|
| **应用内安装** | 设置 → 内容源 → 安装插件（支持本地文件与 URL）|
| **放文件** | 丢进应用数据目录的 `plugins/`（设置页有「打开目录」按钮）|
| **导入源** | 支持声明式 JSON 配置（不需要写代码）|

### 2. 写你自己的插件

照 `plugins/bilibili.ts` 的结构改。最小骨架长这样：

```ts
import { definePlugin } from '../src/index'
import type { MediaItem, Page } from '../src/index'

/**
 * @id          my-source        ← 唯一标识，改成你的
 * @name        我的源            ← 显示名
 * @version     1.0.0
 * @author      you
 * @description 这个源是干什么的
 */

const API = 'https://你的接口地址'

definePlugin({
  id: 'my-source',

  capabilities: { vod: true, search: true },

  async home() { /* 首页分区 */ },
  async categories() { /* 分类 */ },
  async list(req) { /* 分类内容（分页）*/ },
  async search(keyword, page) { /* 搜索 */ },
  async detail(id) { /* 详情 + 剧集 */ },
  async resolve(id, req) { /* ★ 取流 —— 唯一必须实现的 */ },
})
```

> ⚠️ 头部注释里的 **`@id` 和 `@name` 是必填的** —— 宿主靠它识别插件。
> 对象里的 `id` / `name` 宿主**都不读**（只用于类型提示），所以 `name` 可以省。

**完整契约见 [`docs/API.md`](docs/API.md)** ——
里面有每个方法的参数与返回结构、以及**实测踩过的坑**。

## ★ 三个最容易踩的坑（先看这个，能省几小时）

### 坑 1：`host.http` **不抛异常**

网络失败时它返回一个以 `__ERR__` 开头的**字符串**，而不是 reject。

```js
// ★ 错 —— 报错完全看不出是网络问题
const d = JSON.parse(await host.http.get(url))
// SyntaxError: unexpected token: '__ERR__'
```

```js
// ✅ 对 —— 包一层
async function getJson(url) {
  const text = await host.http.get(url, { headers: HDRS })
  if (text.startsWith('__ERR__')) throw new Error('network: ' + text.slice(7))
  return JSON.parse(text)
}
```

### 坑 2：运行环境是 QuickJS，不是 Node

**没有**：`fetch` / `setTimeout` / `console` / `URL` / `require` / `import`
**也没有 `host.crypto`** —— 需要哈希得自己写纯 JS。

用 `host.http` 发请求、`host.log.info` 打日志。**不能做轮询**（没有 `setTimeout`）。

### 坑 3：`resolve()` 返回的是**数组**

多清晰度/多线路时给多个候选。而且字段名是 `kind` 不是 `format`：

```js
async resolve(id) {
  return [
    {
      url: '...',
      quality: '原画',                    // ★ 显示用的字段
      kind: url.includes('.m3u8') ? 'hls' : 'mp4',   // ★ 如实填
      // headers: { Referer: '...' },     // 需要防盗链时加
    },
  ]
}
```

⚠️ `kind` 填错会让宿主用错解码路径，
表现是「一直转圈但没有任何报错」，极难排查。

⚠️ `kind` **只能是这 5 个值**：`hls` / `dash` / `mp4` / `web_embed` / `audio_only`。
填别的值（比如 `other`）会让**整个 resolve 失败** —— 宿主是整体反序列化的，
一个不认识的值就让所有候选都废掉。认不出格式就填 `mp4`（宿主自己的兜底也是它）。

## 许可

MIT —— 见 [LICENSE](LICENSE)。

示例插件（`plugins/bilibili.ts`）的接口结构与播放器公开文档一致，
可自由参考用于编写你自己的插件。

---

<div align="center">

**本仓库不提供、不托管、不分发任何视频内容。**
使用者需自行确保所接入内容的来源合法。

</div>
