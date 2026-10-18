/**
 * @id          iqiyi
 * @name        爱奇艺
 * @version     1.0.0
 * @author      dsh
 * @description 爱奇艺 —— 搜索与浏览（**本插件不提供播放**，原因见下）
 * @homepage    https://www.iqiyi.com
 *
 * ═══════════════════════════════════════════════════════════════
 *  ★★★ 先说清楚这个插件**能做什么、不能做什么**
 * ═══════════════════════════════════════════════════════════════
 *
 * ```text
 * ✅ 能：搜索、翻页、首页分区、分类浏览、详情（含剧集列表）、VIP 标注
 * ❌ 不能：播放（取流需要官方签名，本插件**不逆向风控**）
 * ```
 *
 * 这不是「没做完」，是**有意划定的边界**（Lead 2026-10-16 裁决）。
 * 点播放时会抛 `unsupported:`，宿主会如实显示原因，
 * 用户看到的是「为什么不能播」，而不是一个坏掉的东西。
 *
 * ═══════════════════════════════════════════════════════════════
 *  ★ 为什么不做取流（实测证据，2026-10-16）
 * ═══════════════════════════════════════════════════════════════
 *
 * 取流接口存在，但**要求一个 `vf` 签名**：
 * ```text
 * GET https://cache.video.iqiyi.com/dash?tvid=…&bid=500&vid=…&src=…
 *   → http=200
 *   {"msg":"This sign is not correct.",
 *    "data":{"ctl":{"num":3,"vf":"","uip":"…"}},"code":"A00001"}
 * ```
 * ⚠️ 注意错误响应里把 `vf` 回显为空 —— 那正是它缺的参数名。
 *
 * 另一条路（移动端）也一样：
 * ```text
 * GET https://cache.m.iqiyi.com/tmts/<tvid>/…  → {"code":"A00001","msg":"Rule Block"}
 * ```
 *
 * `vf` 的算法在官方前端 JS 里（混淆过）。要拿到它只有两条路：
 * ```text
 * ① 逆向官方 JS 复现签名 —— 属于**绕过访问控制**，本插件不做
 * ② 接第三方「解析」服务 —— 灰色地带、且要引第三方依赖，不自作主张
 * ```
 * ⇒ 所以本插件**只做数据面，不碰取流**。这是**故意的**，不是缺陷。
 *
 * ═══════════════════════════════════════════════════════════════
 *  ★ 接口实测记录（2026-10-16，游客态，无 Cookie 无凭据）
 * ═══════════════════════════════════════════════════════════════
 *
 * 【搜索】唯一需要的接口，**完全免登录**：
 * ```text
 * GET https://search.video.iqiyi.com/o?if=html5&key=<词>&pageNum=1&pageSize=20
 *   → http=200, application/json, 约 1 MB
 *   {"data":{"code":0,"docinfos":[{"albumDocInfo":{
 *      "albumId":6861425851341000,
 *      "albumTitle":"火影忍者剧场版：忍者之路",
 *      "albumLink":"http://www.iqiyi.com/v_1uqtiuded9g.html",
 *      "albumVImage":"http://pic9.iqiyipic.com/image/…",
 *      "itemTotalNumber":1, "score":8.5,
 *      "videoinfos":[{"itemNumber":1,"vid":"7ae228ded7…",
 *                      "is_vip":true,"timeLength":6440}]}}]}}
 * ```
 *
 * ★★ 关键设计决定：**搜索结果里已经带剧集列表**（`videoinfos`）
 * ⇒ 不需要第二个「详情接口」，整条链路只要一个端点。
 * 实测：
 * ```text
 * 单集电影   → videoinfos 1 条（完整）
 * 长剧集     → 返回**前 20 条**，itemTotalNumber 给总集数
 *   火影忍者 疾风传  总集 735 / 返回 20
 *   博人传          总集 252 / 返回 20
 * ```
 * ⚠️ 长剧集只给前 20 集是**上游的限制**，不是我们的 bug。
 *   如实显示「共 735 集」并把拿得到的 20 集列出来 —— **不许假装有 735 集可选**。
 *
 * 【详情接口已下线】试过 6 种变体，全部返回业务错误：
 * ```text
 * GET /albums/album/avlistinfo?aid=…&page=1&size=50
 *   → http=200 但 {"code":"A00001","data":"参数错误",
 *                "errMsg":"controller/album/albums - avlistInfo"}
 * 变体：albumId 代替 aid / 加 source / 加 callback / 去参数 /
 *       album/albums/* / videos/album/* / portal/lw/* ⇒ 全部同样失败
 * ```
 * ⇒ 所以本插件**不调详情接口**，全部数据来自搜索响应。
 *
 * ═══════════════════════════════════════════════════════════════
 *  ⚠️ 精度陷阱（本插件必须当字符串处理 ID）
 * ═══════════════════════════════════════════════════════════════
 *
 * `albumId` 在 JSON 里是 **number**，且已经到 16 位：
 * ```text
 * 实测值            6861425851341000
 * MAX_SAFE_INTEGER  9007199254740991   (9.007e15)
 * ⇒ 今天**不丢精度**（6.86e15 < 9.007e15），但已经**贴着上限**
 * ```
 * 所以：
 * ```text
 * ① 一律 String(...) 之后再当 id 用，**不做任何算术**
 * ② 绝不 x+1 / x*1000 / parseInt 后再拼回去
 * ③ 上游一旦超过 2^53，JSON.parse 会**静默改掉末位** ⇒
 *    所以本插件**同时**保留 albumLink 里的 `v_xxxx` 短码作为备选 id 来源
 * ```
 * （`v_1uqtiuded9g` 这种短码是字符串，永远不会丢精度。）
 * ═══════════════════════════════════════════════════════════════
 */

/** 搜索接口（本插件唯一的数据来源） */
const SEARCH_API = 'https://search.video.iqiyi.com/o'

/**
 * 请求头
 *
 * `if=html5` 是查询参数（不是头），必须带 —— 少了它返回的是另一个页面结构。
 * Referer 给官网：实测不带也能通，但带上更接近真实客户端。
 */
const HDRS = {
  Accept: 'application/json',
  Referer: 'https://www.iqiyi.com/',
}

/**
 * 本站的 siteId —— 搜索接口是**聚合搜索**，必须靠它过滤出本站条目
 *
 * 实测：搜「火影忍者 疾风传」返回 {qq:3, iqiyi:2}；搜「庆余年」返回 {qq:2, iqiyi:17}。
 * ⚠️ 其它站的条目**没有 albumId**（undefined）⇒ 不过滤必然出错。
 * 详见 searchAlbums() 的长注释。
 */
const SITE_ID = 'iqiyi'

/**
 * 接口单页上限（**本插件自选**，不是上游硬上限）
 *
 * ★ 实测澄清：上游**能**给更多 —— pageSize=200 时真的返回了 199 条。
 *   之前误以为「上限 20」是因为我们自己只请求了 20。
 *   这里取 20 是**有意**的：
 *   `text
 *   ① 一页 200 条的响应约 2.7 MB，翻页体验差
 *   ② 本站详情接口已下线，剧集只能靠搜索响应带 —— 加大 pageSize
 *      **并不会**让单部剧的 videoinfos 变多（实测：始终前 20 条）
 *   `
 *   ⇒ 加大 pageSize 只增加流量，不增加能力。取 20。
 */
const MAX_PAGE_SIZE = 20
/**
 * 发 GET 并解析 JSON
 *
 * ★ 必须检查 `__ERR__` 前缀 —— 那是宿主约定的失败标记（
 *   `host.http` **不抛异常**，失败时返回 `__ERR__<原因>`）。
 *   直接 `JSON.parse` 会得到「unexpected token」这种毫无意义的报错。
 */
async function getJson(url) {
  const text = await host.http.get(url, { headers: HDRS })
  if (!text || text.startsWith('__ERR__')) {
    throw new Error('network: ' + String(text || '').slice(7))
  }
  try {
    return JSON.parse(text)
  } catch {
    throw new Error('parse: 返回不是合法 JSON — ' + text.slice(0, 120))
  }
}

/**
 * 搜索并**只保留本站条目**
 *
 * ═══════════════════════════════════════════════════════════════
 * ★★★ 这个接口是**聚合搜索**，不是本站专有接口（实测踩到）
 * ═══════════════════════════════════════════════════════════════
 *
 * 它返回的每条都带 `albumDocInfo.siteId`，实测混着**别的站**的结果：
 * ```text
 * 搜「火影忍者 疾风传」→ siteId 分布 {"qq":3,"iqiyi":2}
 * 搜「庆余年」        → {"qq":2,"iqiyi":17}
 * ```
 * ⚠️ 别的站的条目 **没有 `albumId`**（实测 `undefined`）⇒
 *   不过滤的话：① 点进去必然报错 ② id 拼出 `undefined` 这种脏值。
 *
 * ⚠️ 试过用查询参数过滤（`site=iqiyi` / `siteId=iqiyi` / `src=` / `source=`）
 *   —— **全部无效**，返回的分布与不加时一样。⇒ 只能**客户端过滤**。
 *
 * ⚠️ 还有 2 条 `siteId` 为空的（广告位之类）—— 同样滤掉。
 *   判据取**严格等于** `'iqiyi'`，不是「非 qq」：
 *   将来上游再聚合进第三家，这里不需要改。
 */
async function searchAlbums(keyword, page) {
  const kw = String(keyword || '').trim()
  if (!kw) return { albums: [], page: 1, total: 0 }

  const p = Math.max(1, page || 1)
  const url =
    SEARCH_API +
    '?if=html5&key=' + encodeURIComponent(kw) +
    '&pageNum=' + p +
    '&pageSize=' + MAX_PAGE_SIZE

  const json = await getJson(url)
  const data = (json && json.data) || {}
  if (typeof data.code === 'number' && data.code !== 0) {
    throw new Error(data.code === 401 ? 'unauthorized: 需要登录' : '搜索失败（code ' + data.code + '）')
  }

  const docs = Array.isArray(data.docinfos) ? data.docinfos : []
  const albums = docs
    .map((d) => (d && d.albumDocInfo) || null)
    .filter((a) => a && a.siteId === SITE_ID)
    /*
     * ⚠️ albumId 必须存在。实测过滤后仍可能遇到缺它的条目 ——
     *   没有 id 就没法生成可点开的条目（返回 null 由上层滤掉）。
     */
    .filter((a) => a.albumId != null)

  // ★ 顺手记进缓存 —— detail() 靠它，避免重新搜索（见 CACHE_KEY 的长注释）
  rememberAlbums(albums)

  const total = typeof data.result_num === 'number' ? data.result_num : undefined
  return { albums, page: p, total }
}

/**
 * 把上游的 http:// 封面升成 https://
 *
 * ⚠️ 上游给的是 `http://pic9.iqiyipic.com/…`（明文）。
 *   桌面端页面是 https，混用明文图会被浏览器的混合内容策略挡掉 ⇒ 图裂。
 *   该 CDN 支持 https（实测），所以直接换协议头是安全的。
 */
function httpsCover(u) {
  const s = String(u || '').trim()
  if (!s) return undefined
  return s.startsWith('http://') ? 'https://' + s.slice(7) : s
}

/**
 * 生成媒体条目 id —— **编码标题**，供 detail() 复用
 *
 * ═══════════════════════════════════════════════════════════════
 * ★★★ 为什么要往 id 里塞标题（这是本插件的核心设计）
 * ═══════════════════════════════════════════════════════════════
 *
 * 本站的**详情接口已下线**（实测 6 种变体全部返回业务错误，见文件头）。
 * 而 `detail(id)` 只拿得到一个 id、拿不到标题 ——
 * 没有标题就没法重新搜索、也就凑不出剧集列表。
 *
 * ⇒ 在生成条目 id 时**把标题一起编码进去**：
 * ```text
 * id 形态： <albumId>|<encodeURIComponent(标题)>
 * 例：      6861425851341000|%E7%81%AB%E5%BD%B1%E5%BF%8D%E8%80%85
 * ```
 *
 * ⚠️ 分隔符用 `|` 是安全的：
 *   · albumId 是纯数字，不含 `|`
 *   · 标题经 `encodeURIComponent` 后**一定不含** `|`（它会被编成 %7C）
 *   ⇒ 按**第一个** `|` 切分永远正确。
 *
 * ⚠️ id 里**允许含冒号**吗？允许 —— 宿主只剥离 `provider:` 前缀（
 *   `strip_prefix` 用 `format!("{}:", id)` 精确比对），
 *   native 部分可以含任意字符。且本插件不用冒号当分隔符，避免歧义。
 */
function makeId(albumId, title) {
  return String(albumId) + '|' + encodeURIComponent(String(title || ''))
}

/** 解析 `makeId` 生成的 id；容错：只给 albumId 也能用 */
function parseId(raw) {
  const s = String(raw == null ? '' : raw)
  const i = s.indexOf('|')
  if (i < 0) return { albumId: s, title: '' }
  let title = ''
  try {
    title = decodeURIComponent(s.slice(i + 1))
  } catch {
    // 标题解码失败不该让整条链路崩 —— 留空，后面按 albumId 匹配
    title = ''
  }
  return { albumId: s.slice(0, i), title }
}

/**
 * 会员标注（**如实**，不猜）
 *
 * 数据源是 `videoinfos[].is_vip`（实测真实可用，不是估的）：
 * ```text
 * 电影类实测：is_vip true=12 / false=20（同一批 32 条里两种都有）
 * 样本：「地球脉动」is_vip=true ；「《封神之路》第一集」is_vip=false
 * ```
 *
 * ⚠️ 判据分三档而不是「有就标」：
 *   ```text
 *   全都要会员 → 「会员」
 *   只有一部分   → 「部分会员」   ← ★ 这一档必须有，否则会骗到用户
 *   都不要       → 不标
 *   ```
 *   长剧集常有「前几集免费、后面要会员」⇒ 只标「会员」会让人以为整部都不能看，
 *   只标「免费」更错（点进去发现要钱）。
 *
 * ⚠️ `is_vip` 缺失（undefined）时**不当作 false** —— 只统计明确的 true/false，
 *   一个都没有就不标。宁可少标，不可错标。
 */
function vipBadge(videoinfos) {
  const list = Array.isArray(videoinfos) ? videoinfos : []
  let vip = 0
  let free = 0
  for (const v of list) {
    if (!v) continue
    if (v.is_vip === true) vip++
    else if (v.is_vip === false) free++
  }
  if (vip === 0) return null
  if (free === 0) return '会员'
  return '部分会员'
}

/**
 * 剧集列表 → 宿主 Episode 契约 `{id, title, order}`
 *
 * ⚠️ `order` 是**必填**（宿主模型里是 u32），而且它还兼任一个职责：
 *   宿主靠「有没有 order」区分「媒体条目」与「剧集」，
 *   以免给剧集 id 也加上 `provider:` 前缀（那样传回来会解析失败）。
 *   ⇒ 少了 order 会让剧集 id 被误加前缀。
 *
 * ⚠️ 剧集 id 用 `vid`（字符串，不会丢精度）；没有 vid 时退回
 *   `albumId-itemNumber`。**不要**用 albumId 参与算术（见文件头的精度说明）。
 */
function toEpisodes(album) {
  const infos = Array.isArray(album.videoinfos) ? album.videoinfos : []
  const out = []
  infos.forEach((v, i) => {
    if (!v) return
    const num = typeof v.itemNumber === 'number' ? v.itemNumber : i + 1
    const id = v.vid ? String(v.vid) : String(album.albumId) + '-' + String(num)
    out.push({
      id,
      title: String(v.itemTitle || ('第 ' + num + ' 集')),
      order: num,
    })
  })
  return out
}
/**
 * 搜索结果 → 宿主的 `Page<MediaItem>` 契约
 *
 * ⚠️ 字段名是**驼峰**（`pageCount`）—— 宿主内部会把插件返回的
 *   camelCase 转成 snake_case（见 mod.rs 的 `camel_to_snake`），
 *   所以插件侧一律写驼峰。
 *
 * ⚠️ `total` 用上游的 `result_num` —— 它是**该站结果数**，
 *   但我们只过滤出本站条目 ⇒ 用它算页数会**偏多**（页数虚高）。
 *   所以 `pageCount` **不给**（null），让前端按「这一页是否满页」判断有没有下一页。
 *   给一个错的 pageCount 会让用户翻到空页 —— 那比没有更糟。
 */
function toPage(res, page) {
  const albums = res.albums || []
  const items = albums
    .map((a) => {
      const title = String(a.albumTitle || '').trim()
      if (!title) return null
      const declared = typeof a.itemTotalNumber === 'number' ? a.itemTotalNumber : 0

      const badges = []
      /*
       * 集数角标：只在**拿得到集数**时显示。
       * 单集（电影）不显示「共 1 集」—— 那是噪声。
       */
      if (declared > 1) badges.push('共 ' + declared + ' 集')
      const vb = vipBadge(a.videoinfos)
      if (vb) badges.push(vb)
      if (typeof a.score === 'number' && a.score > 0) badges.push(a.score.toFixed(1) + ' 分')

      return {
        id: makeId(a.albumId, title),
        title,
        cover: httpsCover(a.albumVImage || a.albumHImage),
        badges,
        kind: declared > 1 ? 'series' : 'movie',
      }
    })
    .filter(Boolean)

  return { items, page }
}
/**
 * 按 albumId 找回专辑 —— **多策略 + 翻页**，不是只搜一次
 *
 * ═══════════════════════════════════════════════════════════════
 * ★★★ 为什么不能「拿标题搜一次就完事」（实测踩到，这是本插件的核心难点）
 * ═══════════════════════════════════════════════════════════════
 *
 * 本站详情接口已下线 ⇒ 详情只能靠**重新搜索**。而实测发现：
 * ```text
 * 同一个关键词，**结果集不稳定**：
 *   搜「火影忍者疾风传」 → 17 条，目标 albumId 1261506066355201 **不在里面**
 *   搜「火影忍者 疾风传」（带空格）→ 同样 17 条，目标**在第 17 位**
 * ```
 * 而且**翻页也找不回**（实测 page1..page4 都没有它）。
 * 加大 pageSize 也没用（20/50/100 都试过，目标始终不出现）。
 *
 * ⇒ 结论：**不能假设「搜一次就能命中」**。必须：
 * ```text
 * ① 多个候选关键词都试（原标题 / 去掉空格 / 取最长词片段）
 * ② 每个关键词翻前几页
 * ③ 全都找不到 ⇒ 如实返回「未能取到剧集列表」，**不编造**
 * ```
 *
 * ⚠️ 为什么值得这么麻烦：搜索结果里**本来就带 20 条剧集**（videoinfos），
 *   多试几个关键词就能把它捞回来；不试的话用户点进去只有空列表。
 *
 * ⚠️ 但**不许**无限翻页 —— 上游有风控，且用户等不起。
 *   上限见 `LOOKUP_MAX_PAGES`。
 */
const LOOKUP_MAX_PAGES = 2

/**
 * 由标题生成候选搜索词（去重、保序）
 *
 * 实测有效的两类：
 * ```text
 * ① 原样标题        —— 最常见的情况就命中
 * ② 去掉所有空格    —— 实测「火影忍者 疾风传」的目标只在这条下出现（且带空格那条也能命中）
 * ```
 * ⚠️ 不再切更细的词片段：切了会引入大量无关结果（如「疾风传」会把 UGC 解说全捞进来），
 *   反而**挤掉**目标（实测「火影忍者」搜不到目标、只有 16 条）。
 */
function lookupKeywords(title) {
  const t = String(title || '').trim()
  if (!t) return []
  const out = [t]
  const nospace = t.replace(/\s+/g, '')
  if (nospace && nospace !== t) out.push(nospace)
  return out
}

/**
 * 在多个关键词 × 多页里找 albumId
 *
 * 返回命中的 album 对象；找不到返回 null（由调用方决定怎么如实呈现）。
 */
async function findAlbumById(albumId, title) {
  const want = String(albumId)
  for (const kw of lookupKeywords(title)) {
    for (let p = 1; p <= LOOKUP_MAX_PAGES; p++) {
      let albums = []
      try {
        const r = await searchAlbums(kw, p)
        albums = r.albums
      } catch (e) {
        // 单个关键词/单页失败不该中断整个查找 —— 继续试下一个
        host.log.warn('爱奇艺：查找剧集失败（' + kw + ' p' + p + '）: ' + e.message)
        continue
      }
      const hit = albums.find((a) => String(a.albumId) === want)
      if (hit) return hit
      // 该页已空 ⇒ 这个词没有更多了，不必再翻
      if (albums.length === 0) break
    }
  }
  return null
}
/**
 * 专辑详情缓存（存 `videoinfos` 等），key = albumId
 *
 * ═══════════════════════════════════════════════════════════════
 * ★★★ 为什么必须有这个缓存（这是本插件能不能用的关键）
 * ═══════════════════════════════════════════════════════════════
 *
 * 本站详情接口已下线 ⇒ `detail()` 只能靠重新搜索。
 * 而实测：**同一个关键词的结果集不稳定**，某些 albumId 搜一次能拿到、再搜就没了：
 * ```text
 * 目标 albumId 1261506066355201（火影忍者疾风传，43 集）
 *   搜「火影忍者 疾风传」 → 命中（第 17 位）
 *   搜「火影忍者疾风传」   → **不命中**
 *   翻 page1..4、pageSize 20/50/100 → **全都拿不到**
 * ```
 *
 * ⇒ 如果每次 `detail()` 都现搜，用户**在列表里看得见、点进去却是空的**。
 *   那是本仓明令禁止的「假装」类缺陷。
 *
 * 解法：**在搜索时就把它记下来**。搜索响应里本来就带 `videoinfos`（前 20 条），
 * 顺手存进 `host.store`（落盘、跨调用保留）⇒ `detail()` 直接命中缓存，
 * 根本不需要重新搜索。
 *
 * ⚠️ 为什么缓存是**必要**的而不是优化：宿主**每次调用插件都新建 JS 运行时**
 *   （mod.rs 的 call_js → AsyncRuntime::new()）⇒ 内存里的变量跨调用**不保留**，
 *   只有 host.store 能跨调用。
 *
 * ⚠️ 缓存可能`detail`不中（用户直接从播放历史进来、或插件刚重启），
 *   所以 `detail()` 仍保留「搜索兜底」，两条路都要有。
 */
const CACHE_KEY = 'albums'

/** 缓存上限（条）—— 防止无限增长把 .data 文件撑大 */
const CACHE_MAX = 200

function readCache() {
  const raw = host.store.get(CACHE_KEY)
  if (!raw) return {}
  try {
    const o = JSON.parse(raw)
    return o && typeof o === 'object' ? o : {}
  } catch {
    // 坏缓存当没有 —— 不要因为它让插件起不来
    return {}
  }
}

function writeCache(o) {
  try {
    host.store.set(CACHE_KEY, JSON.stringify(o))
  } catch (e) {
    // 写缓存失败不该影响功能（下次再搜一次而已）
    host.log.warn('爱奇艺：缓存写入失败（不影响使用）: ' + e.message)
  }
}

/**
 * 把搜索结果里的专辑记进缓存
 *
 * ⚠️ 只存`detail()`真正要用的字段 —— 整条 album 很大（含 20 条 videoinfos），
 *   全存会把 .data 撑到几百 KB。这里存必要的。
 */
/*
 * ═══════════════════════════════════════════════════════════════
 * ★★★ 存缓存前**必须瘦身** —— 实测踩到，不瘦身会把数据文件撑爆
 * ═══════════════════════════════════════════════════════════════
 *
 * 实测（2026-10-17）：直接原样存 `videoinfos` 的后果 ——
 * `text
 * 搜 10 个词 → 缓存 200 条 → **2347 KB**，平均每条 12018 字节
 * `
 * 为什么这是**真问题**而不是「大点没关系」：
 * `text
 * host.store 是**整份 JSON 读-改-写**（mod.rs:1818 store_write）:
 *   ① 读整个文件进内存   ② 改一个键   ③ 把整个 JSON 写回
 * ⇒ 每搜一次都要序列化并落盘 2.3 MB；且 store 与 config 共用同一个文件
 * `
 * 而实测**用不到的字段占 99%**：
 * `text
 * 上游单条 videoinfo 给 34 个字段 / 5330 字节
 *   本插件实际只用 3 个: itemTitle / itemNumber / vid   → 77 字节（省 99%）
 * `
 * ⚠️ 关键：`is_vip` **不需要存** —— 它只在算列表角标时用一次，
 *   `detail()` 根本不读。存了反而会让缓存看起来更完整，
 *   诱导后来者以为能在这里改 VIP 逻辑 —— 实际改了不会生效。
 */
function slimAlbum(a) {
  const infos = Array.isArray(a.videoinfos) ? a.videoinfos : []
  return {
    albumId: a.albumId,
    albumTitle: a.albumTitle,
    albumVImage: a.albumVImage,
    albumHImage: a.albumHImage,
    description: a.description,
    itemTotalNumber: a.itemTotalNumber,
    score: a.score,
    // ★ 只留 toEpisodes() 真正读的 3 个字段
    videoinfos: infos.map((v) => ({
      itemTitle: v && v.itemTitle,
      itemNumber: v && v.itemNumber,
      vid: v && v.vid,
    })),
  }
}

function rememberAlbums(albums) {
  if (!Array.isArray(albums) || !albums.length) return
  const c = readCache()
  for (const a of albums) {
    if (!a || a.albumId == null) continue
    c[String(a.albumId)] = slimAlbum(a)
  }
  /*
   * 超上限就裁掉最旧的 —— 对象键的顺序是**插入序**，
   * 所以取最后 CACHE_MAX 个键即可（不需要额外存时间戳）。
   */
  const keys = Object.keys(c)
  if (keys.length > CACHE_MAX) {
    const keep = keys.slice(keys.length - CACHE_MAX)
    const trimmed = {}
    for (const k of keep) trimmed[k] = c[k]
    writeCache(trimmed)
    return
  }
  writeCache(c)
}

function recallAlbum(albumId) {
  const c = readCache()
  return c[String(albumId)] || null
}
// ─────────────────────────── 插件对象 ───────────────────────────

/** 首页分区用的频道词（实测都能搜出对应内容） */
const HOME_CHANNELS = [
  { id: 'hot', title: '热播', key: '热播' },
  { id: 'movie', title: '电影', key: '电影' },
  { id: 'tv', title: '电视剧', key: '电视剧' },
  { id: 'anime', title: '动漫', key: '动漫' },
  { id: 'show', title: '综艺', key: '综艺' },
  { id: 'doc', title: '纪录片', key: '纪录片' },
]

globalThis.plugin = {
  id: 'iqiyi',

  capabilities: {
    vod: true,
    search: true,
    // 游客态就能搜能看目录 ⇒ 不需要登录（登录也拿不到流，见文件头）
    loginRequired: false,
    multiSource: false,
    serverSideHistory: false,
    favorites: false,
    // ★ 不声明 danmaku：本插件没有弹幕数据源，声明了也是假的
  },

  // ── 内容发现 ──

  /**
   * 首页分区
   *
   * 本站**没有公开的榜单接口**（试过 `pcw-api…/topRankList` → 返回空对象），
   * 所以首页用「频道词搜索」实现 —— 这是**如实**的做法：
   * 每个分区就是「该频道的搜索结果」，不是伪造的榜单。
   */
  async home() {
    return HOME_CHANNELS.slice(0, 4).map((c) => ({
      id: 'iqiyi-' + c.id,
      title: c.title,
      source: { type: 'category', categoryId: c.id },
    }))
  },

  /** 分类 = 频道（浏览页左侧） */
  async categories() {
    return HOME_CHANNELS.map((c) => ({ id: c.id, name: c.title, children: [] }))
  },

  /**
   * 分类内容 = 用频道词搜索
   *
   * ⚠️ 分类 id 到关键词的映射必须**严格**：未知 id 一律回落到「热播」，
   *   而不是把 id 直接当关键词用（那会搜出莫名其妙的结果）。
   */
  async list(req) {
    const id = String((req && req.categoryId) || '').trim()
    const ch = HOME_CHANNELS.find((c) => c.id === id)
    const key = ch ? ch.key : HOME_CHANNELS[0].key
    const page = Math.max(1, (req && req.page) || 1)
    return toPage(await searchAlbums(key, page), page)
  },

  /** 搜索（宿主签名：search(keyword, page)） */
  async search(keyword, page) {
    const p = Math.max(1, page || 1)
    return toPage(await searchAlbums(keyword, p), p)
  },

  /**
   * 详情
   *
   * 本站详情接口已下线 ⇒ **用 id 里编码的标题重新搜索一次**，
   * 从结果里按 albumId 精确匹配出那一条（见 `makeId` 的说明）。
   *
   * ⚠️ 匹配**按 albumId**（数字字符串，精确），不按标题（会撞同名的不同版本）。
   */
  async detail(id) {
    const { albumId, title } = parseId(id)
    if (!albumId) throw new Error('not_found: 缺少作品 id')

    /*
     * 两条路，**缓存优先**：
     *   ① 缓存命中（用户在列表里点进来，列表那次搜索已把它记下）—— 常态，零额外请求
     *   ② 缓存不中（从播放历史进来 / 插件重启过）—— 退化为搜索兜底
     * 见 CACHE_KEY 的长注释：只靠搜索会「列表里看得见、点进去是空的」。
     */
    const album = recallAlbum(albumId) || (title ? await findAlbumById(albumId, title) : null)

    /*
     * ═══════════════════════════════════════════════════════════════
     * ★★★ 两条路都失败时**必须抛错**，不许返回空 episodes（Lead 2026-10-17 裁决）
     * ═══════════════════════════════════════════════════════════════
     *
     * 原先这里返回一个「空 episodes 的最小详情」，理由是「条目本身有效」。
     * **那是错的**，实测被 Lead 抓到：
     * ```text
     * 上游搜索结果**会漂移** —— 同一个关键词，前一次能命中、后一次就没了：
     *   目标 albumId 1261506066355201（火影忍者疾风传，43 集）
     *     首次搜「火影忍者 疾风传」→ 命中
     *     之后无论怎么搜/翻页/pageSize 20-100 → **全都拿不到**
     * ```
     *
     * 返回空 detail 的后果：界面渲染成「点进去什么都没有」，
     * 用户以为**程序坏了**（而实际是上游变了）。
     * ⇒ 抛明确错误，让界面能说清「换个源试试」——这才是如实。
     *
     * ⚠️ 错误前缀用 `parse:` —— 依据 `docs/PLUGINS.md:216`：
     *   `text
     *   throw new Error('parse: ...')   // 上游改版了
     *   `
     *   这不是网络故障（`network:`），
     *   也不是「该作品真的不存在」（`not_found:`），
     *   而是「上游返回的数据对不上」⇒ 按契约就是 `parse:`。
     *
     * ⚠️⚠️ 已知宿主缺陷（**不绕过，如实记录**，2026-10-17）：
     *   `map_js_error()`（rust/sourin_core/src/plugins/mod.rs:1485）
     *   **只认 4 个前缀**：`unauthorized` / `not_found` / `unsupported` / `network`
     *   而 `ErrorKind::Parse`（model.rs:1201）**是存在的**、`docs/PLUGINS.md` 也写了 `parse:`，
     *   但映射函数漏了这一支 ⇒ 落到 `else` 分支：
     *   `text
     *   ErrorKind::Other + "插件报错: parse: 找不到该条目…"
     *   `
     *   ⇒ 用户仍看得懂（消息本身完整），但文案多了一层「插件报错:」包装。
     *   **这是宿主的 bug**（该补一支 `parse`），已提给 Lead。
     *   我**不**改标成 `not_found:` 去规避 —— 那是错标错误类型
     *   （会让界面把「上游变了」当成「作品不存在」，两者对用户的下一步动作不同）。
     */
    if (!album) {
      throw new Error(
        'parse: 找不到该条目（上游搜索结果已变化）。可返回上一页重新进入，或换一个源试试。'
      )
    }

    const episodes = toEpisodes(album)
    const declared = typeof album.itemTotalNumber === 'number' ? album.itemTotalNumber : 0

    /*
     * ★ 角标要如实反映「能看几集」
     *
     * 实测：长剧集上游只给**前 20 条** videoinfos（如疾风传总集 735 / 只给 20）。
     * 若直接标「共 735 集」，用户翻到底只有 20 集 ⇒ **自相矛盾**。
     * ⇒ 明确写出「共 N 集，仅列出前 M 集」。
     */
    const badges = []
    if (declared > episodes.length && episodes.length > 0) {
      badges.push('共 ' + declared + ' 集（仅列出前 ' + episodes.length + ' 集）')
    } else if (declared > 0) {
      badges.push('共 ' + declared + ' 集')
    }
    const vb = vipBadge(album.videoinfos)
    if (vb) badges.push(vb)
    if (typeof album.score === 'number' && album.score > 0) {
      badges.push(album.score.toFixed(1) + ' 分')
    }

    return {
      id: String(id),
      title: album.albumTitle || title || String(albumId),
      cover: httpsCover(album.albumVImage || album.albumHImage),
      description: String(album.description || '').trim() || undefined,
      badges,
      kind: episodes.length > 1 ? 'series' : 'movie',
      episodes,
    }
  },

  /** 剧集（宿主会优先调它；没实现时才退回 detail().episodes） */
  async episodes(id, sourceCode) {
    const d = await this.detail(id)
    return d.episodes
  },

  /**
   * 取流 —— ★★★ 本插件**有意不支持**
   *
   * ═══════════════════════════════════════════════════════════════
   *  为什么必须定义它（而不是干脆不写）
   * ═══════════════════════════════════════════════════════════════
   *
   * 宿主取流那一句是 `plugin.resolve(…)`，**没有存在性判断**
   * （对比 `rank`/`session` 都有 `plugin.x ? … : …` 保护）。
   * 查过宿主实现：rust/sourin_core/src/plugins/mod.rs:2205。
   * ⇒ 不定义的话会得到「plugin.resolve is not a function」这种**内部错误**，
   *   用户看到的是程序坏了，而不是「这个源不支持播放」。
   *
   * ═══════════════════════════════════════════════════════════════
   *  提示措辞（Lead 要求：必须说清「为什么不能播」）
   * ═══════════════════════════════════════════════════════════════
   *
   * 三段式：**是什么 → 为什么 → 怎么办**
   * ```text
   * ① 是什么：该源只能搜索与浏览
   * ② 为什么：播放地址需要官方签名，本插件不逆向风控（有意为之）
   * ③ 怎么办：可复制标题到其它源搜同一部片
   * ```
   *
   * ⚠️ 措辞上**不说「暂不支持」**（那暗示以后会支持，是误导），
   *   也**不说「失败/错误」**（那不是故障）。说「不提供」，并给出替代动作。
   */
  async resolve(id, req) {
    throw new Error(
      'unsupported: 该源只能搜索与浏览：播放地址需要官方签名（本插件不逆向风控，故不提供播放）。' +
        '可复制片名到其它源搜索同一部作品。'
    )
  },
}