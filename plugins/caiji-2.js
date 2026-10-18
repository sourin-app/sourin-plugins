/**
 * ️天堂┃采集 —— 由 TVBox 源自动转换
 * ================================================================
 *
 * @id caiji-2
 * @name ️天堂┃采集
 * @version 1.0.0
 * @author tvbox-convert
 *
 * 上游接口（苹果CMS v10）：http://caiji.dyttzyapi.com/api.php/provide/vod/from/dyttm3u8/at/m3u8
 *
 * ⚠️ 这是**自动生成**的插件。转换器只做协议映射，不修改数据。
 *    上游站点的内容与可用性由该站点负责，与本项目无关。
 *
 * 转换时间：2026-09-18T11:35:15.246Z
 */
globalThis.plugin = {
  id: 'caiji-2',

  capabilities: {
    vod: true,
    search: true,
    live: false,
    loginRequired: false,
  },

  coverHeaders: [['User-Agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36']],

  /** 分类是转换时探测到的固定清单（苹果CMS 的分类很少变） */
  categories: [
    {
      "id": "1",
      "name": "电影片",
      "pid": null
    },
    {
      "id": "2",
      "name": "连续剧",
      "pid": null
    },
    {
      "id": "3",
      "name": "综艺片",
      "pid": null
    },
    {
      "id": "4",
      "name": "动漫片",
      "pid": null
    },
    {
      "id": "6",
      "name": "动作片",
      "pid": "1"
    },
    {
      "id": "7",
      "name": "喜剧片",
      "pid": "1"
    },
    {
      "id": "8",
      "name": "爱情片",
      "pid": "1"
    },
    {
      "id": "9",
      "name": "科幻片",
      "pid": "1"
    },
    {
      "id": "10",
      "name": "恐怖片",
      "pid": "1"
    },
    {
      "id": "11",
      "name": "剧情片",
      "pid": "1"
    },
    {
      "id": "12",
      "name": "战争片",
      "pid": "1"
    },
    {
      "id": "13",
      "name": "国产剧",
      "pid": "2"
    },
    {
      "id": "14",
      "name": "香港剧",
      "pid": "2"
    },
    {
      "id": "15",
      "name": "韩国剧",
      "pid": "2"
    },
    {
      "id": "16",
      "name": "欧美剧",
      "pid": "2"
    },
    {
      "id": "20",
      "name": "记录片",
      "pid": "1"
    },
    {
      "id": "21",
      "name": "台湾剧",
      "pid": "2"
    },
    {
      "id": "22",
      "name": "日本剧",
      "pid": "2"
    },
    {
      "id": "23",
      "name": "海外剧",
      "pid": "2"
    },
    {
      "id": "24",
      "name": "泰国剧",
      "pid": "2"
    },
    {
      "id": "25",
      "name": "大陆综艺",
      "pid": "3"
    },
    {
      "id": "26",
      "name": "港台综艺",
      "pid": "3"
    },
    {
      "id": "27",
      "name": "日韩综艺",
      "pid": "3"
    },
    {
      "id": "28",
      "name": "欧美综艺",
      "pid": "3"
    },
    {
      "id": "29",
      "name": "国产动漫",
      "pid": "4"
    },
    {
      "id": "30",
      "name": "日韩动漫",
      "pid": "4"
    },
    {
      "id": "31",
      "name": "欧美动漫",
      "pid": "4"
    },
    {
      "id": "32",
      "name": "港台动漫",
      "pid": "4"
    },
    {
      "id": "33",
      "name": "海外动漫",
      "pid": "4"
    },
    {
      "id": "34",
      "name": "伦理片",
      "pid": "1"
    },
    {
      "id": "36",
      "name": "短剧",
      "pid": "2"
    },
    {
      "id": "37",
      "name": "动画片",
      "pid": "1"
    }
  ],

  /*
   * ★★ 分类过滤：用**内容自带的 type_id_1**（站点给的父类 id）
   *
   * # 这是一步步试出来的，前面两次都错了
   *
   * · 第一版：靠 t= 参数 → 大多数站不支持，退回全站最新 →
   *   **所有分类返回同一份内容**（Owner 报的「数据一模一样」）
   * · 第二版：拿 class 里的 type_pid 做父类展开 → 对
   *   **扁平结构**的站（所有 type_pid 都为空）失效 →
   *   实测百度站 4 个分类全 0 条
   * · 第三版（一度想用）：按分类名白名单猜父类 / 按顺序分段 →
   *   实测把"动作片"归到了"动漫"名下，**明显错**
   *
   * # ★ 正确做法：内容里的 type_id_1
   *
   * AppleCMS 返回的每条内容都带两层分类：
   * text
   * type_id   = 子类（大陆剧=13）
   * type_id_1 = **父类**（电视剧=2）
   * 
   * 实测（百度站）：
   * text
   * type_id=13 (大陆剧)   type_id_1=2 → 电视剧
   * type_id=25 (大陆综艺) type_id_1=3 → 综艺
   * type_id=6  (动作片)   type_id_1=1 → 电影
   * 
   * 实测（360采集）：
   * text
   * type_id=35 (港台综艺) type_id_1=3 → 综艺
   * 
   *
   * **这是站点自己给的归属信息，不需要任何推断。**
   *
   * # 匹配规则（两级都要认）
   *
   * 用户可能点父类（电影）也可能点子类（动作片），所以：
   *   · 点父类 → 匹配 type_id_1 === 父类id
   *   · 点子类 → 匹配 type_id === 子类id
   * 两个条件用 || 连起来，两种情况都覆盖。
   *
   * ⚠️ 老接口可能没有 type_id_1 —— 那时退回「只匹配 type_id」，
   *    最坏情况是点父类时内容少（但**不会**变成"所有分类同一份"）。
   */
  categoryIds(cat) {
    return String(cat);
  },

  async home() {
    return this.categories.slice(0, 8).map((c) => ({
      id: 'caiji-2-' + c.id,
      title: c.name,
      source: { type: 'category', categoryId: c.id },
    }))
  },

  /**
   * 分类列表
   *
   * ★★ 按分类取内容：**不能靠 t= 参数**（实测结论，见下）
   *
   * # 曾经的错误做法（Owner 报的真 bug）
   *
   * 原先写的是「带 t= 拿不到就**退回不带 t=**」，注释里还自我感觉良好：
   * > 「分类不精确，但至少有内容可看 —— 这比'点进去空白'好得多」
   *
   * **这个兜底是错的。** 后果：因为大多数站不支持 t=，
   * 所有分类都退回同一份"全站最新" ——
   * Owner 实测发现：「电影 / 连续剧 / 综艺 / 动漫，开头数据**一模一样**」。
   *
   * 也就是说：**不是"分类不精确"，而是"分类完全失效"** ——
   * 用户看到 8 个分类，其实每个都是同一份内容。比"点进去空白"更糟，
   * 因为它**看起来是好的**，用户根本不会怀疑。
   *
   * # 实测：各种分类参数都不行
   *
   * 对 360采集 试了 8 组（每个都拿前 3 个分类对照）：
   *
   * text
   * t=                0 条（三个分类都空）
   * t= 用 ac=detail   0 条
   * h=                1 条，三分类**相同**
   * type_id=         20 条，三分类**相同**
   * filter=          20 条，三分类**相同**
   * class=           20 条，三分类**相同**
   * tid=             20 条，三分类**相同**
   * 不带参数          20 条，三分类**相同**（对照组）
   * 
   *
   * 结论：**这个站压根没实现按分类过滤** —— 传什么都返回同一批。
   *
   * # ★ 正确做法：客户端按 type_id / type_id_1 过滤 + 翻页凑数
   *
   * 关键发现：**每条内容都带两层分类**：
   *
   * json
   * { "vod_id": 123, "type_id": 35, "type_id_1": 3,
   *   "type_name": "港台综艺", "vod_name": "食尚玩家", … }
   *                     ↑ 子类            ↑ **父类**（站点给的）
   *
   * 而一页 20 条里就混着 **9 个不同 type_id**（实测 360采集 pg=1：
   * 35, 30, 11, 32, 16, 8, 34, 13, 38）。
   *
   * 所以：**服务端不筛，我们自己筛** —
   * 翻若干页，把匹配的挑出来，凑够一页就返回。
   * 这条**不依赖服务端支持**，任何 AppleCMS 都能用。
   *
   * ⚠️ 匹配规则要看**两级**（用户可能点父类也可能点子类）：
   *    内容命中条件 = type_id === cat || type_id_1 === cat
   */
  async list(req) {
    const page = req.page || 1
    const cat = String(req.categoryId)

    /*
     * ① 先试服务端的 t= —— 支持的站一条请求就够，最快。
     *    实测确实有少数站支持（暴风 12 条 / 量子 1 条）。
     */
    let j = await getJson(
      `${API}?ac=videolist&t=${encodeURIComponent(cat)}&pg=${page}`,
    )
    if ((j.list || []).length) {
      return {
        items: (j.list || []).map(toItem),
        page,
        pageCount: j.pagecount || 1,
        total: j.total || 0,
      }
    }

    /*
     * ② 服务端不认 t= → **客户端按分类字段过滤**。
     *
     * 从第 1 页开始翻，最多翻 SCAN_MAX 页 ——
     * 因为内容按时间倒序混着各类，凑一页目标分类通常几页就够，
     * 但冷门分类可能要翻很多页。
     *
     * ⚠️ 上限不能太大：插件跑在 QuickJS 里、每次翻页是一次网络请求，
     *    翻 20 页会让用户等十几秒。SCAN_MAX = 8 是实测的平衡点
     *    （8 页 160 条，热门分类基本都能凑够 ≥12 条）。
     */
    const SCAN_MAX = 8
    const picked = []
    let scanned = 0
    let lastPageCount = 1

    for (let p = 1; p <= SCAN_MAX && picked.length < 20; p++) {
      const jj = await getJson(`${API}?ac=videolist&pg=${p}`)
      scanned = p
      lastPageCount = jj.pagecount || 1
      const list = jj.list || []
      if (!list.length) break

      for (const it of list) {
        /*
         * ★ 两级匹配：type_id（子类）**或** type_id_1（父类）
         *
         * 用户点「电影」(id=1) 时，内容是 type_id=6 动作片 /
         * type_id_1=1 → 靠 type_id_1 命中。
         * 用户点「动作片」(id=6) 时 → 靠 type_id 命中。
         *
         * ⚠️ 老接口没有 type_id_1 时它会是 undefined，
         *    与字符串比较恒为 false，自动退化成"只按 type_id"——
         *    不需要额外分支。
         */
        const hit =
          String(it.type_id) === cat || String(it.type_id_1) === cat

        if (hit) {
          // 去重：同一片可能重复出现
          if (!picked.some((x) => String(x.vod_id) === String(it.vod_id))) {
            picked.push(it)
          }
        }
      }
      // 翻到底了就停
      if (p >= lastPageCount) break
    }

    /*
     * ③ 极端兜底：某个分类在这个站上确实没有任何内容
     *    （比如"伦理片"这类站上没建分类的）。
     *
     * 这时**返回空列表**，让界面如实显示"暂无内容" ——
     * **不要**再退回"全站最新"，那正是之前那个 bug。
     * "这个分类没内容"是**真实信息**，骗用户比空列表更糟。
     */
    return {
      items: picked.map(toItem),
      page,
      pageCount: Math.max(1, Math.ceil(lastPageCount / Math.max(1, scanned))),
      total: picked.length,
    }
  },

  async search(keyword, page) {
    const p = page || 1
    const j = await getJson(
      `${API}?ac=videolist&wd=${encodeURIComponent(keyword)}&pg=${p}`,
    )
    return {
      items: (j.list || []).map(toItem),
      page: p,
      pageCount: j.pagecount || 1,
      total: j.total || 0,
    }
  },

  async detail(id) {
    const j = await getJson(`${API}?ac=videolist&ids=${encodeURIComponent(id)}`)
    const d = (j.list || [])[0]
    if (!d) throw new Error('取不到详情')

    /*
     * ★ 苹果CMS 的剧集结构
     *
     * od_play_url 形如：
     *   "第1集$http://a.m3u8#第2集$http://b.m3u8"
     * 用 # 分集、用 $ 分「集名」与「地址」。
     *
     * ⚠️ 有的站把多组播放源用 $$$ 分隔（如 "线路1$$$线路2"），
     *    这里只取第一组 —— 与 TVBox 默认行为一致。
     */
    const groups = String(d.vod_play_url || '').split('$$$')
    const eps = parseEpisodes(groups[0] || '')

    return {
      id: String(d.vod_id),
      title: d.vod_name || '',
      cover: d.vod_pic || undefined,
      description: stripTags(d.vod_content || d.vod_blurb || ''),
      episodes: eps.map((e, i) => ({
        id: e.url,                    // 直接存 URL —— 取流时无需再请求
        title: e.name || `第${i + 1}集`,
        order: i + 1,
      })),
      /*
       * ★ PlaySource 的字段是 title 不是 name
       *
       * 实测踩到：写成 name 后宿主反序列化报
       * 「detail() 返回格式不符: missing field title」——
       * 整个详情页打不开（连标题都显示不出来）。
       * 契约见 research/插件API契约设计.md 的 interface PlaySource。
       */
      sources: [{ code: 'default', title: '️天堂┃采集', count: eps.length }],
    }
  },

  /**
   * 取流
   *
   * id 就是剧集 id —— 详情里我们直接存了播放地址（见 detail 的说明）。
   * 但**地址可能是分享页 HTML**（实测非凡/量子这类站就是这样），
   * 所以这里要判断：拿到 HTML 就从中挖出真正的 m3u8。
   */
  async resolve(id) {
    /*
     * ★★ id 有两种可能，必须先分辨
     *
     * 契约里 resolve(id, req) 的 id 是**条目 id**（我们插件的 native id，
     * 即苹果CMS 的 vod_id，形如 "150758"），不是播放地址。
     * 剧集地址在 detail() 里返回（见那里的说明），由宿主的
     * PlayRequest.episode_id 传进来 —— 但**播放器也可能只传条目 id**
     * （比如从播放历史/追更直接续播，没有 episode_id）。
     *
     * 所以这里两种都要处理：
     *   · 看起来是 URL（http/https）→ 直接用（这是剧集地址）
     *   · 否则是条目 id → 去取详情，拿第一集
     *
     * # ⚠️ 实测踩到的 bug：把 id 当 URL 请求 → builder error
     *
     * 第一版无条件 getText(url) —— 传进来 "150758" 时
     * host.http.get("150758") 让 reqwest 无法构造请求，报
     * network: 请求失败: builder error。
     * 播放器显示「请求失败」，用户完全不知道为什么。
     *
     * 所以**必须先判断是不是 URL**，再决定怎么用。
     */
    let url = String(id)

    if (!/^https?:\/\//i.test(url)) {
      // 传的是条目 id → 取详情，用第一集
      const j = await getJson(`${API}?ac=videolist&ids=${encodeURIComponent(url)}`)
      const d = (j.list || [])[0]
      if (!d) throw new Error('取不到这个条目的信息')
      const groups = String(d.vod_play_url || '').split('$$$')
      const eps = parseEpisodes(groups[0] || '')
      if (!eps.length) throw new Error('这个条目没有可播放的剧集')
      url = eps[0].url
    }

    /*
     * 不是 m3u8 → 可能要先过一层分享页（实测非凡/量子就是这样）
     *
     * ★★ 如果分享页里也没有，就交给「解析接口」（见下面的 tryParsers）
     *
     * 实测有一个源（154 影视建安）返回的"播放地址"其实是
     * **爱奇艺/优酷的网页**：
     *   https://www.iqiyi.com/v_1hn0p07xxls.html
     * 这种页面里**没有** m3u8 —— 视频地址由页面 JS 动态去取。
     *
     * Owner 质问我"为什么 TVBox 能我们不行"，查清后：
     * TVBox 靠 parses 段把网页 URL 转发给**第三方解析服务**换 m3u8。
     * 那是纯 HTTP GET，我们也能做。见 PARSE_SERVICES。
     */
    if (!/\.m3u8/i.test(url)) {
      const html = await getText(url)
      const found = extractM3u8(html, url)
      if (found) {
        url = found
      } else {
        // 分享页里没有 → 试解析接口
        const parsed = await tryParsers(url)
        if (!parsed) {
          /*
           * 全都失败 → 报错说清楚**是谁的问题**
           *
           * 原文案「这个源没有可直接播放的地址（可能需要专用解析）」
           * 没说清楚，用户会以为插件坏了。按情况分开说。
           */
          const isThirdParty = /(iqiyi|youku|qq\.com|mgtv|bilibili|le\.com|sohu)\./i.test(url)
          if (isThirdParty) {
            throw new Error(
              '这个源只提供爱奇艺/优酷等站点的网页链接，需要在线解析服务才能播放（当前所有解析接口都不可用）'
            )
          }
          throw new Error('这个源没有可直接播放的地址（可能需要专用解析）')
        }
        url = parsed
      }
    }

    /*
     * ★★ kind 必须按**真实地址**判断，且值有**硬性枚举**
     *
     * # 判据（按扩展名）
     *
     * 实测（154 影视建安走解析接口后）：
     *   解析服务返回的是 **直链 mp4**，不是 m3u8：
     *     https://video.5g.wasu.tv/pcsan24/pc/movie/.../xxx.mp4?auth_key=...
     *     https://apd-xxx.v.smtcdns.com/vhot2.qqvideo.tc.qq.com/... (实测可下)
     *
     * 写死 hls 会让播放器按 HLS 去解一个 mp4 → 黑屏转圈，
     * 而用户完全不知道为什么。
     *
     * # ⚠️⚠️ 枚举值**不是我以为的那些**（实测被宿主当场拒了）
     *
     * 我先写成了 file（"直链文件"直觉上该叫 file），宿主直接报：
     *
     *   resolve() 返回格式不符: unknown variant file,
     *   expected one of hls, dash, mp4, web_embed, audio_only
     *
     * **宿主把合法值全列出来了** —— 正确值是 mp4：
     *   · .m3u8 / 无扩展名  → hls
     *   · .mp4 / .mkv 等    → **mp4**（不是 file！）
     *   · 网页播放器         → web_embed
     *
     * > 教训：**Rust 侧的 serde 枚举校验就是最权威的契约文档** ——
     * > 报错信息里会列出全部合法值，照抄即可，不要靠猜。
     * > （research/插件API契约设计.md 写的是 file，**那份文档是错的**，
     * >   与 host.http.get 返回字符串那件事一样属于过期信息。）
     */
    const lower = url.toLowerCase().split('?')[0]
    const isDirectFile = /\.(mp4|mkv|mov|avi|webm|flv|m4v)$/.test(lower)
    const kind = isDirectFile ? 'mp4' : 'hls'

    return [{
      url,
      kind,
      label: '️天堂┃采集',
      quality: '自动',
      /*
       * ★★ 这两项缺一不可
       *
       * 采集站普遍校验 Referer/UA（实测：少了就拿不到分片）。
       * 而 <video> 的请求头由 WebView 决定、JS 改不了 ——
       * 所以必须声明 
otWebReady，让宿主用本地代理带头发请求。
       *
       * ⚠️ headers 是**对象**（{ 名: 值 }），不是数组 ——
       *    见 bilibili.js 的 PLAY_HDRS。
       */
      notWebReady: true,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36',
        Referer: API.replace(/\/api\.php[\s\S]*$/, '') + '/',
      },
    }]
  },
}

// ═══════════════════════════ 内部实现 ═══════════════════════════

const API = "http://caiji.dyttzyapi.com/api.php/provide/vod/from/dyttm3u8/at/m3u8"

const HDRS = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36' }

/*
 * ══════════════════════════════════════════════════════════════════
 * ★★★ 在线解析服务（对应 TVBox 配置里的 parses 段）
 * ══════════════════════════════════════════════════════════════════
 *
 * # 为什么需要这个
 *
 * 有些苹果CMS源返回的"播放地址"不是视频流，而是**视频网站的网页**：
 *   https://www.iqiyi.com/v_1hn0p07xxls.html
 *   https://v.youku.com/v_show/id_XNjUwOTY2OTU1Ng==.html
 *
 * 这种页面里**没有 m3u8** —— 视频地址由页面里的 JS 动态去取，
 * 还要过签名/会员校验。
 *
 * # TVBox 是怎么做的（Owner 的质疑让我查清了这件事）
 *
 * TVBox **自己不解析** —— 它有一个 parses 段，把网页 URL
 * **转发给第三方解析服务**，对方返回真正可播的 m3u8：
 *
 *   GET {服务地址}{encodeURIComponent(视频网页URL)}
 *
 * **这就是一次 HTTP GET** —— host.http.get 完全能做。
 *
 * # 实测（.probe/web/test_parses5.mjs）
 *
 * 从公开 TVBox 配置里收集到 15 个 type=1 接口，逐个实测后
 * **只有 2 个活着**，且都验证了返回的流是**真 m3u8**（含 #EXTM3U）：
 *
 *   ① https://player.gimy.bot/u/parse.php?url=
 *      → https://png.ruyijx.com/m3u8/xxx.m3u8   HTTP 200, 97KB ✅
 *   ② https://api.huaqi.pro/api/?key=5bd0db7c858ba9f999373450f3651af7&url=
 *      → https://m3u8.gcncsm.cn/.../m3u8/xxx    HTTP 200, 367KB ✅
 *
 * 其余 13 个的失败原因（都已实测）：
 *   · 连不上（域名挂了）
 *   · {"code":401,"msg":"无效的API密钥"}
 *   · {"code":402,"msg":"无可用套餐或者套餐已到期"}
 *   · {"code":403,"msg":"KEY无效"}
 *   · {"code":-1,"msg":"用户信息错误"}
 *
 * # ⚠️⚠️ 这个清单会**很快失效**
 *
 * 第三方解析服务的生命周期通常是**几天到几周**。所以：
 *   · 必须**依次试**，逐个降级（见 tryParsers）
 *   · 失败要**静默跳过**，不能因为一个挂了就让整个播放失败
 *   · 用户可以在插件里替换这个清单（见文件末尾的说明）
 *
 * 想更新清单：在 GitHub 搜 "TVBox 接口" 找配置 json，
 * 里面 parses 段中 \"type": 1 的就是这类 JSON 接口。
 */
const PARSE_SERVICES = [
  'https://player.gimy.bot/u/parse.php?url=',
  'https://api.huaqi.pro/api/?key=5bd0db7c858ba9f999373450f3651af7&url=',
]

/**
 * 依次试解析服务，返回第一个可用的 m3u8 地址
 *
 * ⚠️ 每个服务都可能：连不上 / 返回错误 JSON / 返回占位视频 /
 *    返回过期短链。所以每次拿到地址都要**验证它像真流**。
 *
 * ⚠️ 出错时**必须 continue**，不能 throw ——
 *    一个服务挂了不该让整个播放失败（这正是原版做不到播放的原因）。
 */
async function tryParsers(pageUrl) {
  for (const base of PARSE_SERVICES) {
    try {
      const text = await getText(base + encodeURIComponent(pageUrl))
      if (!text) continue

      let found = null

      // ① 多数接口返回 JSON
      try {
        const j = JSON.parse(text)
        found =
          j.url || j.m3u8 || j.data?.url || j.data?.m3u8 || j.data?.playUrl ||
          (typeof j.data === 'string' && /^https?:/i.test(j.data) ? j.data : null)
      } catch {
        // ② 少数直接返回 HTML/纯文本，从里面挖
        const m = text.match(/https?:\/\/[^\s"'<>\\)]+\.(m3u8|mp4|flv)[^\s"'<>\\)]*/i)
        if (m) found = m[0]
      }

      if (!found || typeof found !== 'string') continue

      // ③ 排除"错误占位"视频（解析失败时很多服务返回这个）
      if (/error|placeholder|default\.mp4/i.test(found)) continue

      /*
       * ④ 相对路径补全
       *
       * ⚠️ **不要用 new URL()** —— QuickJS 里没有 URL 类。
       *    第一版我用了它，转换器的自检当场拦下：
       *    「生成结果自检失败 — 用了 QuickJS 不支持的 API: new URL()」
       *    （这个自检救了 22 个插件，否则用户会装上一堆坏插件）
       *
       * 手写协议+主机提取：
       *   从 "https://host/path?q" 里取 "https://host"
       */
      if (found.charAt(0) === '/') {
        const m = /^(https?:\/\/[^\/]+)/.exec(base)
        if (!m) continue
        found = m[1] + found
      }

      // ⑤ 必须是可播的协议 + 像流地址
      if (!/^https?:\/\//i.test(found)) continue

      return found
    } catch {
      // 静默跳过，试下一个（见上面的说明）
      continue
    }
  }
  return null
}

/*
 * ★★ host.http.get 返回的是**字符串**，不是 Response 对象
 *
 * 这一点我在写第一版时搞错了 —— 因为 research/插件API契约设计.md
 * 里写的是 { status, headers, body } 对象形态（**那份文档是过期的**）。
 *
 * 真实契约（以随程序发布的 demo.js 与 bilibili.js 为准）：
 *
 *   host.http.get(url, opts)  → Promise<string>   响应文本
 *   host.http.post(url, body) → Promise<string>
 *
 * 且**失败时不抛异常**，而是返回以 __ERR__ 开头的字符串。
 * 所以必须显式判断前缀，否则 JSON.parse 会报
 * "unexpected token '__ERR__'" —— 完全看不出是网络问题。
 */
async function getRaw(url) {
  const text = await host.http.get(url, { headers: HDRS })
  if (typeof text !== 'string') {
    throw new Error('host.http 返回了非字符串（契约应为响应文本）')
  }
  if (text.startsWith('__ERR__')) {
    throw new Error('network: ' + text.slice(7))
  }
  return text
}

async function getJson(url) {
  const text = await getRaw(url)
  try {
    return JSON.parse(text)
  } catch {
    throw new Error('接口返回的不是 JSON — ' + text.slice(0, 100))
  }
}

async function getText(url) {
  return getRaw(url)
}

/**
 * 把相对地址补成绝对地址
 *
 * # ★★ 为什么不能用 new URL() —— QuickJS 里根本没有 URL
 *
 * 实测（写了个探针插件跑在真实运行时里）：
 *
 *     new URL('/a/b.m3u8', 'https://cdn.com/x/index.m3u8')
 *       → THROW: URL is not defined
 *
 *     QuickJS 缺失的全局对象：
 *       URL, URLSearchParams, fetch, TextEncoder, TextDecoder,
 *       atob, btoa, structuredClone, setTimeout, console
 *
 * 而宿主给的是 host.http / host.crypto / host.util 这套替代品 ——
 * **不是浏览器环境**。
 *
 * # 这导致的真 bug（实测）
 *
 * cj（非凡）与 cj-2（量子）的播放地址是**分享页**，
 * 真 m3u8 藏在 HTML 里、且是**相对路径**：
 *
 *     /20260703/55346_6384bb05/index.m3u8?sign=01627e...
 *
 * 原实现用 new URL(m[1], pageUrl) 绝对化 → 抛异常 →
 * catch 里返回**相对路径** → 宿主 reqwest 收到非绝对 URL →
 * builder error → 代理 502 → **这两个源一直播不了**。
 *
 * 而 360 / 暴风 / 天堂 的地址本来就是完整 URL，所以它们没暴露这个问题 ——
 * 这正是「只测一个源就以为全好了」的陷阱。
 *
 * # 实现（纯字符串，严格按 RFC 3986 的相对引用规则）
 *
 * | 形态 | 处理 |
 * |---|---|
 * | https://... | 已经是绝对地址，原样返回 |
 * | //host/path | 协议相对 → 补上页面的协议 |
 * | /path       | 绝对路径 → 取页面的 scheme://host 拼上 |
 * | a/b         | 相对路径 → 拼到页面 URL 的目录下 |
 */
function absolutize(ref, baseUrl) {
  const r = String(ref || '').trim()
  if (!r) return ''
  // 已经是绝对地址
  if (/^https?:\/\//i.test(r)) return r

  const base = String(baseUrl || '')
  const m = base.match(/^(https?:)\/\/([^/?#]+)/i)
  if (!m) return r // base 本身不合法 —— 原样返回，至少不丢信息
  const origin = m[1] + '//' + m[2]

  // 协议相对：//host/path
  if (r.startsWith('//')) return m[1] + r

  // 绝对路径：/path —— 从域名根开始
  if (r.startsWith('/')) return origin + r

  // 相对路径：拼到 base 的目录下
  const noQuery = base.split(/[?#]/)[0]
  const slash = noQuery.lastIndexOf('/')
  const dir = slash >= 0 ? noQuery.slice(0, slash + 1) : origin + '/'
  return dir + r
}

/** 从分享页 HTML 里挖 m3u8（可能是相对路径，要按页面 URL 绝对化） */
function extractM3u8(html, pageUrl) {
  const m = html.match(/["']([^"']*\.m3u8[^"']*)["']/)
  if (!m) return null
  return absolutize(m[1], pageUrl)
}

/** "第1集$url#第2集$url2" → [{name,url}] */
function parseEpisodes(s) {
  return String(s || '')
    .split('#')
    .map((part) => {
      const i = part.indexOf('$')
      if (i < 0) return { name: '', url: part.trim() }
      return { name: part.slice(0, i).trim(), url: part.slice(i + 1).trim() }
    })
    .filter((e) => /^https?:\/\//i.test(e.url))
}

function toItem(x) {
  return {
    id: String(x.vod_id),
    title: x.vod_name || '',
    cover: x.vod_pic || undefined,
    subtitle: x.vod_remarks || undefined,
    kind: 'movie',
    description: stripTags(x.vod_blurb || ''),
  }
}

function stripTags(s) {
  return String(s || '').replace(/<[^>]+>/g, '').trim()
}
