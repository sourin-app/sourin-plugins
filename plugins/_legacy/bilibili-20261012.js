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

/**
 * 从 B 站的 DASH 返回体里组装**播放候选**
 *
 * ═════════════════════════════════════════════════════════════
 *  ★★★ 2026-09-27（task-71）提取成共用函数
 * ═════════════════════════════════════════════════════════════
 *
 * # 为什么要抽出来（而不是抄一份）
 * ```text
 * 番剧（PGC）的 playurl 返回体与投稿视频的 `dash`
 * **完全同形**（实测）：
 *   dash.video[].baseUrl / codecs / id / bandwidth / backupUrl
 *   dash.audio[].baseUrl
 * ⇒ 若各写一份，两处会**各自演化** ——
 *   本仓已有先例：`_StreamSheet` 与 `_LiveChannelsSheet`
 *   两个面板形态漂移。
 * ⇒ 提取成**一个**函数：VIP 校验、avc1 过滤、
 *   备用线路、降级候选**全部只有一处实现**。
 * ```
 *
 * # ★ 提取时**行为逐字不变**（投稿视频那条路径已验证过）
 * ```text
 * 只是"搬家"：拦截条件 / avc1 过滤 / 降序 / bestAudio /
 * mk() 三字段 / backupUrl / 次高 2 档 —— 全部逐字保留。
 * ```
 *
 * @param {object} d     接口返回的 `data`（UGC）或 `result`（PGC）
 * @param {string} brand 标签前缀（默认 '哔哩哔哩'；番剧传 '哔哩哔哩番剧'）
 */
function buildCandidates(d, brand) {
  const name = brand || '哔哩哔哩'

  const durMs = d.timelength || 0
  const isPreview = !!d.is_preview || !!d.isPreview
  if (isPreview || (durMs > 0 && durMs < 120000 && d.dash && d.dash.video)) {
    throw new Error('该内容需要大会员（当前是试看片段）。本插件仅支持游客可看的内容。')
  }

  const videos = (d.dash && d.dash.video) || []
  if (!videos.length) throw new Error('这个视频没有可用的视频流')

  const avcOnly = videos.filter((v) => String(v.codecs || '').startsWith('avc1'))
  const pool = avcOnly.length ? avcOnly : videos

  const sorted = pool.slice().sort((a, b) => (b.id || 0) - (a.id || 0))
  const best = sorted[0]

  const audios = (d.dash && d.dash.audio) || []
  const bestAudio = audios.slice().sort((a, b) => (b.bandwidth || 0) - (a.bandwidth || 0))[0]

  const QN = {
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
  const qLabel = (qn) => QN[qn] || (qn ? `Q${qn}` : '未知')

  const mk = (v, label, qn) => {
    const c = {
      url: v.baseUrl || v.base_url,
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

  const out = [mk(best, `${name} ${qLabel(best.id)}`, best.id)]

  /*
   * ★★★ 2026-10-12 修复：**不再把 backupUrl 当清晰度档位输出**
   *
   * # 症状（Owner 截图）
   * ```text
   * 清晰度列表出现三个一模一样的 1080P：
   *   1080P · 哔哩哔...
   *   1080P · 哔哩哔...
   *   1080P · 哔哩哔...
   *   720P
   *   480P
   * ```
   *
   * # 根因
   * ```text
   * `backupUrl` 是**同一个视频、同一档清晰度**的备用 CDN 地址
   * （源站之外的镜像），**不是**更低/更高清晰度。
   * 而这里把它当成独立候选 push 进 `out`，还带上同一个 `best.id`
   * ⇒ 三条的 quality 全是 1080P ⇒ 界面画成三行 1080P。
   *
   * 而且 label 只差一个备用后缀，长名字被省略号截断后
   * ⇒ 三行**看起来完全一样**，用户无从选择。
   * ```
   *
   * # 为什么可以直接去掉（不是暂时隐藏）
   * ```text
   * ① 宿主**没有任何**故障转移逻辑消费它 ——
   *    `grep backupUrl` 在 app 的 lib/ 与 rust/ 里**零命中**
   *    ⇒ 这几条从发出到显示，全程没人用。
   * ② 它们的 quality 与 best 相同 ⇒ 出现在清晰度列表里**语义就是错的**。
   * ③ 真正的备用镜像应当由播放器/宿主做 failover，
   *    而不是伪装成一个清晰度选项骗用户去点。
   * ```
   *
   * # 影响面
   * ```text
   * dash.video[0].backupUrl（投稿视频）
   *   实测该字段本就常缺失/为空 ⇒ 多数视频**本来就只有一条 1080P**，
   *   本改动对它们是 **no-op**（逐字不变）。
   * 同档多镜像的（如本次 Owner 遇到的）⇒ 列表从 3 行 1080P 变回 1 行。
   * 次高 2 档（720P / 480P）**不受影响**，见下面 `lower` 那段。
   * ```
   */

  const lower = sorted.filter((v) => (v.id || 0) < (best.id || 0)).slice(0, 2)
  for (const v of lower) {
    out.push(mk(v, `${name} ${qLabel(v.id)}`, v.id))
  }

  return out
}


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
function cookie() {
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
function withCookie(headers) {
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
async function verifyCookie(c) {
  const j = await getJson(`${API}/x/web-interface/nav`, withCookieOf(c, HDRS))
  const d = j.data || {}
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
function withCookieOf(c, headers) {
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
function normalizeCookie(raw) {
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
async function login(a, b) {
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
  host.log('B站登录成功：' + (info.uname || '(未知用户)'))

  return {
    // 不把 Cookie 当 token 返回给前端 —— 那会让凭据在界面层流转
    token: 'cookie',
    displayName: info.uname || 'B站用户',
    avatar: info.avatar || undefined,
  }
}

/** 当前会话（未登录返回 null） */
async function session() {
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

/* ═══════════════════════ 扫码登录（2026-09-21）═══════════════════════ */

/**
 * 扫码登录 —— 比 Cookie 导入好得多的一步
 *
 * # 为什么值得做
 *
 * 原来的 Cookie 导入要求用户：登录网页版 → F12 → Console →
 * `document.cookie` → 复制一长串 → 粘贴。对普通用户基本不可用。
 * 扫码只需「手机上点两下」，与原生 App 体验一致。
 *
 * # 实测确认的接口语义（2026-09-21，本机直连实测）
 *
 * ```text
 * ① 申请   GET passport.bilibili.com/x/passport-login/web/qrcode/generate
 *          → { code: 0, data: { url, qrcode_key } }
 *
 * ② 轮询   GET passport.bilibili.com/x/passport-login/web/qrcode/poll?qrcode_key=…
 *          → { code: 0, data: { code: <状态>, message } }
 * ```
 *
 * 状态码（`data.code`）：
 * ```text
 *   0      确认成功   ★ 凭据在 **Set-Cookie 响应头**，不在 body
 *   86101  未扫码     （实测拿到）
 *   86038  二维码已失效（实测拿到）
 *   86090  已扫码待确认（文档值；本次未实测到，但语义明确）
 * ```
 *
 * # ★★★ 为什么必须用 `host.http.raw`
 *
 * 成功时 SESSDATA / bili_jct / DedeUserID **只出现在 `Set-Cookie` 头里**，
 * body 是空的 `{"code":0,...}`。普通 `host.http.get` 拿不到响应头，
 * 所以无论如何都读不到登录态 —— 这正是宿主加 `http.raw` 的原因。
 */
const PASSPORT = 'https://passport.bilibili.com'
const QR_GEN = PASSPORT + '/x/passport-login/web/qrcode/generate'
const QR_POLL = PASSPORT + '/x/passport-login/web/qrcode/poll'

/**
 * 申请二维码
 *
 * ⚠️ 只返回 `{ key, url }` —— **不画二维码**。
 *    QuickJS 里没有 canvas/DOM，画不出二维码；
 *    宿主收到 url 后用它的 `qrcode` 依赖渲染成 SVG
 *    （与局域网遥控的二维码同一套）。
 */
async function qrLoginStart() {
  const j = await getJson(QR_GEN, HDRS)
  if (!j || j.code !== 0 || !j.data) {
    throw new Error('network: 申请二维码失败：' + ((j && j.message) || '未知原因'))
  }
  return {
    key: j.data.qrcode_key,
    url: j.data.url,
    hint: '用 B站手机客户端扫描二维码，并在手机上确认登录',
  }
}

/**
 * 从 `Set-Cookie` 数组里取出凭据串
 *
 * # 为什么要挑而非全拼
 *
 * `Set-Cookie` 里除了三个凭据，还有一堆无关的（`buvid3`、`b_nut`、
 * `bili_ticket`…）。全拼进去虽然也能用，但：
 * ```text
 * · 长度翻好几倍（Cookie 头有大小限制）
 * · buvid3 这类设备指纹带进去，反而让 B站 把这次请求
 *   当成"另一个设备"，可能触发风控
 * ```
 * 只保留 `cookie()` 校验与取流真正需要的三个。
 *
 * ⚠️ 必须按 `;` 切且只取**第一个** `name=value` —— 每条 Set-Cookie 后面
 *    还挂着 `Path=/` `Expires=Wed, 21 Oct…` 等属性，
 *    而 Expires 里**含逗号**（这就是宿主把 setCookie 做成数组、
 *    不让我自己拼字符串切分的原因）。
 */
function cookiesFromSetCookie(setCookie) {
  const keep = ['SESSDATA', 'bili_jct', 'DedeUserID']
  const found = {}
  for (const line of setCookie || []) {
    // 只取分号前的 name=value 部分
    const first = String(line).split(';')[0]
    const eq = first.indexOf('=')
    if (eq <= 0) continue
    const name = first.slice(0, eq).trim()
    const value = first.slice(eq + 1).trim()
    if (keep.indexOf(name) >= 0 && value) found[name] = value
  }
  // 顺序固定，便于日志与排查（值本身不打印）
  return keep
    .filter((k) => found[k])
    .map((k) => k + '=' + found[k])
    .join('; ')
}

/**
 * 轮询扫码状态
 *
 * ⚠️ **不在插件里 sleep**：QuickJS 是单线程，sleep 会占住它，
 *    期间的取流/搜索请求全部排队。轮询节奏由**前端**控制（约 2 秒一次）。
 */
async function qrLoginPoll(key) {
  if (!key) {
    return { status: 'failed', message: '缺少二维码凭据，请重新获取' }
  }

  const r = JSON.parse(
    await host.http.raw('GET', QR_POLL + '?qrcode_key=' + encodeURIComponent(key), {
      headers: HDRS,
    }),
  )

  // 网络层失败（宿主返回 __ERR__ 前缀的情况由 raw 的 status 体现）
  if (r.status !== 200) {
    return { status: 'failed', message: '请求失败（HTTP ' + r.status + '）' }
  }

  let j
  try {
    j = JSON.parse(r.body)
  } catch {
    return { status: 'failed', message: '响应不是合法 JSON' }
  }
  if (!j || j.code !== 0 || !j.data) {
    return { status: 'failed', message: (j && j.message) || '未知错误' }
  }

  const code = j.data.code

  // 未扫码
  if (code === 86101) {
    return { status: 'pending', message: '等待扫码…' }
  }

  // 已扫码，等用户在手机上点确认
  if (code === 86090) {
    return { status: 'scanned', message: '已扫码，请在手机上确认' }
  }

  // 过期
  if (code === 86038) {
    return { status: 'expired', message: '二维码已失效，请重新获取' }
  }

  if (code !== 0) {
    // 未知状态码：把原文透出去，便于将来 B站 改协议时排查
    return {
      status: 'failed',
      message: '未识别的状态 ' + code + '：' + (j.data.message || ''),
    }
  }

  // ── 成功：凭据在 Set-Cookie 里 ──
  const c = cookiesFromSetCookie(r.setCookie)
  if (!c) {
    /*
     * 走到这里说明「接口说成功，但没给 Cookie」——
     * 通常是设了代理、或 B站 改了协议。明确报错而不是假装成功，
     * 否则用户会看到"登录成功"但实际什么都没生效。
     */
    return {
      status: 'failed',
      message: '登录成功但未收到凭据（可能被代理拦截，或接口已变更）',
    }
  }

  const info = await verifyCookie(c)
  try {
    host.store.set(COOKIE_KEY, c)
    host.store.set('bili_uname', info.uname || '')
  } catch { /* 存储失败不影响本次登录 */ }
  host.log('B站扫码登录成功：' + (info.uname || '(未知用户)'))

  return {
    status: 'confirmed',
    message: '登录成功',
    session: {
      // 与 Cookie 导入一致：不把凭据当 token 返回给前端
      token: 'cookie',
      displayName: info.uname || 'B站用户',
      avatar: info.avatar || undefined,
    },
  }
}

/** 登出（清掉本地 Cookie） */
async function logout() {
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
async function sessionNeedsRefresh() {
  return false
}

/**
 * 主动校验一次（宿主在"设置页刷新会话状态"或"取流前 ensure"时调）
 *
 * 与 `session()` 的区别：这个**真的发请求**验 Cookie。
 */
async function refreshSession() {
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
    host.log('B站 Cookie 已失效，已清除：' + (e && e.message))
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
async function getJson(url, headers) {
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
  let j
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
  if (j && typeof j.code === 'number' && j.code !== 0) {
    /*
   * 限流要如实标成 network，让宿主按「网络问题」对待（可重试），
   * 而不是当成「这个源坏了」。
   */
    if (j.code === -352 || j.code === -412 || j.code === 412) {
      throw new Error('network: B 站限流，请稍后再试（code ' + j.code + '）')
    }
    throw new Error('B 站接口返回 code=' + j.code + (j.message ? ' ' + j.message : ''))
  }
  return j
}

/**
 * 图片地址归一化 + **请求合适尺寸**
 *
 * # 三种协议形态都存在，实测确认：
 *   · 搜索返回 `//i0.hdslb.com/...`（**协议相对**）
 *   · popular/view 返回 `http://i0.hdslb.com/...`
 *   · 偶尔是 `https://`
 *
 * 统一改成 https：应用页面是 https 语境（tauri.localhost），
 * 混合内容会被 WebView 拦掉，表现是**封面全白**但控制台只有一行警告。
 *
 * ══════════════════════════════════════════════════════════════════
 * ★★★ 2026-10-01：加 `@<宽>w` 后缀（Owner 报「哔哩哔哩封面怎么这么糊」）
 * ══════════════════════════════════════════════════════════════════
 *
 * # 为什么原来会糊
 * ```text
 * B 站原图实测 = 2560×1440（16:9），457 KB
 * 卡片是 2:3 竖版（148×223 逻辑 px）
 * ⇒ 客户端 `BoxFit.cover` 要按**高度**放大 ⇒ 实际绘制 396×223
 * ```
 * ★ 而 Flutter 侧原来只按「布局宽度」解码（`cacheWidth=148`）
 *   ⇒ 解码 148×83 再拉成 396×223 ⇒ **放大 2.68 倍 ⇒ 糊**。
 *
 * Flutter 侧已经修好（改用 `cacheHeight`，见
 * `lib/ui/widgets/cover_image.dart` 的 `coverDecodeHeightFor`）。
 * **本函数这一半修的是另一件事**：
 * ```text
 * 不修 ⇒ 为了 396px 的显示，客户端要**下载 2560px 的原图**（457 KB/张）
 * 修了 ⇒ 只下载 480w（26 KB/张）—— 体积降到 5.7%
 * ```
 * ⇒ 两半合起来才是"既清晰又省流量"：**源头给合适尺寸，
 *   客户端按目标框解码**。
 *
 * # 后缀语法（**实测过，不是照记忆写的**）
 * ```text
 * 同一张 2560×1440 原图：
 *   @480w.jpg          ⇒  480×270   ratio=1.778  26,275 B  ← 保比例 ✔ 用这个
 *   @480w_270h.jpg     ⇒  480×270   ratio=1.778  26,275 B  ← 等价
 *   @480w_270h_1c.jpg  ⇒  480×270   ratio=1.778  26,279 B  ← `1c` = 裁成正好这个框
 *   @480w_1c.jpg       ⇒  480×1440  ratio=0.333  ★ **变形/裁剪，绝不能用**
 * ```
 * ⇒ ★ 只写 `@<宽>w`：**保比例**，且不必知道源图是 16:9 还是 2:3
 *   （写死 `_<高>h` 在源图比例不同时会被裁掉一部分）。
 *
 * # 为什么是 480
 * ```text
 * 桌面 DPR=1.0：卡片绘制宽 396 ⇒ 480 够（余量 21%）
 * 手机 DPR=2.625：卡片绘制宽 396×2.625 ≈ 1040
 *   ⇒ 480 在手机上**略微**不足，但 480 是 26 KB / 1040 要 ~110 KB
 *   ⇒ ★ 取 480 是**体积与清晰度的折中**；要极致清晰可调到 960
 *     （实测 @1280w_720h = 106 KB，仍是原图的 23%）
 * ```
 * ⚠️ 只对**已经带 `@` 后缀的**跳过（那是调用方自己指定过尺寸的），
 *    避免出现 `xxx.jpg@480w@480w` 这种叠加。
 */
function fixPic(u) {
  if (!u) return ''
  let s = u
  if (s.startsWith('//')) s = 'https:' + s
  else if (s.startsWith('http://')) s = 'https://' + s.slice(7)
  // ★ 已带 @ 后缀 ⇒ 调用方自己指定过尺寸，不叠加
  if (s.includes('@')) return s
  /*
   * ⚠️ 用 `?` 分隔的 URL 要先插在 `?` **之前** —— B 站的 `@` 后缀
   *    必须紧跟路径，放在 query 后面会被当成 query 的一部分。
   */
  const q = s.indexOf('?')
  const path = q >= 0 ? s.slice(0, q) : s
  const query = q >= 0 ? s.slice(q) : ''
  // 只给**图片**加后缀（对非图片 URL 无意义）
  if (!/\.(jpg|jpeg|png|webp|gif|avif)$/i.test(path)) return s
  return `${path}@480w${query}`
}

/**
 * 时长转秒
 *
 * ⚠️ B 站的时长有**两种格式**，实测都要处理：
 *   · 搜索接口：字符串 `"129:42"`（mm:ss；超过 1 小时时分位照样堆在分钟位）
 *   · view/popular 接口：数字秒
 */
function toSecs(d) {
  if (typeof d === 'number') return d
  if (typeof d !== 'string' || !d) return 0
  const parts = d.split(':').map((x) => parseInt(x, 10) || 0)
  if (parts.length === 2) return parts[0] * 60 + parts[1]
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2]
  return parts[0] || 0
}

/** 秒 → `12:34` / `1:02:03` */
function fmtDur(sec) {
  if (!sec) return ''
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const s = Math.floor(sec % 60)
  const p = (n) => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${p(m)}:${p(s)}` : `${m}:${p(s)}`
}

/** 播放量：12345 → 1.2万 */
function fmtCount(n) {
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
function cleanTitle(t) {
  return String(t || '')
    .replace(/<\/?em[^>]*>/g, '')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;/g, "'")
}

/** 从 view 结果映射成 MediaItem */
function viewToItem(v) {
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
function arcToItem(a) {
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
const SECTIONS = [
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
async function fetchPopular(pn) {
  /*
   * ps 上限实测：20/50 可以，100 → code=-400。用 20 保证稳。
   */
  const j = await getJson(`${API}/x/web-interface/popular?ps=20&pn=${pn || 1}`)
  const list = (j.data && j.data.list) || []
  return {
    items: list.map(arcToItem),
    page: pn || 1,
    // no_more 是 B 站给的结束标志
    pageCount: j.data && j.data.no_more ? pn || 1 : (pn || 1) + 1,
  }
}

/** 抓某个分区的排行榜 */
async function fetchRank(rid, page) {
  /*
   * ⚠️ `ranking/v2` 是**一次性返回整榜**的（实测 rid=0 给 100 条），
   *    没有分页参数。所以这里只取第 1 页，翻页时如实返回空，
   *    避免给用户「翻到第 2 页看到重复内容」的困惑。
   */
  if (page && page > 1) return { items: [], page, pageCount: 1 }

  const j = await getJson(`${API}/x/web-interface/ranking/v2?rid=${rid}&type=all`)
  const list = (j.data && j.data.list) || []
  return { items: list.map(arcToItem), page: 1, pageCount: 1 }
}

globalThis.plugin = {
  id: 'bilibili',

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
     * 登录方式：**扫码登录**（首选），Cookie 导入（退路）
     *
     * B站 账号密码登录有极验验证码，纯 HTTP 必然失败 ——
     * 所以只有这两条路。扫码是首选（手机上点两下），
     * Cookie 导入保留给"扫码不好使"的场景（如二维码接口被风控）。
     */
    loginHint:
      '用 B站手机客户端扫二维码即可登录（推荐）。' +
      '若扫码不可用，也可以切到「Cookie 导入」：' +
      '在浏览器登录 B站 后按 F12，在 Console 里执行 document.cookie，' +
      '把结果整段粘贴进来。',
    // 两种方式都不需要账号字段
    loginNeedsUsername: false,
    /*
     * ★ 声明支持扫码登录（2026-09-21）
     *
     * 宿主据此在登录弹窗里显示「扫码」页签。
     * 不声明的话，即使下面导出了 qrLoginStart / qrLoginPoll，
     * 界面也不会给入口。
     */
    loginQrSupported: true,
  },

  /* ── 登录相关（宿主按契约调用）── */
  login,
  logout,
  session,
  sessionNeedsRefresh,
  refreshSession,
  /* ── 扫码登录（2026-09-21）── */
  qrLoginStart,
  qrLoginPoll,

  async home() {
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
   *
   * ═══════════════════════════════════════════════════════════════
   *  ★★★ 2026-09-27（task-71）修正：**番剧搜不到** —— 接口选错了
   * ═══════════════════════════════════════════════════════════════
   *
   * # 用户原话（逐字）
   * ```text
   * > bilibili不支持搜索番剧啊,只有自媒体做的视频
   * ```
   *
   * # 根因
   * ```text
   * 旧版**写死** `search_type=video` ⇒ 只搜**用户投稿**（= 自媒体二创）
   * ★ 而番剧/影视是 **PGC** 内容，走**另一个 search_type**
   *   · media_bangumi  番剧
   *   · media_ft       影视（电影/剧集/纪录片）
   * ⇒ 这是纯粹的"接口选错了"，**不是上游限制**。
   * ```
   *
   * # 实测（2026-09-27，游客态，无需登录/签名）
   * ```text
   * media_bangumi  鬼灭之刃   → 11 条  season_id=47836  season_type_name=番剧
   * media_bangumi  间谍过家家 →  6 条  season_id=112827
   * media_ft       鬼灭之刃   →  4 条  season_id=119759
   * media_bangumi  无职转生   →  ★ **0 条**（见下面的"版权分区"说明）
   * ```
   *
   * ⚠️ **如实记录：有些词确实返回 0，那不是 bug**
   * ```text
   * 无职转生 / 海贼王 → media_bangumi 返回 0 条
   * ★ 那是 B 站**版权分区**（该番在大陆区无版权/未上架）⇒ **上游事实**
   * ⇒ 不要试图"修"它，也不要伪造结果。
   * ```
   *
   * # 三个 search_type 的字段差异（决定了怎么映射）
   * ```text
   * video         : bvid / title / pic / author / duration / play
   * media_bangumi : season_id / title / cover / eps[] / season_type_name / areas
   * media_ft      : 同 media_bangumi
   * ★ PGC 两条**没有 bvid**（有 season_id）⇒ id 方案必须分流，见 detail()
   * ★ PGC 的 title **同样带** `<em class="keyword">` ⇒ 必须复用 cleanTitle()
   * ★ PGC 的封面字段叫 `cover`（不是 `pic`）⇒ 不能照抄 fixPic(r.pic)
   * ```
   */
  async search(keyword, page) {
    const p = page || 1
    const kw = encodeURIComponent(keyword)

    /*
     * ★ 三个 search_type **并发**查（串行会让搜索慢 3 倍）
     *
     * ⚠️ 用 `Promise.all` + **各自 catch** —— 单个类型失败不能拖垮整个搜索：
     *   番剧接口偶尔会风控（返回 HTML），而投稿视频仍应正常显示。
     *   ⇒ 失败的当成空数组，并**不影响**其它两类。
     *
     * ⚠️⚠️ 但**三个全失败**必须**抛错**（见下面的 `allFailed` 判定）：
     *   否则用户看到"没有结果"，会以为**这部片子搜不到**，
     *   而真相是**网络/风控坏了** —— 那是**误导**，比报错更糟。
     *   ★ 这是 `Promise.all` + `catch(() => null)` 的**典型陷阱**：
     *     容错做过头 ⇒ 把"故障"伪装成"空结果"。
     *   ★ 实测依据：`.probe/t71_fault_tolerance.mjs` 的用例③
     *     （注入三个全失败 ⇒ 第一版返回 0 条且不抛错 ⇒ 我据此修的）
     */
    const one = (type) =>
      getJson(
        `${API}/x/web-interface/wbi/search/type?search_type=${type}` +
          `&keyword=${kw}&page=${p}`,
      ).catch(() => null)

    const [jv, jb, jf] = await Promise.all([
      one('video'),
      one('media_bangumi'),
      one('media_ft'),
    ])

    // ★ 三个**全**失败 ⇒ 抛错（区分"没搜到"与"网络坏了"）
    if (jv === null && jb === null && jf === null) {
      throw new Error('搜索失败：三个接口都没有响应（可能是网络或风控）')
    }

    const items = []

    /*
     * ── ① 投稿视频（保留原有行为）──
     *
     * ⚠️ 顺序：**PGC 放前面**（见下面的说明），所以这里先算 video 的
     *    items 但**最后** push。用变量存着。
     */
    const videoItems = (((jv || {}).data || {}).result || []).map((r) => ({
      // 搜索给 bvid，但 aid 也在 —— 统一用 bvid（更稳定）
      id: 'av:' + r.bvid,
      title: cleanTitle(r.title),
      cover: fixPic(r.pic),
      subtitle: ['视频', r.author, fmtDur(toSecs(r.duration)),
                 fmtCount(r.play) + '播放']
        .filter(Boolean)
        .join(' · '),
      kind: 'movie',
    }))

    /*
     * ── ② 番剧 / 影视（PGC）──
     *
     * ★★ 为什么 PGC 要**放在视频前面**
     * ```text
     * 用户搜「鬼灭之刃」时，他大概率想要的是**番剧本体**，
     * 而不是"某某 UP 主解说的鬼灭之刃"。
     * ⇒ PGC 结果排在前 ⇒ 用户第一眼看到的就是正片 ✓
     * ★ 这是**排序策略**，不是"过滤掉视频" —— 二创仍然能搜到（在后面）。
     * ```
     *
     * ★ 来源类型标在 `subtitle` 的**最前面** —— 用户一眼能分清
     *   "这是番剧"还是"这是 UP 主做的视频"（task-71 要求②）。
     */
    const pgcItems = (json, typeLabel) => {
      const list = (((json || {}).data || {}).result || [])
      return list.map((r) => {
        const areas = r.areas ? String(r.areas) : ''
        const eps = Array.isArray(r.eps) ? r.eps.length : 0
        return {
          /*
           * ★ id 方案：`ss:<season_id>`（detail 用）
           *   PGC **没有 bvid**，只有 season_id ⇒ 必须单独一个前缀，
           *   否则 detail() 拿它去查 /x/web-interface/view?bvid= 会失败。
           */
          id: 'ss:' + r.season_id,
          title: cleanTitle(r.title),
          // ★ PGC 的封面字段是 `cover`（不是 `pic`）
          cover: fixPic(r.cover),
          subtitle: [typeLabel, areas, eps ? `${eps} 集` : '']
            .filter(Boolean)
            .join(' · '),
          /*
           * ★ kind 只能取 movie / series / live / variety / collection
           *   （Rust 的 MediaKind 枚举）。
           *   番剧/影视**有多集** ⇒ 'series'（这样界面会走"选集"形态）。
           *   ⚠️ 实测有些 season 的 eps 是 1 集（如电影）⇒ 用 'movie' 更准。
           */
          kind: eps > 1 ? 'series' : 'movie',
        }
      })
    }

    // ★ PGC 在前（用户要的通常是正片），视频在后
    items.push(...pgcItems(jb, '番剧'))
    items.push(...pgcItems(jf, '影视'))
    items.push(...videoItems)

    /*
     * ★ 翻页信息取**投稿视频**那一份
     *
     * 理由：PGC 的 `numPages` 语义与 video 不同（而且两类混在一起后，
     * "总页数"本来就无法精确表达）。
     * ★ 用 video 的 pageCount 是**保守**选择：用户至少能一页页翻下去，
     *   而 PGC 结果会在每一页里跟着出现。
     */
    const vd = (jv || {}).data || {}
    return {
      items,
      page: p,
      // numPages 实测上限 50、numResults 1000
      pageCount: vd.numPages || 1,
      total: vd.numResults || undefined,
    }
  },

  /**
   * 详情
   *
   * ⚠️ 多 P 视频**必须用 `pages[i].cid`** —— `data.cid` 只是第 1P 的。
   *    用错了的表现是「选第 3P 播放的却是第 1P」（而且是静默的）。
   *
   * ═══════════════════════════════════════════════════════════════
   *  ★★★ 2026-09-27（task-71）：新增 **PGC（番剧/影视）** 分支
   * ═══════════════════════════════════════════════════════════════
   *
   * # id 分流（两种内容用**两个不同的接口**）
   * ```text
   * av:<bvid>     投稿视频 ⇒ /x/web-interface/view?bvid=
   * ss:<season_id> 番剧/影视 ⇒ /pgc/view/web/season?season_id=
   * ```
   * ★ 为什么不用同一个接口：PGC **没有 bvid**，
   *   拿 season_id 去查 `/x/web-interface/view?bvid=` 必然失败。
   *
   * # 实测（游客态）
   * ```text
   * /pgc/view/web/season?season_id=47836
   *   ⇒ code=0  title=鬼灭之刃 柱训练篇  episodes=**8 集**
   *   每集字段：id(=ep_id) / aid / bvid / cid / title / long_title / duration / cover
   *   ★ 实测 `eps[].id == ep_id`（两处都是 826497）⇒ resolve 直接用 ep_id
   * ⚠️ 不存在的 season_id ⇒ code=**-404** ⇒ **必须处理失败**（不能当成功）
   * ```
   */
  async detail(id) {
    const sid = String(id)

    /*
     * ── PGC 分支（番剧 / 影视）──
     */
    if (sid.startsWith('ss:')) {
      const seasonId = sid.slice(3)
      if (!seasonId) throw new Error('无效的番剧 id')

      const j = await getJson(
        `${API}/pgc/view/web/season?season_id=${encodeURIComponent(seasonId)}`,
      )
      /*
       * ⚠️ 必须查 `code` —— 实测不存在的 season_id 返回 `code=-404`
       *    （HTTP 仍是 200）⇒ 只看 HTTP 状态会把失败当成功，
       *    然后 `result` 是 undefined ⇒ 报一个**误导性**的错。
       */
      if (j.code !== 0 || !j.result) {
        throw new Error(`取不到番剧信息（code=${j.code} ${j.message || ''}）`)
      }
      const r = j.result
      const eps = r.episodes || []
      if (!eps.length) {
        /*
         * ⚠️ 实测有两种"0 集"：
         *   · **未上映/预告**（`new_ep.desc = '敬请期待'`，如 season 119759）
         *   · 真的空数据
         * ⇒ 报错时把 `new_ep` 的说明带上 —— 用户才知道"不是坏了，是还没播"。
         */
        const ne = (r.new_ep && r.new_ep.desc) || ''
        throw new Error(
          ne ? `这部还没有可播放的剧集（${ne}）` : '这部番剧没有可播放的剧集',
        )
      }

      /*
       * ★ 标题优先用 `long_title`（每集的实际名字，如"为了消灭鬼舞辻无惨"），
       *   退回 `title`（往往只是集号 "1"）。
       *
       * ══════════════════════════════════════════════════════════════
       * ★★★ 会员标记（task-71，2026-09-27）
       * ══════════════════════════════════════════════════════════════
       *
       * # 为什么把会员标记编进**标题**
       * ```text
       * `Episode` 结构（Rust `model.rs`）只有 id/title/order/player_id
       *   ⇒ ★ 没有 badge 字段，改 schema 成本大且会影响别的源。
       * 而 `title` 是**自由文本** ⇒ 编进去 = **零 schema 改动** ✓
       * ```
       *
       * # 数据来源：`badge` / `status`（★ 我做了交叉验证）
       * ```text
       * 实测（season 47836 / 45574 / 102261 / 28877 共 4 部，逐集比对）：
       *   badge='会员' 或 status=13  ⇔  playurl 的 is_preview=1 + error_code=-10403
       *   badge=''     且 status=2   ⇔  playurl 的 is_preview=0 + dash.video 非空
       * ⇒ ★★ **10/10 完全一致**（`.probe/t71-badge-verify.py`）
       *   ⇒ 所以可以**在详情阶段就知道哪几集要会员**，**零额外请求** ✓
       * ```
       *
       * # 为什么必须标（用户体验）
       * ```text
       * 不标的话，用户点第 2 集 ⇒ 才弹"需要大会员"
       *   ⇒ ★ "点进去才知道看不了"
       * 标了之后，用户在**选集面板**就能一眼看出哪几集免费 ✓
       * ```
       *
       * ⚠️ 实测：这些番剧**只有第 1 集免费**，第 2 集起全是会员
       *    （鬼灭 8 集：1 免费 + 7 会员；咒术 23 集：1 + 22；芙莉莲 28 集：1 + 27）
       *    ⇒ ★ 所以"能搜到番剧"≠"能看完整部"，报告里要写清。
       */
      const epTitle = (e, i) => {
        const vip = (e.badge === '会员') || (e.status === 13)
        const lt = cleanTitle(e.long_title || '')
        const t = cleanTitle(e.title || '')
        /*
         * 形态：`第N集 · 会员` / `第N集 副标题` / `第N集 副标题 · 会员`
         * ★ 与投稿视频的 `P1 xxx` 风格保持一致（都是"序号 + 说明"）。
         */
        const no = t || String(i + 1)
        let s = `第${no}集`
        if (lt) s += ` ${lt}`
        if (vip) s += ' · 会员'
        return s
      }

      return {
        id: 'ss:' + seasonId,
        title: cleanTitle(r.title),
        cover: fixPic(r.cover),
        description: cleanTitle(r.evaluate || r.desc || ''),
        kind: eps.length > 1 ? 'series' : 'movie',
        meta: {
          /*
           * ⚠️ `meta` 的 key **必须用 ASCII**（见视频分支的同款说明）
           *
           * ⚠️⚠️ `areas` 的**类型不稳定** —— 实测：
           *   · 搜索结果（`media_bangumi` 的 `result[]`）里是**字符串** `'日本'`
           *   · season 详情里是**数组** `['日本']`
           *   ⇒ ★ 我第一版直接 `.join(' / ')` ⇒
           *      `TypeError: String(...).join is not a function`（测试抓到的）
           *   ⇒ 必须**两种都处理**（这是本仓"接口字段类型不稳定"的又一例）。
           */
          areas: Array.isArray(r.areas)
            ? r.areas.join(' / ')
            : String(r.areas || ''),
          type: cleanTitle(r.type_name || ''),
          episodes: `${eps.length} 集`,
          // ★ 如实标注清晰度上限（见 resolve 的实测说明）
          qualityNote: '游客最高 480P',
        },
        /*
         * ★ 与视频分支同形：一条线路（B 站的清晰度在取流时选，不是"线路"）
         */
        sources: [{ code: 'default', title: '哔哩哔哩', count: eps.length }],
        episodes: eps.map((e, i) => ({
          /*
           * ★★ 剧集 id = **ep_id**（字符串化）
           *
           * 理由：`resolve()` 只需要 ep_id（PGC playurl 的参数就是它）。
           * ★ 实测 `eps[].id == ep_id`（826497）⇒ 直接用它，不要拼其它东西。
           *   而 `season_id` 已经在上面的**媒体 id** 里了，无需重复。
           */
          id: String(e.id),
          title: epTitle(e, i),
          order: i + 1,
          // ★ 封面也带上（有些 UI 会显示每集缩略图）
          cover: fixPic(e.cover),
        })),
      }
    }

    /*
     * ── 投稿视频分支（原有行为）──
     */
    const bvid = sid.replace(/^av:/, '')
    if (!bvid) throw new Error('无效的视频 id')

    const j = await getJson(`${API}/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`)
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
     * id 有三种形态：
     *   · `bvid|cid`（来自 detail 的剧集列表 —— 投稿视频）
     *   · `bvid`（直接播放，用第 1P 的 cid）—— 需要先查一次详情
     *   · `ep_id`（纯数字 —— 来自 PGC 的剧集列表，task-71 新增）
     *
     * ═══════════════════════════════════════════════════════════════
     *  ★★★ 2026-09-27（task-71）：PGC（番剧/影视）取流
     * ═══════════════════════════════════════════════════════════════
     *
     * # 为什么番剧**不能**用 `/x/player/playurl`
     * ```text
     * 那是**投稿视频**的接口（参数 bvid + cid）。
     * ★ 番剧走 `/pgc/player/web/playurl`（参数 **ep_id**）。
     * ⇒ 两个 endpoint，两套参数，**必须分流**。
     * ```
     *
     * # 实测（2026-09-27，游客态，`.probe/t71-streams.txt`）
     * ```text
     * ep_id=826497（鬼灭之刃 柱训练篇 第1集）:
     *   fnval=16   ⇒ dash.video=4 条  avc1 档位=[16,32]
     *   fnval=4048 ⇒ dash.video=6 条  avc1 档位=[16,32]   ← ★ 多 2 条 AV1 轨
     *   fnval=64/128/1024 ⇒ dash.video=**0**  ← ★ 完全不返回流
     *   逐流：
     *     32  avc1.64001F  256240  852x480   ← ★ **游客最高就是 480P**
     *     16  avc1.64001E  147940  640x360
     *   ★ `accept_quality=[120,112,80,64,32,16]` 只是"该剧有这些档"，
     *     游客的 `dash` 里**不返回** ⇒ **480P 是上游事实，不是 bug**
     * ```
     *
     * ⚠️ **番剧的 fnval 与投稿视频相反**（不能照抄！）
     * ```text
     * 投稿视频：fnval=16 + try_look=1 ⇒ avc1 到 **80(1080P)** ✓（现有代码，正确）
     *           fnval=4048（不带 try_look）⇒ 退到 [16,32]
     * 番剧    ：fnval=4048 ⇒ 6 条（含 AV1）；fnval=16 ⇒ 4 条
     *           ★ 两者 avc1 上限**都是 480P**（try_look 对番剧无效）
     * ⇒ 番剧用 **4048**（多拿 AV1 轨；将来播放器支持 AV1 时能用上）
     * ```
     *
     * ⚠️⚠️ **8 集里只有第 1 集游客可看**（实测）
     * ```text
     * ep_id=826497 ⇒ is_preview=0  error_code=0        dash.video=4   ← 能看
     * ep_id=826498 ⇒ is_preview=1  error_code=-10403   dash.video=0   ← 第 2 集起
     * （第 3~8 集同样 is_preview=1 + error_code=-10403）
     * ★ `-10403` = 需要大会员/地区限制
     * ⇒ ★★ 下面**复用**投稿分支已有的 `isPreview` 拦截，
     *   用户会看到明确提示，而不是**静默黑屏**。
     * ```
     */
    const epRaw = String((req && req.episodeId) || id || '')

    /*
     * ★ PGC 判定：纯数字（ep_id），或带 `ss:` 前缀
     *   ⚠️ 不能用 `includes('|')` 之外的方式 —— 投稿的剧集 id 是 `bvid|cid`，
     *     而 PGC 的是纯数字 ⇒ 两者**天然可区分**（bvid 一定含字母）。
     */
    const isPgc = /^\d+$/.test(epRaw) || epRaw.startsWith('ss:')
    if (isPgc) {
      /*
       * ══════════════════════════════════════════════════════════════
       * ★★★ 真机 bug 修复（2026-09-27）：首播时 `episodeId` 是 **null**
       * ══════════════════════════════════════════════════════════════
       *
       * # 真机现象
       * ```text
       * 详情页正常（8 集 + 会员标记），但**一点播放就失败**：
       *   SourinCoreException(other): B 站接口返回 code=-404 啥都木有
       * ```
       *
       * # 根因（我手工复现了三种入参，与真机报错逐字对上）
       * ```text
       *   ep_id=ss:47836  ⇒ code=-400 请求错误
       *   ep_id=47836     ⇒ code=-404 啥都木有     ← ★★ 与真机**逐字相同**
       *   ep_id=826497    ⇒ code=0 success ✓
       * ⇒ 说明插件拿到的"ep_id"是 **47836（season_id）**，不是 826497（ep_id）
       * ```
       * 为什么？
       * ```text
       * `player_page.dart` L1884-1892 起播时：
       *   PlayRequest(episodeId: **widget.episodeId**)
       * ★ 而从**详情页首次点播放**时，`widget.episodeId` 是 **null**
       *   （用户还没选集 ⇒ 没有具体集 id）
       * ⇒ 于是 `req.episodeId` 为 null ⇒ 我的代码回退到 `id`
       * ⇒ 而 `id` 是**媒体 id** `ss:47836`（Rust 侧 `strip_prefix` 只剥
       *   `bilibili:`，**不剥 `ss:`**）⇒ 于是把 season_id 当 ep_id 用了。
       * ```
       *
       * # 修法：`ss:` 只表示"这是哪一部"，**不能**当 ep_id
       * ```text
       * 拿到 `ss:<season_id>` 时 ⇒ 先查 `/pgc/view/web/season` 拿**第 1 集**的 ep_id，
       * 再用它取流。语义上正是"从第 1 集开始播"（用户没选集时的合理默认）。
       * ★ 这与投稿视频分支的行为**对称**：那里没有 cid 时也会
       *   "查一次详情拿第 1P"（见下面的 `if (!cid)`）。
       * ```
       */
      let epId = epRaw.replace(/^ss:/, '').split('|')[0]
      if (epRaw.startsWith('ss:')) {
        // ★ 传入的是**媒体 id**（season_id）⇒ 需要解析出第 1 集的 ep_id
        const js = await getJson(
          `${API}/pgc/view/web/season?season_id=${encodeURIComponent(epId)}`,
        )
        const eps = (js.result && js.result.episodes) || []
        if (!eps.length) throw new Error('这部番剧没有可播放的剧集')
        epId = String(eps[0].id)
      }
      if (!/^\d+$/.test(epId)) throw new Error('无效的番剧剧集 id')

      const jp = await getJson(
        `${API}/pgc/player/web/playurl?ep_id=${encodeURIComponent(epId)}` +
          '&qn=120&fnval=4048&fnver=0&fourk=1',
      )
      /*
       * ⚠️ PGC 的返回体在 **`result`**（不是 `data`）—— 与投稿视频不同。
       *   `code != 0` 时 `result` 为 undefined ⇒ 必须显式查。
       */
      if (jp.code !== 0 || !jp.result) {
        throw new Error(
          `取不到番剧播放地址（code=${jp.code} ${jp.message || ''}）`,
        )
      }
      return buildCandidates(jp.result, '哔哩哔哩番剧')
    }

    /*
     * ── 投稿视频（原有行为）──
     */
    let bvid = ''
    let cid = ''

    const ep = epRaw
    if (String(ep).includes('|')) {
      const parts = String(ep).split('|')
      bvid = parts[0]
      cid = parts[1]
    } else {
      bvid = String(ep).replace(/^av:/, '').replace(/^\|/, '')
    }
    bvid = bvid.replace(/^av:/, '')
    if (!bvid) throw new Error('无效的视频 id')

    // 没有 cid 就查一次详情拿第 1P
    if (!cid) {
      const j = await getJson(`${API}/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`)
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
    const j = await getJson(
      `${API}/x/player/playurl?bvid=${encodeURIComponent(bvid)}&cid=${cid}` +
        `&qn=120&fnval=16&fnver=0&fourk=1&try_look=1`,
    )
    const d = j.data
    if (!d) throw new Error('取不到播放地址')

    return buildCandidates(d, '哔哩哔哩')
  },
}
