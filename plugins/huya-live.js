/**
 * @id          huya-live
 * @name        虎牙直播
 * @version     1.0.0
 * @author      sourin
 * @description 虎牙直播（游客态，无需登录）：热门频道列表 + FLV 取流
 * @homepage    https://www.huya.com
 *
 * ═══════════════════════════════════════════════════════════════
 *  实测记录（2026-10-14，真机 curl + ffprobe）
 *
 *  # ① 频道列表：`cache.php?m=LiveList&do=getLiveListByPage`
 *
 *  ```text
 *  GET https://www.huya.com/cache.php?m=LiveList&do=getLiveListByPage&gameId=1&tagAll=0&page=1
 *  → HTTP 200, application/json
 *  → { status:200, data:{ page, pageSize:120, totalPage, totalCount,
 *                         datas:[ { gameFullName, gid, nick, roomName,
 *                                    screenshot, profileRoom, privateHost, ... } ] } }
 *  实测 page=1 返回 120 条真实房间。
 *  ```
 *
 *  ⚠️ 注意：`/cache.php?m=LiveList&do=liveSearch`（旧写法）现在**返回 HTML**
 *    （被 WAF 拦），README 里的老参数已失效 —— 以本文件的实测 URL 为准。
 *
 *  # ② 取流：房间页 SSR 里直接嵌了 stream 信息
 *
 *  ```text
 *  GET https://www.huya.com/<profileRoom>   （浏览器 UA + Referer）
 *  → 页面里有 `var hyPlayerConfig = { ... stream: {"data":[{
 *        gameLiveInfo: {...},
 *        gameStreamInfoList: [ { sCdnType:"AL"/"TX"/"HS",
 *                                sStreamName, sFlvUrl, sFlvUrlSuffix, sFlvAntiCode,
 *                                sHlsUrl,  sHlsUrlSuffix, sHlsAntiCode, uid ... } ]
 *      }]}}
 *  ```
 *
 *  # ③ ★ 实测：**FLV 能播，HLS 403**
 *
 *  ```text
 *  FLV  URL = sFlvUrl + '/' + sStreamName + '.' + sFlvUrlSuffix + '?' + sFlvAntiCode
 *    → HTTP 302 → bytefcdnrd.com 节点 → HTTP 200, Content-Type: video/x-flv
 *    → ffprobe: codec_name=h264, width=1920, height=1080 + aac  ✅
 *
 *  HLS  URL = sHlsUrl + '/' + sStreamName + '.' + sHlsUrlSuffix + '?' + sHlsAntiCode
 *    → HTTP 403 Forbidden (Tengine)   ❌ **即使带同一个 anticode 也一样**
 *  ```
 *  ⇒ 所以本插件**只输出 FLV**，把 m3u8 那条线路过滤掉
 *    （不这么做的话用户会看到一条永远 403 的线路）。
 *
 *  # ③b `kind` 为什么写 **`mp4`** 而不是 `flv`
 *
 *  ```text
 *  宿主的 `StreamKind`（model.rs）只有 hls / dash / mp4 / web_embed / audio_only
 *  —— **没有 flv**。实测写 'flv' 会直接被 serde 拒：
 *    "unknown variant `flv`, expected one of `hls`, `dash`, `mp4`, ..."
 *  ```
 *  FLV 与 MP4 都走**原生 `<video>`**（不像 HLS/DASH 要走 MSE），
 *  所以在宿主的分类里 `mp4` 就是"原生播放"这一档 —— FLV 归它。
 *  ★ 这不是"凑合填一个能过的值"：`from_url()` 的注释写明了它的口径是
 *    「只有 .m3u8/.mpd 才判 HLS/DASH，**其余一律 Mp4**（容错最高的兜底）」，
 *    我们这里是按同一个口径显式声明，而不是让它去猜。
 *
 *  # ④ `headers` + `notWebReady` 是**必须**的
 *
 *  ```text
 *  · 不光是防盗链 —— 取流 URL 里有 `wsSecret`/`wsTime` 签名，且 CDN 会
 *    校验 Referer 与 UA。
 *  · WebView 里 <video> **加不了请求头** ⇒ 必须 notWebReady:true
 *    让宿主走本地代理转发（见 bilibili.js 里那段长注释，同一套机制）。
 *  ```
 *
 *  # ⑤ 虎牙**不返回签名有效期**，但 `wsTime` 是 Unix 秒级时间戳
 *
 *  ```text
 *  实测 wsTime=6acee9a1 ≈ 1791945121（2026-10-14）
 *  ⇒ 签名有窗口期。所以 liveStream() **每次都现取房间页**，
 *    不缓存 URL（缓存了会拿到过期签名 → 403）。
 *  ```
 *
 *  # ⑥ ⚠️ CDN 有"冷流"抖动 —— 偶尔 403，重试即可
 *
 *  ```text
 *  实测同一条新鲜 URL：第一次 200（video/x-flv，1.1 MB，h264+aac），
 *  紧接着用同一条再要 → 403。
 *  302 的 Location 里带 `ali_dispatch_cold_stream=on` —— 说明命中冷节点。
 *  ⇒ 这**不是**插件取错了 URL：换一条新 URL（重开房间页）再试就好。
 *    所以 liveStream() 返回**多条 CDN 线路**（AL/TX/HS）也顺带成了容错：
 *    某条冷流 403 时播放器/用户可换下一条。
 *  ```
 * ═══════════════════════════════════════════════════════════════
 */

/** 浏览器 UA —— 虎牙对非浏览器 UA 返回错误页 / 403 */
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

const HDRS = { 'User-Agent': UA, Referer: 'https://www.huya.com/' }

/** 列表接口（实测可用；liveSearch 旧写法已返回 HTML） */
const LIST_API =
  'https://www.huya.com/cache.php?m=LiveList&do=getLiveListByPage&tagAll=0&page=1&gameId='

/**
 * 首页展示的游戏分区（gid → 中文名）
 *
 * 虎牙首页的主题区块就是这几个 gid（实测从首页 HTML 的
 * `hotGame4m4` 里取的）。给一个够用的热门子集即可 —— 需求是
 * "能拿到热门/推荐一页"，不是全量。
 */
const GAMES = [
  { gid: '1', name: '英雄联盟' },
  { gid: '2', name: '地下城与勇士' },
  { gid: '862', name: 'CS2' },
  { gid: '2793', name: '天天吃鸡' },
  { gid: '3203', name: '和平精英' },
  { gid: '2336', name: '王者荣耀' },
  { gid: '1732', name: '我的世界' },
  { gid: '9449', name: '三角洲行动' },
  { gid: '1663', name: '星秀' },
  { gid: '2165', name: '户外' },
]

const CACHE_KEY = 'list_v1'
const CACHE_TTL = 10 * 60 * 1000 // 10 分钟

/** GET 文本；宿主用 `__ERR__` 前缀表示网络失败（见 demo.js 的说明） */
async function getText(url, referer) {
  const text = await host.http.get(url, {
    headers: referer ? { 'User-Agent': UA, Referer: referer } : HDRS,
  })
  if (typeof text === 'string' && text.startsWith('__ERR__')) {
    throw new Error('network: ' + text.slice(7))
  }
  return text
}

/** 房间页是 HTML，不是 JSON：解析出 `stream: {...}` 那段 JSON */
function parseRoomStream(html) {
  const i = html.indexOf('stream: {')
  if (i < 0) return null
  const s = html.slice(i + 'stream: '.length)
  // 括号配平扫出第一个完整对象（HTML 里还有别的 `}`，不能简单取到末尾）
  let depth = 0
  let start = -1
  for (let j = 0; j < s.length; j++) {
    const ch = s[j]
    if (ch === '{') {
      if (depth === 0) start = j
      depth++
    } else if (ch === '}') {
      depth--
      if (depth === 0) {
        try {
          return JSON.parse(s.slice(start, j + 1))
        } catch (e) {
          return null
        }
      }
    }
  }
  return null
}

/** 拉一个分区的房间（并发不限，虎牙不封这个接口） */
async function fetchGame(game) {
  const text = await getText(LIST_API + game.gid, 'https://www.huya.com/g/' + game.gid)
  let d
  try {
    d = JSON.parse(text)
  } catch (e) {
    throw new Error('parse: 列表不是 JSON — ' + text.slice(0, 120))
  }
  if (!d || Number(d.status) !== 200 || !d.data || !d.data.datas) {
    throw new Error('parse: 列表结构变了（status=' + (d && d.status) + '）')
  }
  return d.data.datas.map((r) => ({
    id: String(r.profileRoom),
    name: r.nick || r.privateHost || ('房间 ' + r.profileRoom),
    logo: r.screenshot || undefined,
    group: game.name,
    // 附带房间标题，liveChannels 会拼进 name（用户在列表里想看到"在播什么"）
    _title: r.roomName || '',
  }))
}

/** 读缓存（10 分钟）；过期则重新拉全部分区 */
async function loadChannels(force) {
  if (!force) {
    const raw = host.store.get(CACHE_KEY)
    if (raw) {
      try {
        const c = JSON.parse(raw)
        if (c && c.at && Date.now() - c.at < CACHE_TTL && c.list && c.list.length) {
          return c.list
        }
      } catch (e) {
        /* 缓存坏了就当没有 */
      }
    }
  }

  const out = []
  for (const g of GAMES) {
    try {
      const rooms = await fetchGame(g)
      for (const r of rooms) out.push(r)
    } catch (e) {
      // 单个分区失败不影响整体（分区下架 / 接口抖动都可能）
      host.log.warn('虎牙分区 ' + g.name + ' 拉取失败: ' + (e && e.message))
    }
  }
  if (!out.length) {
    throw new Error('network: 虎牙频道列表拉不到（所有分区都失败）')
  }
  host.store.set(CACHE_KEY, JSON.stringify({ at: Date.now(), list: out }))
  host.log.info('虎牙直播列表已更新: ' + out.length + ' 个频道')
  return out
}

globalThis.plugin = {
  id: 'huya-live',

  capabilities: {
    vod: false,
    live: true,
    epg: false,
    search: false,
    // 游客可看 ⇒ false
    loginRequired: false,
  },

  /**
   * 直播频道列表
   *
   * 把房间标题拼进 name —— 虎牙的"频道"其实是主播房间，
   * 只显示主播名的话用户不知道在播什么。
   */
  async liveChannels() {
    const all = await loadChannels(false)
    return all.map((c) => ({
      id: c.id,
      name: c._title ? c.name + ' · ' + c._title : c.name,
      logo: c.logo,
      group: c.group,
    }))
  },

  /**
   * 取流
   *
   * ★ 每次现取房间页 —— 不缓存 URL（签名会过期，见文件头 ④/⑤）。
   *   "缓存列表、不缓存取流"是有意的：列表 10 分钟一变，URL 分钟级过期。
   */
  async liveStream(channelId) {
    const html = await getText('https://www.huya.com/' + channelId, 'https://www.huya.com/')
    const data = parseRoomStream(html)
    if (!data || !data.data || !data.data.length) {
      throw new Error(
        'not_found: 拿不到房间 ' + channelId + ' 的流信息（未开播 / 页面结构变了 / 主播已下播）',
      )
    }
    const room = data.data[0]
    const lines = room.gameStreamInfoList || []
    if (!lines.length) {
      throw new Error('not_found: 房间 ' + channelId + ' 没有可用线路（可能未开播）')
    }

    const out = []
    const seen = {}
    for (const s of lines) {
      // ★ 只取 FLV：实测 HLS(m3u8) 恒 403，放进去等于给用户一条死线路
      if (!s.sFlvUrl || !s.sStreamName) continue
      // CDN 去重（AL13/TX15 这类是同域名的不同线路，URL 可能一样）
      const url =
        s.sFlvUrl + '/' + s.sStreamName + '.' + s.sFlvUrlSuffix + '?' + s.sFlvAntiCode
      if (seen[url]) continue
      seen[url] = 1
      out.push({
        url,
        // ★ 'mp4' 而不是 'flv' —— 宿主没有 flv 这个 kind（见文件头 ③b）
        kind: 'mp4',
        quality: room.gameLiveInfo && room.gameLiveInfo.isBluRay ? '蓝光' : '标清',
        label: '虎牙 ' + (s.sCdnType || '线路'),
        // ★ 必须：CDN 校验 Referer+UA，且 WebView 加不了头 ⇒ 走本地代理
        headers: HDRS,
        notWebReady: true,
      })
    }

    if (!out.length) {
      throw new Error('not_found: 房间 ' + channelId + ' 的线路都不可用')
    }
    return out
  },
}
