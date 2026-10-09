/**
 * @id          bilibili
 * @name        哔哩哔哩
 * @version     1.0.0
 * @author      dsh
 * @description 哔哩哔哩 —— 热门、排行榜、搜索、分区浏览（游客态，无需登录）
 * @homepage    https://www.bilibili.com
 *
 * ───────────────────────────────────────────────────────────────
 * 全部接口都是 **游客态实测**（未登录、无 Cookie），结论如下：
 *
 *  · **不需要 wbi 签名**。反直觉但可复现：把路径换成带 `/wbi/` 前缀的
 *    `/x/web-interface/wbi/search/type`，**不带任何签名参数**就能正常返回；
 *    而没有 `/wbi/` 前缀的老路径已被风控（100% 返回 HTML 412）。
 *    所以本插件**不实现 wbi 算法**。
 *
 *  · ★★★ **游客可以看 1080P**（2026-09-19 修正，之前这里写错了）
 *
 *    旧结论是「游客最高 720p，1080p 需要登录」—— **错的**。
 *    错因：当时只比较了 `fnval=1`(durl) 与「**不带 try_look 的** DASH」，
 *    于是得出「durl 更好」的结论。
 *
 *    实测 15 个热门视频：
 *    ```text
 *    fnval=1  (durl)               → 恒 720P（传 qn=80/116/120 都一样）
 *    fnval=16 (DASH) 不带 try_look → 最高 480P
 *    fnval=16 (DASH) + try_look=1  → ★ 15/15 拿到 1920x1080
 *    ```
 *    `try_look=1` 是"试看"参数，但实测副作用是**放开清晰度限制**。
 *
 *    代价：DASH 音视频**分离**（两个文件），所以返回时用 `audioUrl`
 *    声明音频轨，播放器用 video + audio 双元素同步播。
 *
 *  · **CDN 强制校验 Referer**（这个是真的严格，实测 6 种组合）：
 *      仅 UA（无 Referer）        → HTTP 403
 *      无任何 header              → HTTP 403
 *      Referer: https://example.com → HTTP 403
 *      仅 Referer（无 UA）        → HTTP 206 ✅
 *    所以取流必须声明 `notWebReady: true` + `headers.Referer`，
 *    由宿主用本地代理转发（`<video>` 自己加不了请求头）。
 *
 *  · **必须挑 avc1，不能挑 hvc1（HEVC）**：
 *    B 站每个清晰度都同时给 avc1 与 hvc1 两条，而实测浏览器的
 *    MSE `isTypeSupported('video/mp4; codecs="hvc1.1.6.L150.90"')`
 *    返回 **false** —— 选了 HEVC 会**黑屏**（有声音有进度，就是没画面）。
 *
 *  · **VIP 集不报错，静默降级**：番剧会员集返回 `isPreview: 1`
 *    和一段试看。必须校验并如实告知，否则用户以为拿到了完整剧集。
 * ───────────────────────────────────────────────────────────────
 */

import { definePlugin } from '../src/index'
import type { MediaItem, Page, Section, Session, StreamCandidate } from '../src/types'

/** 所有 JSON 接口共用（实测不需要 UA/Referer，但带上更稳） */
const HDRS = {
  Referer: 'https://www.bilibili.com',
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
}

/**
 * ★★ 取流请求头 —— B 站 CDN 的防盗链比想象中严格
 *
 * # 实测（2026-09-17，同一个 URL 反复试）
 *
 * ```text
 * 仅 Referer                       → HTTP 403
 * 仅 Referer + 强制 HTTP/1.1       → HTTP 403
 * Referer + User-Agent + Accept…   → HTTP 206 ✅
 * ```
 *
 * ⚠️ **只带 Referer 是不够的** —— 这一点与常见的说法（以及我们最初的
 *    调研结论）不同。原因是调研时用的是 Node 的 `fetch`：它**自带**
 *    `User-Agent: node` 之类的默认头，所以「只加 Referer」也能过。
 *    而宿主走的是 reqwest，默认**不带 User-Agent** ——
 *    于是同一份代码在两种环境下结果相反。
 *
 * 结论：把浏览器会带的头**成套**带上。这不是「伪装浏览器」的 hack，
 * 而是这些 CDN 的 WAF 按「请求头完整性」判定是否为正常播放器。
 */
const PLAY_HDRS = {
  Referer: 'https://www.bilibili.com',
  Origin: 'https://www.bilibili.com',
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  Accept: '*/*',
  'Accept-Language': 'zh-CN,zh;q=0.9',
}

const API = 'https://api.bilibili.com'

/* ═══════════ 上游接口返回的形状（补类型时新增，只声明用到的字段）═══════════ */

/*
 * ⚠️ 下面这些接口是**补类型时新加的** —— 原 .js 里完全没有类型，
 *    上游字段全靠记忆拼，拼错要到运行时才发现。
 *
 * 纪律（这份文件自己就在用）：**只声明本文件真正读到的字段**；
 * 上游返回的字段远不止这些，以后用到哪个再往这里加。
 *
 * B 站的 JSON 接口是统一外壳 `{ code, message, data }`：
 *   · `code !== 0` 的业务错误由下面的 getJson() 统一抛错，
 *     所以这里不把 code/message 抄进每个 data 接口；
 *   · 字段名有 camelCase 与 snake_case **两种拼法混用**
 *     （例如 playurl 是 `baseUrl` 与 `is_preview` 并存）——
 *     两种都声明不是笔误，是实测存在的。
 */

/** 通用外壳里本文件用到的两个字段（getJson 读它们判业务错误码） */
interface BiliJson {
  code?: number
  message?: string
}

/** `x/web-interface/nav` 的 data（当前登录态） */
interface BiliNavData {
  isLogin?: boolean
  uname?: string
  mid?: number
  /** 头像地址；用户没设过头像时接口给的是 null */
  face?: string | null
  vipStatus?: number
  vip?: { status?: number }
}

/** `x/web-interface/nav` 的整包响应 */
interface BiliNavResponse extends BiliJson {
  /** 未登录时 data 整体缺省 */
  data?: BiliNavData
}

/** `verifyCookie()` 归一化后的用户信息 */
interface BiliUserInfo {
  uname: string
  mid: number
  avatar: string | null
  vip: boolean
}

/**
 * `login()` 的**对象形态**参数
 *
 * 宿主契约是**两个位置参数**（见下面 login 的注释），对象形态只是
 * 原代码保留的兼容分支 —— 类型上如实写成两种都接受。
 */
interface BiliCredentialObject {
  username?: string
  password?: string
}

/** UP 主（view 与热门/排行两种接口都有这个结构） */
interface BiliOwner {
  name?: string
}

/** 统计数字（本文件只读 view） */
interface BiliStat {
  view?: number
}

/** `x/web-interface/view` 的一 P */
interface BiliPage {
  cid?: number
  part?: string
  page?: number
}

/** `x/web-interface/view` 的 data（detail 用） */
interface BiliViewData extends BiliJson {
  /** 视频接口必给 bvid / title（游客态实测），所以这两个声明为必有 */
  bvid: string
  title: string
  /** 第 1P 的 cid（多 P 时**不能**拿它当每 P 的 cid，见 detail 里的注释） */
  cid?: number
  pic?: string
  desc?: string
  duration?: number
  tname?: string
  pubdate?: number
  owner?: BiliOwner
  stat?: BiliStat
  pages?: BiliPage[]
}

/** `x/web-interface/view` 的整包响应 */
interface BiliViewResponse extends BiliJson {
  data?: BiliViewData
}

/** view 结果里 viewToItem() 用到的字段 */
interface BiliViewArc {
  bvid: string
  title: string
  pic?: string
  duration?: number
  owner?: BiliOwner
  stat?: BiliStat
}

/** 热门 / 排行榜的条目（两个接口共用一个形状） */
interface BiliArcData {
  bvid?: string
  aid?: number
  title: string
  pic?: string
  duration?: number
  /** 排行榜把 UP 主名放在 author 里，popular 放在 owner.name 里 —— 两个都可能缺 */
  author?: string
  owner?: BiliOwner
  stat?: BiliStat
}

/** `x/web-interface/popular` 的整包响应 */
interface BiliPopularResponse extends BiliJson {
  data?: {
    list?: BiliArcData[]
    /** B 站给的「没有下一页」标志 */
    no_more?: boolean
  }
}

/** `x/web-interface/ranking/v2` 的整包响应 */
interface BiliRankResponse extends BiliJson {
  data?: {
    list?: BiliArcData[]
  }
}

/** `/wbi/search/type` 的一条结果 */
interface BiliSearchResult {
  bvid: string
  title?: string
  pic?: string
  author?: string
  /** 搜索接口给的是 `"129:42"` 这种字符串（见 toSecs 的注释） */
  duration?: string | number
  play?: number | string
}

/** `/wbi/search/type` 的整包响应 */
interface BiliSearchResponse extends BiliJson {
  data?: {
    result?: BiliSearchResult[]
    numPages?: number
    numResults?: number
  }
}

/** 一条 DASH 轨（视频轨与音频轨同形） */
interface BiliDashTrack {
  /** 清晰度 id（就是 qn：120=4K … 16=360P） */
  id?: number
  /** 轨地址 —— camelCase 与 snake_case 两种拼法，接口必给其一 */
  baseUrl?: string
  /** 同上（snake_case 形态） */
  base_url?: string
  bandwidth?: number
  /** `avc1.640032` / `hvc1.…` —— 必须挑 avc1，见 resolve 里的注释 */
  codecs?: string
  /** 备用线路（同清晰度的其它 CDN） */
  backupUrl?: string[]
  backup_url?: string[]
}

/** `x/player/playurl` 的 data */
interface BiliPlayUrlData extends BiliJson {
  bvid?: string
  cid?: number
  /** 时长（毫秒）—— 用来拦「会员集静默降级成试看」 */
  timelength?: number
  /** 试看标记；两种拼法都实测出现过，所以两个都声明 */
  is_preview?: boolean
  isPreview?: boolean
  dash?: {
    video?: BiliDashTrack[]
    audio?: BiliDashTrack[]
  }
}

/** `x/player/playurl` 的整包响应 */
interface BiliPlayUrlResponse extends BiliJson {
  data?: BiliPlayUrlData
}

/** `SECTIONS` 的元素 —— 只有 `kind: 'rank'` 的项才带 `rid` */
type SectionDecl =
  | { id: string; title: string; kind: 'popular' }
  | { id: string; title: string; kind: 'rank'; rid: number }

/* ═══════════════════════ 登录（Cookie 导入）═══════════════════════ */

/**
 * 登录态存 `host.store`（插件私有，别的插件读不到）
 *
 * ⚠️ **绝不能**把它写进插件源码 —— 那是账号权限级别的凭据。
 *    宿主的隐私检查（`tools/check-privacy.mjs`）会扫 `SESSDATA=` 形态
 *    并拦下提交，这里是存到运行时的插件私有目录。
 *
 * ⚠️ 备份**不会**带走它：`build_backup_payload` 只收 `plugins/*.js`，
 *    插件私有目录（`plugins/.data/`）被排除在外。
 */
const COOKIE_KEY = 'bili_cookie'

/**
 * 读已保存的 Cookie（没有返回空串）
 *
 * 每次请求前现读 —— 这样用户在设置页登录/登出后**立刻生效**，
 * 不用重启应用。
 */
function cookie(): string {
  try {
    return host.store.get(COOKIE_KEY) || ''
  } catch {
    return ''
  }
}

/**
 * 把 Cookie 拼进请求头
 *
 * ⚠️ 没登录时要**原样返回**，不能塞一个空的 `Cookie` 头 ——
 *    实测空的 Cookie 头会让 B 站接口返回 `code=-400`（参数错），
 *    表现为「游客本来能用，加了这个函数反而全坏了」。
 */
function withCookie(headers: Record<string, string>): Record<string, string> {
  const c = cookie()
  if (!c) return headers
  return Object.assign({}, headers, { Cookie: c })
}

/**
 * 校验 Cookie 是否有效，并取出用户信息
 *
 * 用 `x/web-interface/nav` —— 它是 B 站官方的「当前登录态」接口：
 * ```text
 * 未登录/失效 → { code: -101, message: "账号未登录" }
 * 有效        → { code: 0, data: { isLogin: true, uname: "...", ... } }
 * ```
 *
 * ★ 必须**真的调一次**验它，不能只看"字符串非空" ——
 *   Cookie 会过期，而用户粘贴时可能已经过期了。
 *   直接存下一个死 Cookie 会让用户以为登录成功、实际什么都没生效。
 */
async function verifyCookie(c: string): Promise<BiliUserInfo> {
  const j = await getJson<BiliNavResponse>(`${API}/x/web-interface/nav`, withCookieOf(c, HDRS))
  const d: BiliNavData = j.data || {}
  if (!d.isLogin) {
    throw new Error('unauthorized: Cookie 无效或已过期（B 站返回未登录）')
  }
  return {
    uname: d.uname || '',
    mid: d.mid || 0,
    avatar: d.face || null,
    vip: !!(d.vipStatus || (d.vip && d.vip.status)),
  }
}

/** `withCookie` 的显式版本（校验时用传入值，不读 store） */
function withCookieOf(c: string, headers: Record<string, string>): Record<string, string> {
  if (!c) return headers
  return Object.assign({}, headers, { Cookie: c })
}

/**
 * 从用户粘贴的内容里**提取** Cookie 串
 *
 * 用户会以各种形式粘进来，实测常见的几种：
 * ```text
 * ① SESSDATA=xxx; bili_jct=yyy; DedeUserID=zzz      ← 最规范
 * ② SESSDATA=xxx                                     ← 只要一个也行
 * ③ 整段从浏览器 DevTools 复制的（含换行/多余空格）
 * ④ 只复制了 SESSDATA 的值（没有 `SESSDATA=` 前缀）
 * ```
 *
 * 这里做归一化：把换行压成空格、去掉多余分号，
 * 并**识别 ④ 那种只粘了值的情况**（没有 `=` 的长串）。
 */
function normalizeCookie(raw: unknown): string {
  let s = String(raw || '').trim()
  if (!s) return ''

  // 换行/制表 → 空格，连续空格压成一个
  s = s.replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ')

  /*
   * 只粘了值（没有 `key=value` 形态）→ 当作 SESSDATA
   *
   * B 站的 SESSDATA 是 URL 编码过的长串（含 %2C 之类）。
   * 判据：**一个 `=` 都没有**且长度 > 20。
   */
  if (!s.includes('=') && s.length > 20) {
    return 'SESSDATA=' + s
  }

  // 补齐常见的键名大小写（用户可能小写粘贴）
  s = s.replace(/\bsessdata=/gi, 'SESSDATA=')
  s = s.replace(/\bbili_jct=/gi, 'bili_jct=')
  s = s.replace(/\bdedeuserid=/gi, 'DedeUserID=')

  // 去掉结尾多余的分号与空格
  s = s.replace(/;\s*$/, '').replace(/;\s*;/g, ';')

  return s
}

/**
 * 登录（Cookie 导入）
 *
 * # 为什么是 Cookie 而不是账号密码
 *
 * B站 的账号密码登录有**极验验证码**（geetest），纯 HTTP 客户端
 * 几乎必然失败。扫码登录 API 可用（实测 `qrcode/generate` 返回
 * `code=0`），但**必须真人拿手机扫** —— 那一步无法自动化验证。
 *
 * 所以这里选**唯一能端到端验证**的方式：让用户从浏览器复制 Cookie。
 *
 * # ⚠️⚠️ 参数契约（实测踩到，2026-09-20）
 *
 * 宿主是这么调的（`plugins/mod.rs` 的 `fn login`）：
 * ```rust
 * "plugin.login({}, {})", to_string(&cred.username), to_string(&cred.password)
 * ```
 * ⇒ **两个位置参数**（`username`, `password`），**不是一个对象**！
 *
 * 我第一版写成 `async function login(cred)` 然后读 `cred.password` ——
 * 结果 `cred` 是字符串 `""`，读 `.password` 得到 `undefined`，
 * 于是**永远报「没有收到 Cookie」**，而实际上前端的值传过来了。
 *
 * 所以这里要**同时兼容两种形态**：
 *   · 位置参数：`login(user, pass)`
 *   · 对象：`login({ username, password })`（备用，万一宿主改了契约）
 */
async function login(a?: string | BiliCredentialObject, b?: string): Promise<Session> {
  let raw = ''
  if (a && typeof a === 'object') {
    // 对象形态
    raw = a.password || a.username || ''
  } else {
    // 位置参数形态（宿主当前用的）——
    // 插件声明了 loginNeedsUsername: false，所以前端不显示账号框，
    // 用户粘贴的内容落在**第二个**参数里。
    raw = b || a || ''
  }

  const c = normalizeCookie(raw)
  if (!c) throw new Error('parse: 没有收到 Cookie，请粘贴后再试')

  const info = await verifyCookie(c)
  try {
    host.store.set(COOKIE_KEY, c)
    host.store.set('bili_uname', info.uname || '')
  } catch { /* 存储失败不影响本次登录 */ }
  // 原代码把 host.log 当函数调 —— 宿主契约里日志是 host.log.info/warn/error/debug
  host.log.info('B站登录成功：' + (info.uname || '(未知用户)'))

  return {
    // 不把 Cookie 当 token 返回给前端 —— 那会让凭据在界面层流转
    token: 'cookie',
    displayName: info.uname || 'B站用户',
    avatar: info.avatar || undefined,
  }
}

/** 当前会话（未登录返回 null） */
async function session(): Promise<Session | null> {
  const c = cookie()
  if (!c) return null
  /*
   * ⚠️ 这里**不重新校验** —— 那会让每次进入设置页都多一次网络请求。
   *    只在真正取流失败时（401/-101）才提示重新登录。
   *    校验交给 `login()` 与 `refreshSession()`。
   */
  let name = 'B站用户'
  try {
    const cached = host.store.get('bili_uname')
    if (cached) name = cached
  } catch { /* 忽略 */ }
  return { token: 'cookie', displayName: name }
}

/** 登出（清掉本地 Cookie） */
async function logout(): Promise<void> {
  try {
    host.store.remove(COOKIE_KEY)
    host.store.remove('bili_uname')
  } catch { /* 忽略 */ }
}

/**
 * 会话是否需要续期
 *
 * Cookie 不主动过期（B站 的 SESSDATA 有有效期，但那是服务端判的）——
 * 所以这里只报告"不需要续期"，让宿主别白跑自动登录。
 */
async function sessionNeedsRefresh(): Promise<boolean> {
  return false
}

/**
 * 主动校验一次（宿主在"设置页刷新会话状态"或"取流前 ensure"时调）
 *
 * 与 `session()` 的区别：这个**真的发请求**验 Cookie。
 */
async function refreshSession(): Promise<Session | null> {
  const c = cookie()
  if (!c) return null
  try {
    const info = await verifyCookie(c)
    try {
      host.store.set('bili_uname', info.uname || '')
    } catch { /* 忽略 */ }
    return {
      token: 'cookie',
      displayName: info.uname || 'B站用户',
      avatar: info.avatar || undefined,
    }
  } catch (e) {
    /*
     * Cookie 失效 → **清掉**并返回 null
     *
     * 不清的话设置页会一直显示"已登录"，而实际每次请求都失败 ——
     * 用户看到的是一个**骗人的状态**。
     */
    // 原代码把 host.log 当函数调（见上面 login 里同样的修正）；
    // `e && e.message` 保持不变 —— 原 JS 在 e 为 null/undefined 时得到的是该值本身，
    // 现在收窄成具体消息（这两行注释说明的是**类型**，不是行为）。
    host.log.info('B站 Cookie 已失效，已清除：' + (e instanceof Error ? e.message : ''))
    try {
      host.store.remove(COOKIE_KEY)
      host.store.remove('bili_uname')
    } catch { /* 忽略 */ }
    return null
  }
}


/**
 * GET 并解析 JSON
 *
 * ⚠️ `host.http` **不抛异常** —— 网络失败时返回以 `__ERR__` 开头的字符串。
 *    直接 `JSON.parse` 会得到 `unexpected token: '__ERR__'`，
 *    那种报错完全看不出是网络问题（demo 里就踩过）。
 */
async function getJson<T = BiliJson>(url: string, headers?: Record<string, string>): Promise<T> {
  /*
   * ★ 带上登录 Cookie（没登录时 withCookie 原样返回，不塞空头）
   *
   * 这样**所有**接口（热门/搜索/详情/取流）都自动享受登录态，
   * 不用在每个调用点单独处理。
   */
  const h = withCookie(headers || HDRS)
  const text = await host.http.get(url, { headers: h })
  if (text.startsWith('__ERR__')) {
    throw new Error('network: ' + text.slice(7))
  }
  let j: unknown
  try {
    j = JSON.parse(text)
  } catch {
    throw new Error('parse: 返回不是合法 JSON — ' + text.slice(0, 120))
  }
  /*
   * B 站的业务错误码在 `code` 里，HTTP 状态仍是 200。
   *   0    = 成功
   *   -352 = 限流（要退避重试）
   *   412  = 风控（同上）
   *   -400 = 参数错
   */
  /*
   * JSON.parse 的结果是 unknown（不能假设上游一定给对了形状）——
   * 这里只声明外壳里用到的 code / message（见 BiliJson）。
   * `as` 是**纯类型**收窄，运行时没有任何转换。
   */
  const biz = j as BiliJson
  if (j && typeof biz.code === 'number' && biz.code !== 0) {
    /*
   * 限流要如实标成 network，让宿主按「网络问题」对待（可重试），
   * 而不是当成「这个源坏了」。
   */
    if (biz.code === -352 || biz.code === -412 || biz.code === 412) {
      throw new Error('network: B 站限流，请稍后再试（code ' + biz.code + '）')
    }
    throw new Error('B 站接口返回 code=' + biz.code + (biz.message ? ' ' + biz.message : ''))
  }
  return j as T
}

/**
 * 图片地址归一化
 *
 * 三种形态都存在，实测确认：
 *   · 搜索返回 `//i0.hdslb.com/...`（**协议相对**）
 *   · popular/view 返回 `http://i0.hdslb.com/...`
 *   · 偶尔是 `https://`
 *
 * 统一改成 https：应用页面是 https 语境（tauri.localhost），
 * 混合内容会被 WebView 拦掉，表现是**封面全白**但控制台只有一行警告。
 */
function fixPic(u: string | null | undefined): string {
  if (!u) return ''
  if (u.startsWith('//')) return 'https:' + u
  if (u.startsWith('http://')) return 'https://' + u.slice(7)
  return u
}

/**
 * 时长转秒
 *
 * ⚠️ B 站的时长有**两种格式**，实测都要处理：
 *   · 搜索接口：字符串 `"129:42"`（mm:ss；超过 1 小时时分位照样堆在分钟位）
 *   · view/popular 接口：数字秒
 */
function toSecs(d: number | string | null | undefined): number {
  if (typeof d === 'number') return d
  if (typeof d !== 'string' || !d) return 0
  /*
   * ⚠️ `noUncheckedIndexedAccess` 让 `parts[0]` 的类型是 `number | undefined`。
   *    `|| 0` 与原 JS 完全等价 —— 元素本身是 `parseInt(...) || 0` 算出来的，
   *    只可能是 0 或非零数，所以补 0 不会改变任何结果。
   */
  const parts = d.split(':').map((x) => parseInt(x, 10) || 0)
  const p0 = parts[0] || 0
  if (parts.length === 2) return p0 * 60 + (parts[1] || 0)
  if (parts.length === 3) return p0 * 3600 + (parts[1] || 0) * 60 + (parts[2] || 0)
  return p0
}

/** 秒 → `12:34` / `1:02:03` */
function fmtDur(sec: number | null | undefined): string {
  if (!sec) return ''
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const s = Math.floor(sec % 60)
  const p = (n: number): string => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${p(m)}:${p(s)}` : `${m}:${p(s)}`
}

/** 播放量：12345 → 1.2万 */
function fmtCount(n: number | string | null | undefined): string {
  const v = Number(n) || 0
  if (v >= 100000000) return (v / 100000000).toFixed(1) + '亿'
  if (v >= 10000) return (v / 10000).toFixed(1) + '万'
  return String(v)
}

/**
 * 清洗搜索结果的标题
 *
 * ⚠️ 搜索接口返回的标题**含 HTML 高亮标签**，实测原文形如：
 *   `央视年代剧刷爆全网！<em class="keyword">老舅</em>全集`
 * 不清洗的话界面上会直接显示出 `<em class="keyword">` 这串字符。
 */
function cleanTitle(t: string | null | undefined): string {
  return String(t || '')
    .replace(/<\/?em[^>]*>/g, '')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;/g, "'")
}

/** 从 view 结果映射成 MediaItem */
function viewToItem(v: BiliViewArc): MediaItem {
  return {
    id: 'av:' + v.bvid,
    title: v.title,
    cover: fixPic(v.pic),
    subtitle: [v.owner && v.owner.name, fmtDur(v.duration), fmtCount(v.stat && v.stat.view) + '播放']
      .filter(Boolean)
      .join(' · '),
    /*
     * ⚠️ kind 只能取 movie / series / live / variety / collection
     *    （Rust 的 `MediaKind` 枚举，serde 用 snake_case）。
     *    写 'other' 会直接报 `unknown variant`，整个 list() 失败。
     *    B 站单个投稿视频视作 movie。
     */
    kind: 'movie',
  }
}

/** 从 popular/ranking 条目映射成 MediaItem */
function arcToItem(a: BiliArcData): MediaItem {
  return {
    id: 'av:' + (a.bvid || a.aid),
    title: a.title,
    cover: fixPic(a.pic),
    subtitle: [
      (a.owner && a.owner.name) || a.author,
      fmtDur(a.duration),
      a.stat && a.stat.view ? fmtCount(a.stat.view) + '播放' : '',
    ]
      .filter(Boolean)
      .join(' · '),
    kind: 'movie',
  }
}

/*
 * 首页分区
 *
 * 每个 Section 只是「区块声明」，不含内容 —— 宿主会按 source 懒加载。
 * 这样首页首屏不用等所有区块都拉完（实测首页有 13 个区块时，
 * 全量拉要好几秒）。
 */
const SECTIONS: SectionDecl[] = [
  { id: 'popular', title: '热门', kind: 'popular' },
  { id: 'rank0', title: '全站排行榜', kind: 'rank', rid: 0 },
  { id: 'rank1', title: '动画排行', kind: 'rank', rid: 1 },
  { id: 'rank3', title: '音乐排行', kind: 'rank', rid: 3 },
  { id: 'rank4', title: '游戏排行', kind: 'rank', rid: 4 },
  { id: 'rank36', title: '知识排行', kind: 'rank', rid: 36 },
  { id: 'rank188', title: '科技排行', kind: 'rank', rid: 188 },
  { id: 'rank5', title: '娱乐排行', kind: 'rank', rid: 5 },
]

/** 抓「热门」第 n 页 */
async function fetchPopular(pn?: number): Promise<Page<MediaItem>> {
  /*
   * ps 上限实测：20/50 可以，100 → code=-400。用 20 保证稳。
   */
  const j = await getJson<BiliPopularResponse>(`${API}/x/web-interface/popular?ps=20&pn=${pn || 1}`)
  const list = (j.data && j.data.list) || []
  return {
    items: list.map(arcToItem),
    page: pn || 1,
    // no_more 是 B 站给的结束标志
    pageCount: j.data && j.data.no_more ? pn || 1 : (pn || 1) + 1,
  }
}

/** 抓某个分区的排行榜 */
async function fetchRank(rid: number, page?: number): Promise<Page<MediaItem>> {
  /*
   * ⚠️ `ranking/v2` 是**一次性返回整榜**的（实测 rid=0 给 100 条），
   *    没有分页参数。所以这里只取第 1 页，翻页时如实返回空，
   *    避免给用户「翻到第 2 页看到重复内容」的困惑。
   */
  if (page && page > 1) return { items: [], page, pageCount: 1 }

  const j = await getJson<BiliRankResponse>(`${API}/x/web-interface/ranking/v2?rid=${rid}&type=all`)
  const list = (j.data && j.data.list) || []
  return { items: list.map(arcToItem), page: 1, pageCount: 1 }
}

definePlugin({
  id: 'bilibili',
  /*
   * ⚠️ 这里**没有** `name` —— 与原 .js 逐字一致。
   *    显示名走头部注释的 `@name`，宿主**从不读对象上的 `name`**
   *    （`parse_meta` 解析头部得到 `PluginMeta`，见 Rust `plugins/mod.rs:74`）。
   *    契约里 `Plugin.name` 已由必填改为可选，正是为了不用抄这一份。
   */

  capabilities: {
    vod: true,
    search: true,
    // 不做直播（B 站直播接口要另一套，与点播的取流模型不同）
    live: false,

    /*
     * ★★ 登录：**游客可用，也支持登录**（2026-09-20）
     *
     * # 为什么不是 `loginRequired: true`
     *
     * 「必须登录」与「支持登录」是两件事：
     * ```text
     * loginRequired: true    → 宿主的 ensure_session 会**挡住游客播放**
     * loginSupported: true   → 登录入口出现，但游客路径完全不变
     * ```
     *
     * 而「不登录也能看 1080P」是本插件最关键的能力（实测 15/15 拿到
     * 1920x1080，靠的是取流参数 `try_look=1`）——
     * 设成必需登录就等于把这个能力**收回去了**。
     *
     * 所以：游客照常，登录是**可选增强**（同步关注/收藏、稍后再看）。
     */
    loginRequired: false,
    loginSupported: true,

    /*
     * 登录方式：**粘贴 Cookie**（不是账号密码）
     *
     * B站 账号密码登录有极验验证码，纯 HTTP 必然失败；
     * 扫码 API 可用但必须真人扫（无法自动化验证）。
     * Cookie 是唯一能端到端验证的方式。
     */
    loginHint:
      'B站的账号密码登录有验证码，无法自动完成；扫码又需要你手动扫一次。' +
      '所以这里用「Cookie 导入」——在浏览器登录 B站 后按 F12，' +
      '在 Console 里执行 document.cookie，把结果整段粘贴到下框即可（只需一次）。',
    // Cookie 导入不需要账号字段
    loginNeedsUsername: false,
  },

  /* ── 登录相关（宿主按契约调用）── */
  login,
  logout,
  session,
  /*
   * ⚠️ 这个方法**宿主目前不会调**（2026-10-09 逐行核过）：
   *    `ensure_session` 调的是 Rust trait 的 `session_needs_refresh()`，
   *    而 `JsPluginProvider` 没把它桥到插件对象上 —— JS 插件永远走 trait
   *    的默认实现（按 `session().expiresAt` 算）。
   *
   *    挂上它是**保持原有对象形状**（原 .js 就把它注册进了 `globalThis.plugin`），
   *    且签名与契约一致；宿主接桥后即可生效。续期现在实际靠 `refreshSession`。
   */
  sessionNeedsRefresh,
  refreshSession,

  async home(): Promise<Section[]> {
    return SECTIONS.map((s) => ({
      id: 'bili-' + s.id,
      title: s.title,
      source:
        s.kind === 'rank'
          ? { type: 'rank', rankId: String(s.rid) }
          : { type: 'category', categoryId: s.id },
    }))
  },

  /**
   * 分类列表（浏览页左侧）
   *
   * ⚠️ B 站**没有**「取分区表」的接口（实测 `x/web-interface/region`
   *    返回 HTTP 404，`dynamic/region` 恒返回 code=-404）。
   *    所以这里硬编码一份 —— 这是唯一可行的做法。
   *
   * 只列实测**确认可用**的 rid（168/217/223 实测返回空，已剔除）。
   */
  async categories() {
    const cats = [
      { id: 1, name: '动画' },
      { id: 3, name: '音乐' },
      { id: 4, name: '游戏' },
      { id: 5, name: '娱乐' },
      { id: 11, name: '电视剧' },
      { id: 13, name: '番剧' },
      { id: 23, name: '电影' },
      { id: 36, name: '知识' },
      { id: 119, name: '鬼畜' },
      { id: 129, name: '舞蹈' },
      { id: 155, name: '时尚' },
      { id: 160, name: '生活' },
      { id: 181, name: '影视' },
      { id: 188, name: '科技' },
      { id: 211, name: '美食' },
    ]
    return cats.map((c) => ({ id: String(c.id), name: c.name, children: [] }))
  },

  /**
   * 列表
   *
   * `categoryId` 有两种来源：
   *   · 首页的「热门」（`categoryId === 'popular'`）→ 走 popular 接口
   *   · 分类浏览（数字 rid）→ 走排行榜
   *
   * ⚠️ **为什么不走 `newlist`（分区最新投稿）**：实测深翻页对游客
   *    基本失效 —— pn=1..4 返回**完全相同**的 5 条，pn=5 才换一批。
   *    与其给用户一个「翻页没反应」的列表，不如用排行榜
   *    （内容质量也更高）。
   */
  async list(req) {
    const cid = String(req.categoryId || '')
    if (cid === 'popular') return fetchPopular(req.page)

    const rid = parseInt(cid, 10)
    if (!isNaN(rid)) return fetchRank(rid, req.page)

    // 未知分类 → 退回热门，而不是报错（用户至少能看到东西）
    return fetchPopular(req.page)
  },

  /** 排行榜（浏览页用 `r` 参数走这里） */
  async rank(rankId, page) {
    const rid = parseInt(String(rankId), 10)
    return fetchRank(isNaN(rid) ? 0 : rid, page)
  },

  /**
   * 搜索
   *
   * ⚠️ 必须用带 `/wbi/` 前缀的路径 —— 实测无前缀的 `search/type`
   *    100% 返回 HTML 风控页，而带前缀的**不需要任何签名参数**。
   */
  async search(keyword, page) {
    const p = page || 1
    const j = await getJson<BiliSearchResponse>(
      `${API}/x/web-interface/wbi/search/type?search_type=video&keyword=${encodeURIComponent(
        keyword,
      )}&page=${p}`,
    )
    const list = (j.data && j.data.result) || []

    return {
      items: list.map((r) => ({
        // 搜索给 bvid，但 aid 也在 —— 统一用 bvid（更稳定）
        id: 'av:' + r.bvid,
        title: cleanTitle(r.title),
        cover: fixPic(r.pic),
        subtitle: [r.author, fmtDur(toSecs(r.duration)), fmtCount(r.play) + '播放']
          .filter(Boolean)
          .join(' · '),
        kind: 'movie',
      })),
      page: p,
      // numPages 实测上限 50、numResults 1000
      pageCount: (j.data && j.data.numPages) || 1,
      total: (j.data && j.data.numResults) || undefined,
    }
  },

  /**
   * 详情
   *
   * ⚠️ 多 P 视频**必须用 `pages[i].cid`** —— `data.cid` 只是第 1P 的。
   *    用错了的表现是「选第 3P 播放的却是第 1P」（而且是静默的）。
   */
  async detail(id) {
    const bvid = String(id).replace(/^av:/, '')
    if (!bvid) throw new Error('无效的视频 id')

    const j = await getJson<BiliViewResponse>(`${API}/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`)
    // getJson 返回的是**整包**（外壳与 data 都在里面），所以这里仍取 `j.data`。
    const d = j.data
    if (!d) throw new Error('取不到视频信息')

    const pages = d.pages && d.pages.length ? d.pages : [{ cid: d.cid, part: d.title, page: 1 }]

    return {
      id: 'av:' + d.bvid,
      title: d.title,
      cover: fixPic(d.pic),
      description: d.desc || '',
      kind: pages.length > 1 ? 'series' : 'movie',
      /*
       * ⚠️ `meta` 的 key **必须用 ASCII**
       *
       * 宿主在插件边界会把 camelCase 转成 snake_case
       * （`camel_to_snake` 逐字符处理大写字母）。中文 key 里若混了
       * 大写字母会被拆开且**转不回来**：
       *   `UP主` → `_u_p主`   （实测看到的就是这个）
       * 所以这里统一用英文 key，显示文案由界面负责。
       */
      meta: {
        uploader: (d.owner && d.owner.name) || '',
        duration: fmtDur(d.duration),
        views: fmtCount(d.stat && d.stat.view),
        category: d.tname || '',
        published: d.pubdate ? new Date(d.pubdate * 1000).toLocaleDateString('zh-CN') : '',
      },
      // B 站只有一条线路（清晰度在取流时选，不是「线路」）
      sources: [{ code: 'default', title: '哔哩哔哩', count: pages.length }],
      episodes: pages.map((p, i) => ({
        /*
         * ★ 剧集 id 里带上 cid —— 取流时要用它，
         *   而 `resolve` 只拿得到这一个 id（契约如此）。
         *   格式：`bvid|cid`，主键在前方便排查。
         */
        id: `${d.bvid}|${p.cid}`,
        title: pages.length > 1 ? `P${p.page} ${p.part || ''}`.trim() : d.title,
        order: i + 1,
      })),
    }
  },

  /**
   * 取流
   *
   * ═══════════════════════════════════════════════════════════════
   *  ★★★ 2026-09-19 重大修正：改用 DASH，游客拿到真 1080P
   * ═══════════════════════════════════════════════════════════════
   *
   * # 之前错在哪
   *
   * 旧版用 `fnval=1`（durl，合并流），并在注释里断言
   * 「游客最高 720p，1080p 需要登录」。**那个结论是错的** ——
   * 错在只测了 durl 一种模式。
   *
   * # 实测（15 个热门视频，逐个验证）
   *
   * ```text
   * fnval=1 (durl)               → 恒 720P，传 qn=80/116/120 都没用
   *                                ffprobe 确认 1280x720，format="mp4720"
   * fnval=16 (DASH) 不带 try_look → 最高 480P（id=32）
   * fnval=16 (DASH) + try_look=1 → ★ 15/15 拿到 1920x1080 (id=80)
   * ```
   *
   * ★ 关键就是 **`try_look=1`** —— 它是"试看"参数，
   *   但实测副作用是**放开了清晰度限制**，让游客也能拿 1080P。
   *
   * # 为什么之前没发现
   *
   * 旧注释里写「durl 同时赢了画质和单 URL 可播」——
   * 那是**只比较了 durl 与「不带 try_look 的 DASH」**得出的结论。
   * 加上 try_look 后 DASH 反超，而且超了整整一档（720P → 1080P）。
   *
   * # 代价：音视频分离
   *
   * DASH 的视频轨与音频轨是**两个文件**，所以返回时用
   * `audioUrl` 声明音频轨（宿主模型里已有这个字段）。
   * 播放器会用 video + audio 双元素同步播放。
   *
   * 之所以可行（实测）：
   *   · B 站 DASH 轨是**单个 fMP4 文件**，`moov` 在最前面（偏移 36）
   *     → `<video>` 能直接流式播
   *   · MSE 支持 `avc1.640032`(1080P H.264) 与 `mp4a.40.2`(AAC)
   *   · ⚠️ **不支持** `hvc1`(HEVC) → 必须挑 avc1，挑了 HEVC 会黑屏
   */
  async resolve(id, req) {
    /*
     * id 有两种形态：
     *   · `bvid|cid`（来自 detail 的剧集列表）
     *   · `bvid`（直接播放，用第 1P 的 cid）—— 需要先查一次详情
     */
    let bvid = ''
    let cid = ''

    const ep = (req && req.episodeId) || String(id)
    if (String(ep).includes('|')) {
      const parts = String(ep).split('|')
      // `|| ''` 只为满足 noUncheckedIndexedAccess；上面的 includes('|')
      // 保证了 split 至少两段，所以这两个兜底不会真的触发。
      bvid = parts[0] || ''
      cid = parts[1] || ''
    } else {
      bvid = String(ep).replace(/^av:/, '').replace(/^\|/, '')
    }
    bvid = bvid.replace(/^av:/, '')
    if (!bvid) throw new Error('无效的视频 id')

    // 没有 cid 就查一次详情拿第 1P
    if (!cid) {
      const j = await getJson<BiliViewResponse>(`${API}/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`)
      cid = String((j.data && j.data.cid) || '')
      if (!cid) throw new Error('取不到 cid')
    }

    /*
     * ★★ 请求 DASH（fnval=16）+ try_look=1
     *
     * qn 传 120（4K）：它只影响 `data.quality` 这个**标记字段**，
     * 不影响 `dash.video` 里有什么 —— 实测传 6/16/64/80/120/127，
     * `dash.video` 里**始终**是全部档位。所以传最大的，让服务端
     * 知道我们想要最好的。
     *
     * fourk=1 是允许 4K（游客拿不到，但传了无害）。
     */
    const j = await getJson<BiliPlayUrlResponse>(
      `${API}/x/player/playurl?bvid=${encodeURIComponent(bvid)}&cid=${cid}` +
        `&qn=120&fnval=16&fnver=0&fourk=1&try_look=1`,
    )
    const d = j.data
    if (!d) throw new Error('取不到播放地址')

    /*
     * ★ VIP/付费内容的静默降级必须拦下
     *
     * 实测：番剧会员集返回 `code=0` 但 `isPreview=1`，
     * 只有一段试看。不校验的话用户以为拿到了完整剧集，
     * 看着看着突然结束，完全不知道是「需要大会员」。
     */
    const durMs = d.timelength || 0
    const isPreview = !!d.is_preview || !!d.isPreview
    if (isPreview || (durMs > 0 && durMs < 120000 && d.dash && d.dash.video)) {
      throw new Error('该内容需要大会员（当前是试看片段）。本插件仅支持游客可看的内容。')
    }

    /*
     * ★★★ 从 dash.video 里挑最高的 **avc1** 流
     *
     * ⚠️ 必须排除 HEVC（hvc1）—— 实测浏览器的 MSE
     *    `isTypeSupported('video/mp4; codecs="hvc1.1.6.L150.90"')` 返回 **false**，
     *    选了它会**黑屏**（有声音、有进度，就是没画面）。
     *
     *    而 B 站对每个清晰度都同时提供 avc1 与 hvc1 两条，
     *    所以只要按 codecs 过滤就不会踩到。
     */
    const videos = (d.dash && d.dash.video) || []
    if (!videos.length) throw new Error('这个视频没有可用的视频流')

    const avcOnly = videos.filter((v) => String(v.codecs || '').startsWith('avc1'))
    const pool = avcOnly.length ? avcOnly : videos   // 万一没有 avc1 就退回全部（总比没有好）

    /*
     * 按清晰度 id 降序 —— id 就是 qn：
     *   120=4K  116=1080P60  80=1080P  64=720P  32=480P  16=360P
     */
    const sorted = pool.slice().sort((a, b) => (b.id || 0) - (a.id || 0))
    // `!`（非空断言）由上面的 `if (!videos.length) throw` 保证：
    // pool 来自 videos 且非空时 pool 也非空，所以 sorted[0] 一定存在。
    const best = sorted[0]!

    /** 音频轨：挑码率最高的那条（实测 3 条：30216/30232/30280） */
    const audios = (d.dash && d.dash.audio) || []
    const bestAudio = audios.slice().sort((a, b) => (b.bandwidth || 0) - (a.bandwidth || 0))[0]

    /** qn → 显示标签（`Record<number, string>`：与原 JS 的数字键对象等价） */
    const QN: Record<number, string> = {
      126: '杜比视界',
      125: 'HDR',
      120: '4K',
      116: '1080P60',
      112: '1080P+',
      80: '1080P',
      74: '720P60',
      64: '720P',
      32: '480P',
      16: '360P',
    }
    const qLabel = (qn: number | null | undefined): string => QN[qn ?? 0] || (qn ? `Q${qn}` : '未知')

    /*
     * 一条候选
     *
     * ★★ 三个字段缺一不可：
     *   · `headers`      —— B 站 CDN 强制校验 Referer（仅 UA → 403）
     *   · `notWebReady`  —— `<video>` 自己加不了请求头，必须宿主代理
     *   · `audioUrl`     —— DASH 音视频分离，不声明就只有画面没声音
     */
    const mk = (v: BiliDashTrack, label: string, qn: number | null | undefined): StreamCandidate => {
      /*
       * ⚠️ 轨地址有两种拼法（`baseUrl` / `base_url`），接口必给其一 ——
       *    这里断言掉 undefined，运行时行为与原 JS 完全一致
       *    （两个都缺时原 JS 给的就是 undefined）。
       */
      const c: StreamCandidate = {
        // `!`：两种拼法接口必给其一（两个都缺时原 JS 给的就是 undefined）
        url: v.baseUrl || v.base_url!,
        kind: 'mp4',
        quality: qLabel(qn),
        label,
        headers: PLAY_HDRS,
        notWebReady: true,
      }
      if (bestAudio) {
        c.audioUrl = bestAudio.baseUrl || bestAudio.base_url
      }
      return c
    }

    const out = [mk(best, `哔哩哔哩 ${qLabel(best.id)}`, best.id)]

    /*
     * 备用线路：主地址挂了（限流/CDN 抖动）时播放器自动试下一个。
     *
     * ★ 实测每个 DASH 轨有 2 个 backupUrl，**清晰度与主地址相同** ——
     *   它们是「同一档位的不同 CDN」，不是不同清晰度。
     *   旧版把它们当独立候选返回且都标 720P，界面上看起来像
     *   「三个档位全是 720P」—— 那是这个 bug 的成因。
     *   现在标签里明确写清是备用线路。
     */
    for (const b of best.backupUrl || best.backup_url || []) {
      if (b) out.push(mk({ baseUrl: b }, `哔哩哔哩 ${qLabel(best.id)} 备用`, best.id))
    }

    /*
     * ★ 降级候选：把次高档位也带上
     *
     * 1080P 在某些网络下会卡（码率约 2-3 Mbps）。
     * 带上 720P / 480P 让用户能手动切低 —— 这是主流播放器的做法。
     *
     * 只带前 3 档，避免候选列表太长把界面撑爆。
     */
    const lower = sorted.filter((v) => (v.id || 0) < (best.id || 0)).slice(0, 2)
    for (const v of lower) {
      out.push(mk(v, `哔哩哔哩 ${qLabel(v.id)}`, v.id))
    }

    return out
  },
})