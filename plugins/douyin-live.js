/**
 * @id          douyin-live
 * @name        抖音直播
 * @version     1.0.0
 * @author      sourin
 * @description ⚠️ 暂不可用：抖音的直播间列表接口对游客**全程签名校验**，游客态拿不到
 * @homepage    https://live.douyin.com
 *
 * ═══════════════════════════════════════════════════════════════
 *  ⚠️⚠️ 本插件**目前拿不到任何频道** —— 这是**如实结论，不是待办**。
 *
 *  # 我实测到了哪一步（2026-10-14，全部是 curl 真实回包）
 *
 *  ## ① 首页 SSR 里**没有**房间列表
 *  ```text
 *  GET https://live.douyin.com/   → HTTP 200, 980 KB HTML
 *  页面里唯一的 JSON 块是 `<script id="LIVE_SSR_DATA_ID">`，
 *  URL 编码后可解析 —— 但内容**只有 abTestData**：
 *    { "abTestData": { "liveWebSrNew": {...}, ... } }
 *  ★ 房间列表**不在 SSR 里**：整个 980KB 里
 *      "roomId" 只出现在 React 占位（值都是 "$undefined"）
 *      ".flv" / ".m3u8" / "flv_pull_url" / "pull_data"  出现 0 次
 *  ⇒ 列表是**客户端**用签名接口拉的（页面里有 security-secsdk/runtime.js）。
 *  ```
 *
 *  ## ② 已知房间页能拿到 roomId，但同样**没有** stream
 *  ```text
 *  GET https://live.douyin.com/59288147052  → HTTP 200
 *  能解析出 { roomId:"7555682083511913256", web_rid:"59288147052" }
 *  但同一次响应里 "web_stream_url":null，且 .flv/.m3u8 计数为 0。
 *  ```
 *
 *  ## ③ 官方 JSON 接口：三种都试过，**全被拦**
 *  ```text
 *  A) /webcast/web/partition/detail/room/      ← 房间列表
 *       → HTTP 444  "Access Denied / X-TT-System-Error: 3"
 *       （补全 cookie、browser_* 参数、msToken 都不行）
 *  B) /webcast/web/partition/detail/header/    ← 分区列表
 *       → HTTP 200 但正文是
 *         {"status_code":10011,"prompts":"当前服务繁忙，请稍后重试"}
 *  C) /aweme/v1/web/live/list/
 *       → HTTP 404  "Unsupported path(Janus)"
 *  ```
 *  ⇒ 共同点是**缺 `a_bogus` 签名**（douyin 2023 起启用，由页面里的
 *    secsdk JS 生成）。我们这边是纯 JS 插件宿主、**没有浏览器环境**，
 *    复现它需要把 secsdk 的 JS 也塞进插件 —— 那是另一个量级的工程，
 *    且**随时会被字节跳动再改**，不适合作为「一个稳定可用的源」。
 *
 *  ## ④ 房间 `enter` 接口是唯一**能通**的，但拿不到流
 *  ```text
 *  GET /webcast/room/web/enter/?...&web_rid=<rid>   （带 host.http 自动带的 cookie）
 *  → HTTP 200, {"data":{"data":[{"id_str":..., "status":4, ...}]}}
 *  ★ 即使 HTTP 200，`stream_url` 也是 **null** ——
 *    实测那个房间 status=4（未开播），且**回包结构里根本没有
 *    flv_pull_url / hls_pull_url / pull_data 字段**（列表为空）。
 *  ⇒ 也就是说：**即便过了 enter，也拿不到可播地址**。
 *  ```
 *
 *  # 结论与处置
 *
 *  ```text
 *  游客态、无浏览器环境下，抖音直播**拿不到**：
 *    · 列表：签名拦死（444 / 10011）
 *    · 取流：enter 能通但无 stream_url，其余路径同列表
 *  ⇒ 按仓库"宁可如实不可假实现"的口径：
 *    liveChannels() 返回 **空数组**（而不是编造假频道），
 *    liveStream() 抛 **not_found**（而不是编造假 URL）。
 *  ```
 *
 *  # ⚠️ 为什么返回空数组，而不是"抛错让用户看到红字"
 *
 *  宿主 `Registry::live_all()` 对单个源的失败是**跳过**（见 mod.rs 注释），
 *  所以这里抛错与返回空数组，在直播页上的表现**都是"看不到这个源"**。
 *  返回空数组更稳：不会在别的调用路径上产生噪音日志。
 *
 *  # 将来若要接通，需要的是（按优先级）
 *  ```text
 *  ① 实现 a_bogus 签名（要移植 secsdk，且需持续跟进）  —— 成本最高
 *  ② 或让宿主提供"带浏览器指纹的 HTTP 客户端"（本质是①的宿主版）
 *  ③ 或找一个**第三方**聚合接口（稳定性与合规都不可控，不推荐）
 *  ```
 *  ★ 在那之前，本插件**诚实地不可用** —— 比"看着能用其实播不了"强。
 * ═══════════════════════════════════════════════════════════════
 */

globalThis.plugin = {
  id: 'douyin-live',

  capabilities: {
    // ★ 如实声明：只做直播（虽然当前拿不到）
    vod: false,
    live: true,
    epg: false,
    search: false,
    loginRequired: false,
  },

  /**
   * 直播频道列表 —— **当前恒为空**
   *
   * 原因见文件头：抖音的列表接口对游客做 `a_bogus` 签名校验，
   * 纯 JS 插件宿主无浏览器环境，过不去（实测 444 / 10011）。
   *
   * ★ 不编造频道。空数组 = 直播页不会显示本源的任何频道，
   *   用户/维护者一眼就知道"这个源没接通"。
   */
  async liveChannels() {
    host.log.warn(
      '抖音直播：游客态拿不到频道列表（列表接口需 a_bogus 签名，' +
        '实测 444/10011）。详见插件文件头「我实测到了哪一步」。',
    )
    return []
  },

  /**
   * 取流 —— **当前恒抛 not_found**
   *
   * 由于 `liveChannels()` 不产出任何 id，正常路径下宿主根本不会调到这里。
   * 但若有人手动调用（或将来列表接通了而取流没接通），必须**如实报错**，
   * 而不是返回一个编造的 URL —— 那会让用户以为能播，实际黑屏。
   */
  async liveStream(channelId) {
    throw new Error(
      'not_found: 抖音直播暂不可用（游客态无 a_bogus 签名）。' +
        '频道 ' +
        channelId +
        ' 无法取流 —— 详见插件文件头。',
    )
  },
}
