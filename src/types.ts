// ═══════════════════════════════════════════════════════════════════════
//  插件契约 —— 数据结构
// ═══════════════════════════════════════════════════════════════════════
//
// ★ 命名约定：**插件这一侧一律写 camelCase**。
//   宿主在桥接层统一把键名转成 Rust 的 snake_case
//   （rust/sourin_core/src/plugins/mod.rs 的 `js_value_to_rust` / `camel_to_snake`），
//   所以这里的字段名就是你写插件时该用的字段名。
//
// ⚠️ 有两个**不在通用转换里**的特例，容易踩：
//    ① `headers` —— 插件写对象 `{ Referer: '...' }`，
//       宿主专门把它转成键值对数组（Rust 侧是 `Vec<(String, String)>`）。
//       别的键**没有**这个待遇：`coverHeaders` 必须直接写成数组
//       `[['Referer', '...']]`。
//    ② 键名里的连字符不受影响 —— 直播 tag 的 `'group-title'` 原样保留。

/** 内容类型。默认 `'movie'`。 */
export type MediaKind =
  /** 电影 / 单集 */
  | 'movie'
  /** 剧集 / 番剧（有多集） */
  | 'series'
  /** 直播频道 */
  | 'live'
  /** 综艺 / 纪录片 / 动画（UI 按 series 归类） */
  | 'variety'
  /** 合集 / 栏目 */
  | 'collection';

/** 统一媒体条目 —— 列表页 / 搜索结果都用它。 */
export interface MediaItem {
  /**
   * 插件**内部**的 id（原样传回 `detail(id)`）。
   *
   * ⚠️ **不要自己拼前缀** —— 宿主会自动加上 `"<插件id>:"`，
   *    自己拼了会变成 `demo:demo:123`。
   */
  id: string;
  title: string;
  /** 封面图地址。 */
  cover?: string;
  /** 卡片副标题，如「更新至第 12 集」「2026-09-14」。 */
  subtitle?: string;
  /** 角标，如「1080P」「直播中」「VIP」「会员」。 */
  badges?: string[];
  /** 内容类型，默认 `'movie'`。 */
  kind?: MediaKind;
  /** 原始简介（列表页一般不显示，详情页用）。 */
  description?: string;
}

/** 分类（浏览页左侧的分类树）。 */
export interface Category {
  id: string;
  name: string;
  /** 二级分类。没有就给空数组或省略。 */
  children?: Category[];
}

/** 首页一个区块**如何取数据**（宿主据此懒加载）。 */
export type SectionSource =
  /** 该分类的列表 —— 宿主会拿 `categoryId` 去调 `list()`。 */
  | { type: 'category'; categoryId: string }
  /** 榜单 —— 宿主会拿 `rankId` 去调 `rank()`。 */
  | { type: 'rank'; rankId: string }
  /** 最近更新。 */
  | { type: 'recent' }
  /** 插件自定义（宿主原样回传给 `list()` 的 `categoryId`）。 */
  | { type: 'custom'; key: string }
  /** 静态 —— 数据已经在 `items` 里，宿主不再请求。 */
  | { type: 'static' };

/**
 * 首页分区。
 *
 * ⚠️ `home()` **只返回区块声明，不含内容** —— 首屏不必等所有区块拉完，
 *    宿主会按 `source` 再去调 `list()` / `rank()` 懒加载。
 */
export interface Section {
  id: string;
  title: string;
  source: SectionSource;
  /** 已预取的数据（配合 `source.type === 'static'` 用）。 */
  items?: MediaItem[];
}

/** 分页结果的通用形态。 */
export interface Page<T> {
  items: T[];
  /** 当前页（**从 1 开始**）。 */
  page: number;
  /**
   * 总条数。
   *
   * ★ 契约里是 `total`，**不是 `hasMore`** —— 宿主据此算「还有没有下一页」。
   *   拿不到时省略也可以，但给了最稳。
   */
  total?: number;
  /** 总页数（可选，宿主优先用 `total`）。 */
  pageCount?: number;
}

/** 一条播放线路（「线路1 / 线路2」）。 */
export interface PlaySource {
  /** 线路编码，会作为 `episodes(id, sourceCode)` 的第二个参数传回来。 */
  code: string;
  title: string;
  /** 该线路下的剧集数；`0` 表示未知。 */
  count?: number;
  /** 嵌套线路（线路里还有线路）。 */
  nested?: PlaySource[];
}

/** 剧集。 */
export interface Episode {
  /**
   * 剧集 id —— **必须字符串**，会被原样传给 `resolve(id, req)`。
   *
   * ★ 需要「哪条线路、第几集」的信息时，**把它编码进这个 id**
   *   （常见做法：``${vodId}@${line}@${index}``），在 `resolve()` 里拆开。
   */
  id: string;
  title: string;
  /** 排序号。**排序看它，不是数组下标** —— 源站返回顺序常是乱的。 */
  order?: number;
  /** 同源下的多线路标识（可选）。 */
  playerId?: string;
}

/** 详情（含多线路 + 剧集）。 */
export interface MediaDetail {
  /** 与 `detail(id)` 收到的 id 一致即可（宿主会自己补前缀）。 */
  id: string;
  title: string;
  cover?: string;
  description?: string;
  badges?: string[];
  kind?: MediaKind;
  /** 扩展元数据（年份 / 地区 / 评分 / 演员等），宿主原样透传给详情页。 */
  meta?: Record<string, unknown>;
  /** ★ 播放线路。 */
  sources?: PlaySource[];
  /** ★ 剧集列表。 */
  episodes?: Episode[];
}

/** 流类型。填错会让宿主走错解码路径（表现为「一直转圈但没有任何报错」）。 */
export type StreamKind =
  /** HLS（`.m3u8`） */
  | 'hls'
  /** DASH（`.mpd`） */
  | 'dash'
  /** 直链 MP4（也兜底其它未知格式） */
  | 'mp4'
  /** 只能内嵌网页播放 */
  | 'web_embed'
  /** 仅音频（降级 / 广播） */
  | 'audio_only';

/** 播放候选流。`resolve()` 返回的是**数组**（多清晰度 / 多线路给多个候选）。 */
export interface StreamCandidate {
  url: string;
  kind: StreamKind;
  /**
   * 清晰度标签，如 `'1080P'`。
   *
   * ★ **显示用的是它** —— 有些站点所有线路的 `label` 都一样，
   *   只有 `quality` 能区分（央视就是这样）。
   */
  quality?: string;
  /** 线路名，如 `'官方 HLS'` / `'CDN 直连'`。 */
  label?: string;
  /**
   * 播放该流需要的请求头（防盗链）。
   *
   * ★ **两种形态都合法**（宿主都认，2026-10-09 实测）：
   *   · 对象 —— `{ Referer: 'https://...' }`（推荐，宿主转成键值对）
   *   · 数组 —— `[['Referer', 'https://...']]`（Rust 侧字段本来就是
   *     `Vec<(String, String)>`，数组形态直接可用；TVBox 转换的插件多写这个）
   *
   * ⚠️ `<video>` 自己加不了请求头 —— 需要头的时候通常还要
   *    同时设 `notWebReady: true`，让宿主起本地代理转发。
   *    两个字段**必须一起给**：只给 headers 不给 notWebReady 不会走代理。
   */
  headers?: Record<string, string> | [string, string][];
  /**
   * 声明「WebView / `<video>` 播不了，需要宿主代理」。
   *
   * 典型场景：需要 `Referer` 的直链、DASH 音视频分离的轨。
   * 设了它，宿主会把地址改写成自己的本地代理地址并代加请求头。
   */
  notWebReady?: boolean;
  /**
   * 该流受 **DRM 保护**，客户端解不开。
   *
   * ⚠️ 如实标注：这类流的表现是**画面花屏 / 绿屏但时间在走**，
   *    标出来 UI 才能说「该源受 DRM 保护」，而不是让用户对着绿屏猜。
   */
  drmProtected?: boolean;
  /**
   * 独立的**音频轨**地址（DASH 音视频分离时用）。
   *
   * 例：B 站的 DASH 把视频轨与音频轨分成两个文件，
   * 只给 `url` 会**只有画面没声音**。
   */
  audioUrl?: string;
  /**
   * 直播源的原始 tag（`tvg-id` / `group-title` / `tvg-logo` 等）。
   *
   * ⚠️ 键名是**连字符**形态（`'group-title'`），不会被命名转换影响。
   */
  tags?: Record<string, string>;
}

/** 直播频道。 */
export interface LiveChannel {
  id: string;
  name: string;
  logo?: string;
  /** 分组名（直播页按它归类）。 */
  group?: string;
  /** 当前节目名（已知时给）。 */
  nowPlaying?: string;
}

/** 节目单条目。 */
export interface EpgEntry {
  title: string;
  /** 开始时间，**Unix 秒**。 */
  start: number;
  /** 结束时间，**Unix 秒**。 */
  end: number;
  /** 显示用的时间文本。 */
  showTime?: string;
  /** 时长（秒）。 */
  duration?: number;
  /** 是否可回看。 */
  replayable?: boolean;
}

/**
 * 平台自带观看历史的一条 —— `platformHistory()` 的返回元素。
 *
 * ⚠️ 与 [UserRecord] 不是一回事：这个是**站点侧的只读快照**，
 *    宿主只拿它做备份镜像，不会回写（已由 Owner 确认）。
 */
export interface PlatformHistoryEntry {
  /** 平台侧的条目 id（宿主会存原样，不做前缀拼接）。 */
  videoId: string;
  title: string;
  cover?: string;
  /** 看到第几集（多集内容）。 */
  episodeTitle?: string;
  /** 播放位置（秒）。 */
  position?: number;
  /** 最后观看时间（平台侧原文，通常是 ISO 8601）。 */
  updatedAt?: string;
}

/** 登录会话。 */
export interface Session {
  /**
   * 令牌。
   *
   * ★ 只返回 `token`、不返回 `expiresAt` 也**合法** ——
   *   宿主会尝试从 JWT 的 `exp` 声明兜底算到期时间。
   *   但如果 token 既不是 JWT、又不给 `expiresAt`，
   *   宿主就无从判断过期，界面可能一直显示「已登录」而实际请求都失败。
   */
  token: string;
  /** 到期时间，**Unix 秒**。 */
  expiresAt?: number;
  displayName?: string;
  avatar?: string;
}

/** 扫码登录：申请二维码的结果。 */
export interface QrLoginStart {
  /** 轮询用的凭据（各站叫法不同：qrcode_key / uuid / ticket）。 */
  key: string;
  /** 二维码里要编码的地址（用户扫的就是它）。 */
  url: string;
  /** 提示语，如「请用 B站 App 扫码」。 */
  hint?: string;
  /**
   * 二维码 SVG —— **由宿主渲染，插件不要提供**（QuickJS 里没有 canvas）。
   */
  svg?: string;
}

/** 扫码登录：轮询到的状态。 */
export type QrLoginStatus = 'pending' | 'scanned' | 'confirmed' | 'expired' | 'failed';

/** 扫码登录：一次轮询的结果。 */
export interface QrLoginPoll {
  status: QrLoginStatus;
  /** 给用户看的一句话。 */
  message?: string;
  /** 仅在 `status === 'confirmed'` 时有值。 */
  session?: Session;
}

/** `list()` / `rank()` 的请求参数。 */
export interface ListRequest {
  /** 分类 id —— 来自 `home()` 里 `source.categoryId`。 */
  categoryId?: string;
  /** 页码，**从 1 开始**。 */
  page?: number;
}

/** `resolve(id, req)` 的第二个参数。 */
export interface PlayRequest {
  /** 播放线路 code（用户切线路时给）。 */
  sourceCode?: string;
  /**
   * 剧集 id（用户选的那一集）。
   *
   * ⚠️ 宿主会把上面的 provider 前缀剥掉再传给你，你拿到的是**自己当初给的 id**。
   * ⚠️ 对「剧集 id 就是剧集地址」的源（TVBox 系），
   *    宿主还会把 `resolve()` 的**第一个参数**也换成这个地址 ——
   *    所以两个参数都按你的约定读即可。
   */
  episodeId?: string;
  /** 用户指定的清晰度。 */
  quality?: string;
}

// ─────────────────────────── 能力与配置 ───────────────────────────

/**
 * 能力位 —— 宿主据此决定界面上显示什么。
 *
 * ⚠️ **只声明你真正实现了的。** 声明了却没实现 →
 *    界面上会出现一个「永远空白」的区块，用户会以为是软件坏了。
 */
export interface Capabilities {
  /** 点播。需要实现 `home` / `list` / `detail` / `resolve`。 */
  vod?: boolean;
  /** 搜索。需要实现 `search`。 */
  search?: boolean;
  /** 直播。需要实现 `liveChannels` / `liveStream`。 */
  live?: boolean;
  /** 节目单。需要实现 `epg`。 */
  epg?: boolean;
  /** 平台内多播放源（多线路）。 */
  multiSource?: boolean;
  /** 平台自带服务端观看历史。 */
  serverSideHistory?: boolean;
  /** 支持收藏。 */
  favorites?: boolean;
  /** 支持时移回看。需要实现 `timeshift`。 */
  timeshift?: boolean;
  /** 支持弹幕。 */
  danmaku?: boolean;
  /**
   * **必须**登录才能取流（游客完全用不了）。
   *
   * ⚠️ 如果你的源游客也能用，就**必须**用 `loginSupported` 而不是这个 ——
   *    设了 `loginRequired: true` 会让没登录的用户**彻底无法使用这个源**。
   */
  loginRequired?: boolean;
  /** 可以登录，但**游客也能用**（登录是可选增强）。需要实现 `login` / `session`。 */
  loginSupported?: boolean;
  /** 登录弹窗里的说明（告诉用户该怎么操作）。 */
  loginHint?: string;
  /** 登录是否需要「账号」字段，**默认 true**。Cookie 导入式登录设 `false`。 */
  loginNeedsUsername?: boolean;
  /** 支持**扫码**登录。⚠️ 必须同时设 `loginSupported: true`，否则登录入口不出现。 */
  loginQrSupported?: boolean;
  /** 能用保存的凭据**自动重新登录**（或实现 `canAutoLogin()` 方法，两者取或）。 */
  canAutoLogin?: boolean;
}

/** `config` 声明的控件类型（宿主只认这六种，写别的会降级成纯文字）。 */
export type ConfigKind =
  /** 开关 → `host.config.getBool` */
  | 'switch'
  /** 下拉 → `host.config.getString` */
  | 'select'
  /** 单行文本 → `host.config.getString` */
  | 'text'
  /** 密码 / 粘贴 Cookie → `host.config.getString` */
  | 'password'
  /** 数字 → `host.config.getNumber` */
  | 'number'
  /** 纯说明文字（不产生值） */
  | 'info';

/** `select` 的一个选项。 */
export interface ConfigOption {
  value: string;
  label: string;
  hint?: string;
}

/**
 * 一个配置项 —— 声明它，宿主会**自动生成设置界面**。
 *
 * ```ts
 * config: [
 *   { key: 'quality', label: '清晰度', type: 'select', default: '1080P',
 *     options: [{ value: '1080P', label: '1080P' }, { value: '720P', label: '720P' }] },
 *   { key: 'proxy', label: '走代理', type: 'switch', default: false },
 *   { key: 'proxyUrl', label: '代理地址', type: 'text', showIf: { proxy: true } },
 * ]
 * ```
 */
export interface ConfigField {
  /** 键名（插件用 `host.config.get('这个')` 读）。 */
  key: string;
  /** 显示名。 */
  label: string;
  /** 控件类型。`type` 与 `kind` 两种写法都接受（推荐 `type`）。 */
  type?: ConfigKind;
  /** 同上（别名）。 */
  kind?: ConfigKind;
  /** 默认值（类型随控件变）。 */
  default?: unknown;
  /** `select` 的选项。 */
  options?: ConfigOption[];
  /** 说明文字（显示在控件下方）。 */
  hint?: string;
  /** 占位符（text / password / number）。 */
  placeholder?: string;
  /** 条件显示：只有这些键**为真**时才显示本项。 */
  showIf?: Record<string, unknown>;
  /** 数值下限（number 用）。 */
  min?: number;
  /** 数值上限（number 用）。 */
  max?: number;
}

// ─────────────────────────── 插件本体 ───────────────────────────

/**
 * 插件对象 —— 赋给 `globalThis.plugin`。
 *
 * 用 `definePlugin()` 定义，能同时拿到参数与返回值的类型提示。
 */
export interface Plugin {
  /**
   * 插件 id。**必须与头部注释的 `@id` 一致** —— 宿主认的是 `@id`。
   *
   * ⚠️ 宿主**从不读对象上的 `id`**（元信息一律由 `parse_meta` 从头部注释解析，
   *    见 Rust `plugins/mod.rs:74`）。写在这里是给人和工具看的，不是给宿主读的。
   */
  id: string;
  /**
   * 显示名。
   *
   * ⚠️ **可选**，而且通常**不用写**：宿主显示插件名一直取自头部注释的 `@name`
   *    （`PluginMeta::name`），**从不读对象上的 `name`**。
   *
   * ★ 2026-10-09 由必填改为可选：原先标成必填，导致每个插件都得把 `@name`
   *   再抄一份到对象里 —— 两份还可能不一致（不一致时以头部为准，对象里那份
   *   纯属误导）。本仓库的示例插件原本就没有这一项 —— 它只写在头部注释里。
   */
  name?: string;
  version?: string;
  author?: string;
  description?: string;
  capabilities?: Capabilities;
  /** 声明式设置界面（宿主自动渲染）。 */
  config?: ConfigField[];
  /** 封面图需要的请求头。⚠️ 必须写成**数组**，不是对象。 */
  coverHeaders?: [string, string][];

  // ── 平台自带数据（备份平面）──
  /**
   * 拉取**站点侧**的观看历史快照，用于备份（换设备不丢进度）。
   *
   * ★ 宿主侧对应的能力叫 `Provider::platform_history()`，经
   *   `backup_platform_history` / `sync_platform_history` 两条命令进入，
   *   最终落到本地 `platform_history` 表（只读镜像：只备份、不回写）。
   *
   * ⚠️⚠️ **名字容易写错，但这里写的那个名字目前也不生效**（2026-10-09 逐行核过）：
   *   · 宿主认的是 `platformHistory`，**不是** `serverHistory` ——
   *     曾经有人（就是我们）写成 `serverHistory()` —— 宿主认的其实是 `platformHistory`。
   *     写错的名字全仓零调用点，一直是段死代码；
   *   · 而且 `JsPluginProvider` **没有覆写 `platform_history`**，
   *     走的是「返回空数组」的默认实现 ⇒ 连正确的名字现在也不会有数据流动。
   *
   *   ⇒ 声明在这里是为了把**正确的名字**定下来（避免继续照着错的写），
   *     等宿主接桥后即可生效。**现阶段不要依赖它。**
   */
  platformHistory?(): Promise<PlatformHistoryEntry[]> | PlatformHistoryEntry[];

  // ── 内容 ──
  /** 首页分区（只返回区块声明，不含内容）。 */
  home?(): Promise<Section[]> | Section[];
  /**
   * 分类树。
   *
   * ★ 这个生态里 **两种形态都合法**，宿主都认：
   *   · 方法 —— `async categories() { ... }`（推荐，本类型走这条）
   *   · 数据 —— `categories: [{ id, name }]`（TVBox 转换器生成的插件这样写）
   *   写成数据数组时用 `categoriesData` 字段（类型上二选一）。
   */
  categories?(): Promise<Category[]> | Category[];
  /** 分类树（数据形态的替代写法，与 `categories()` 二选一）。 */
  categoriesData?: Category[];
  /** 分类内容（分页）。 */
  list?(req: ListRequest): Promise<Page<MediaItem>> | Page<MediaItem>;
  /** 榜单内容（首页 `SectionSource.type === 'rank'` 的区块用）。 */
  rank?(rankId: string, page: number): Promise<Page<MediaItem>> | Page<MediaItem>;
  /** 搜索。 */
  search?(keyword: string, page: number): Promise<Page<MediaItem>> | Page<MediaItem>;
  /** 详情。 */
  detail?(id: string): Promise<MediaDetail> | MediaDetail;
  /** 按线路取剧集（不实现时宿主退回 `detail().episodes`）。 */
  episodes?(id: string, sourceCode: string): Promise<Episode[]> | Episode[];
  /** 列出线路（不实现时宿主退回 `detail().sources`）。 */
  sources?(id: string): Promise<PlaySource[]> | PlaySource[];

  // ── 取流（唯一必须实现的方法）──
  /**
   * 取流 —— **唯一必须实现的方法**。
   *
   * 返回**候选列表**：多清晰度 / 多线路就给多个候选。
   *
   * ```ts
   * async resolve(id, req) {
   *   const d = await getJson(`${API}/play?id=${encodeURIComponent(id)}`)
   *   return [{ url: d.url, kind: 'hls', quality: d.quality ?? '原画' }]
   * }
   * ```
   *
   * @param id 来自 `detail()` 的 `episode.id`（前缀已由宿主剥掉）
   * @param req 线路 / 剧集 / 清晰度（可能为空对象）
   */
  resolve(id: string, req: PlayRequest): Promise<StreamCandidate[]> | StreamCandidate[];

  // ── 直播 ──
  /** 频道列表。 */
  liveChannels?(): Promise<LiveChannel[]> | LiveChannel[];
  /** 某个频道的流。 */
  liveStream?(channelId: string): Promise<StreamCandidate[]> | StreamCandidate[];
  /** 节目单（`day` 形如 `'2026-10-09'`，可能不传）。 */
  epg?(channelId: string, day?: string): Promise<EpgEntry[]> | EpgEntry[];
  /** 时移回看（`start` / `end` 是 Unix 秒）。 */
  timeshift?(channelId: string, start: number, end: number): Promise<StreamCandidate> | StreamCandidate;

  // ── 登录（可选）──
  /**
   * 校验凭据。
   *
   * ⚠️ 参数是**两个位置参数**，不是对象！写成 `login(cred)` 再读 `cred.password`
   *    会拿到 `undefined`（`cred` 其实是字符串），表现是**永远报「没有收到凭据」**。
   *    只需要一个字段时把 `loginNeedsUsername` 设成 `false`，用户输入会落在**第二个**参数里。
   *
   * ⚠️ 失败要**抛错**，不能返回空。
   */
  login?(username: string, password: string): Promise<Session> | Session;
  /** 清掉本地凭据。 */
  logout?(): Promise<void> | void;
  /** 当前会话（可只读本地缓存，别每次都发请求）。没有登录态返回 `null`。 */
  session?(): Promise<Session | null> | Session | null;
  /**
   * 由**插件自己判断**「会话该续期了没」。
   *
   * ⚠️⚠️ **宿主目前不会调它**（2026-10-09 逐行核过）：
   *   `Registry::ensure_session` 的链路（`registry.rs:521`）调的是
   *    **Rust trait** 的 `session_needs_refresh()`，而 `JsPluginProvider`
   *   没有把它桥到插件对象上（全仓搜 `plugin.sessionNeedsRefresh` 零命中）。
   *   也就是说 JS 插件**永远走 trait 的默认实现**：拿 `session()`
   *   返回的 `expiresAt`（缺失时用 JWT 的 `exp` 兜底）算「是不是快到时间了」
   *   （默认窗口 5 分钟，见 `provider.rs:534`）。
   *
   *   本仓库的 `plugins/bilibili.js` 里有个同名的模块级函数并挂进了插件对象，
   *   但因为宿主不桥接，它一次都没被调用过 —— 同样是段死代码。
   *
   * ★ 声明在这里是为了让**写插件的人知道有这条约定**，宿主接桥后即可生效；
   *   现阶段的正确做法是：**不要依赖它**，把续期逻辑放在 `refreshSession()` 里，
   *   并如实给出 `session().expiresAt`。
   *
   * ```ts
   * // 宿主接桥后这样用才有意义；现在写了也不会被调用
   * async sessionNeedsRefresh() {
   *   const left = host.config.getNumber("expiresInSecs", 0)
   *   return left < 1800   // 剩不到半小时就去续
   * }
   * ```
   */
  sessionNeedsRefresh?(): Promise<boolean> | boolean;
  /**
   * ★ **真的发请求校验**当前会话；失效时返回 `null` **并清掉本地凭据**。
   *
   * ⚠️ 校验失败必须清凭据，否则设置页会一直显示「已登录」而每次请求都失败 ——
   *    用户看到的是一个**骗人的状态**。
   */
  refreshSession?(): Promise<Session | null> | Session | null;
  /** 用保存的凭据自动重登。 */
  autoLogin?(): Promise<Session | null> | Session | null;
  /** 是否能自动重登（与 `capabilities.canAutoLogin` 取或）。 */
  canAutoLogin?(): Promise<boolean> | boolean;
  /** 彻底忘记凭据（插件私有存储里的那份）。 */
  forgetCredentials?(): Promise<void> | void;
  /** 申请登录二维码。 */
  qrLoginStart?(): Promise<QrLoginStart> | QrLoginStart;
  /** 轮询扫码状态。 */
  qrLoginPoll?(key: string): Promise<QrLoginPoll> | QrLoginPoll;
}
