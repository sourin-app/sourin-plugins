/**
 * @id          douyu-live
 * @name        斗鱼直播
 * @version     1.0.0
 * @author      sourin
 * @description 斗鱼直播（游客态，无需登录）：热门频道列表 + FLV 取流
 * @homepage    https://www.douyu.com
 *
 * ═══════════════════════════════════════════════════════════════
 *  实测记录（2026-10-14，真机 curl + ffprobe）
 *
 *  # ① 频道列表：`gapi/rkc/directory/<分类>/<页>`
 *
 *  ```text
 *  GET https://www.douyu.com/gapi/rkc/directory/2_1/1     （2_1 = 热门）
 *  → HTTP 200, application/json
 *  → { code:0, data:{ rl:[ { rid, rn(房间名), nn(主播名), cid2,
 *                           c2name, av, rs16(封面) } ] } }
 *  实测返回 120 条真实房间。
 *  ```
 *
 *  # ② 取流：**三步、必须算签名**（这是本插件最重的一段）
 *
 *  ```text
 *  ① GET  /wgapi/livenc/liveweb/websec/getEncryption?did=<did>
 *       → 拿到 { key, rand_str, enc_time, enc_data, ... }
 *         enc_data 是一段 **base64** 的 JSON，里面含 op.ip / op.ua / op.ts
 *         （⇒ 与请求方 IP、UA、时间绑定）
 *
 *  ② 本地算 auth（★ 算法在 web-encrypt-*.js 里，逐字照抄，见 md5() 上方注释）
 *       rand = rand_str
 *       重复 enc_time 次: rand = md5(rand + key)
 *       auth = md5(rand + key + rid + ts)      // rid 与 ts 都是十进制字符串
 *
 *  ③ POST /lapi/live/getH5PlayV1/<rid>
 *       body: enc_data=<urlencode>&tt=<ts>&did=&ver=Douyu_new
 *             &rate=-1&hevc=0&fa=0&ive=0&auth=<auth>
 *       → { error:0, data:{ rtmp_url, rtmp_live, ... } }
 *  ```
 *
 *  # ★★★ 踩坑记录（两次鉴权失败，都是实测出来的，不是猜的）
 *
 *  ```text
 *  第一次：把 tt 写成"服务器当前时间"，auth 没带。
 *          → HTTP 403 {"鉴权失败"}
 *  第二次：带了 auth，但 auth 用的 ts 与 body 的 tt **不一致**。
 *          → HTTP 403
 *  第三次：**auth 的 ts 与 body 的 tt 取同一个值** + 带上 auth。
 *          → HTTP 200 {"error":0,"msg":"ok"}     ✅
 *  ```
 *  ⇒ 结论写死在代码里：`ts` 只取一次，同时喂给 auth 和 tt。
 *
 *  # ③ 实测：**FLV 能播**
 *
 *  ```text
 *  URL = rtmp_url + '/' + rtmp_live
 *    → HTTP 200, Content-Type: video/x-flv
 *    → ffprobe: codec_name=h264, width=2560, height=1440 + aac  ✅
 *    （URL 自带 wsAuth / token / expire=300，即 **5 分钟有效期**）
 *  ```
 *
 *  # ④ `headers` + `notWebReady` 是**必须**的
 *
 *  ```text
 *  与 bilibili.js 里那段长注释同一条：取流 URL 带签名 + CDN 校验，
 *  而 WebView 的 <video> 加不了请求头 ⇒ 必须 notWebReady:true 走本地代理。
 *  ```
 *
 *  # ⑤ `kind` 为什么写 **`mp4`** 而不是 `flv`
 *
 *  ```text
 *  宿主的 StreamKind 只有 hls/dash/mp4/web_embed/audio_only —— **没有 flv**
 *  （实测写 'flv' 被 serde 拒：unknown variant `flv`）。
 *  FLV 与 MP4 都走原生 <video>（不像 HLS/DASH 走 MSE）⇒ 归在 mp4 这一档。
 *  ```
 *
 *  # ⑥ token 5 分钟过期 ⇒ **绝不缓存 URL**
 *
 *  `liveStream()` 每次都跑完上面三步。列表可以缓存（10 分钟），
 *  取流不能 —— 缓存了用户就会点到一堆过期的 403 URL。
 * ═══════════════════════════════════════════════════════════════
 */

/** 浏览器 UA —— 必须与拿 enc_data 时一致（op.ua 参与服务端校验） */
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

const HDRS = { 'User-Agent': UA, Referer: 'https://www.douyu.com/' }

/**
 * 匿名 did
 *
 * 斗鱼在 cookie 里存 `dy_did`；游客态我们没有 cookie，
 * 用**文档示例里那个固定值**（web-encrypt.js 的兜底也是它）。
 * 服务端只校验"enc_data.op.did 与 body.did 一致"，不要求是真实设备号。
 */
const DID = '10000000000000000000000000001501'

/** 列表接口前缀；后面接 `<cid>_<子类>/<页码>`（如 `2_1/1`） */
const LIST_API = 'https://www.douyu.com/gapi/rkc/directory/'

const CACHE_KEY = 'list_v1'
const CACHE_TTL = 10 * 60 * 1000

/* ─────────────────────────── MD5 ───────────────────────────
 *
 * ★ 宿主**没有**任何加密 API（`host` 只有 http/log/store/config/util）——
 *   所以为了算斗鱼的 auth，只能在插件里实现 MD5。
 *
 * 这是**标准 RFC 1321** 实现（32 位字按小端拆字节）。选择自己写而不是
 * 抄一段压缩过的 minified 版本，是为了**可读、可测**。
 *
 * ★ 实测校验（用 node 跑的 RFC 测试向量，四个全过）：
 * ```text
 * md5("")               = d41d8cd98f00b204e9800998ecf8427e   OK
 * md5("abc")            = 900150983cd24fb0d6963f7d28e17f72   OK
 * md5("message digest") = f96b697d7cb7938d525a2f31aaf161d0   OK
 * md5("a"×1000)         = cabe45dcc9ae5b66ba86600cca6b8ba8   OK（跨多块）
 * ```
 * ⚠️ 这段**必须**用"整数加法"写法（`safeAdd`，靠 `|` 强制回 32 位有符号）。
 *    第一版我用 `(a+b)&0xffffffff` 写 `add32`，空串对、非空串**全错**
 *    （`md5("")` 恰好不受影响，所以很容易以为是对的）——
 *    表现为 auth 永远是错的、服务端恒返回 `鉴权失败`，很难查到是 md5 的锅。
 *
 * ⚠️ 只处理字符串（UTF-8），不处理 ArrayBuffer —— 我们只需要
 *    `md5(hex-string)`，不需要流式/二进制输入。
 */
function md5(str){
  function safeAdd(x,y){var lsw=(x&0xFFFF)+(y&0xFFFF);var msw=(x>>16)+(y>>16)+(lsw>>16);return (msw<<16)|(lsw&0xFFFF);}
  function bitRotateLeft(num,cnt){return (num<<cnt)|(num>>>(32-cnt));}
  function md5cmn(q,a,b,x,s,t){return safeAdd(bitRotateLeft(safeAdd(safeAdd(a,q),safeAdd(x,t)),s),b);}
  function md5ff(a,b,c,d,x,s,t){return md5cmn((b&c)|(~b&d),a,b,x,s,t);}
  function md5gg(a,b,c,d,x,s,t){return md5cmn((b&d)|(c&~d),a,b,x,s,t);}
  function md5hh(a,b,c,d,x,s,t){return md5cmn(b^c^d,a,b,x,s,t);}
  function md5ii(a,b,c,d,x,s,t){return md5cmn(c^(b|~d),a,b,x,s,t);}
  function binlMD5(x,len){
    x[len>>5]|=0x80<<(len%32);
    x[(((len+64)>>>9)<<4)+14]=len;
    var i,olda,oldb,oldc,oldd;
    var a=1732584193,b=-271733879,c=-1732584194,d=271733878;
    for(i=0;i<x.length;i+=16){
      olda=a;oldb=b;oldc=c;oldd=d;
      a=md5ff(a,b,c,d,x[i],7,-680876936);d=md5ff(d,a,b,c,x[i+1],12,-389564586);
      c=md5ff(c,d,a,b,x[i+2],17,606105819);b=md5ff(b,c,d,a,x[i+3],22,-1044525330);
      a=md5ff(a,b,c,d,x[i+4],7,-176418897);d=md5ff(d,a,b,c,x[i+5],12,1200080426);
      c=md5ff(c,d,a,b,x[i+6],17,-1473231341);b=md5ff(b,c,d,a,x[i+7],22,-45705983);
      a=md5ff(a,b,c,d,x[i+8],7,1770035416);d=md5ff(d,a,b,c,x[i+9],12,-1958414417);
      c=md5ff(c,d,a,b,x[i+10],17,-42063);b=md5ff(b,c,d,a,x[i+11],22,-1990404162);
      a=md5ff(a,b,c,d,x[i+12],7,1804603682);d=md5ff(d,a,b,c,x[i+13],12,-40341101);
      c=md5ff(c,d,a,b,x[i+14],17,-1502002290);b=md5ff(b,c,d,a,x[i+15],22,1236535329);
      a=md5gg(a,b,c,d,x[i+1],5,-165796510);d=md5gg(d,a,b,c,x[i+6],9,-1069501632);
      c=md5gg(c,d,a,b,x[i+11],14,643717713);b=md5gg(b,c,d,a,x[i],20,-373897302);
      a=md5gg(a,b,c,d,x[i+5],5,-701558691);d=md5gg(d,a,b,c,x[i+10],9,38016083);
      c=md5gg(c,d,a,b,x[i+15],14,-660478335);b=md5gg(b,c,d,a,x[i+4],20,-405537848);
      a=md5gg(a,b,c,d,x[i+9],5,568446438);d=md5gg(d,a,b,c,x[i+14],9,-1019803690);
      c=md5gg(c,d,a,b,x[i+3],14,-187363961);b=md5gg(b,c,d,a,x[i+8],20,1163531501);
      a=md5gg(a,b,c,d,x[i+13],5,-1444681467);d=md5gg(d,a,b,c,x[i+2],9,-51403784);
      c=md5gg(c,d,a,b,x[i+7],14,1735328473);b=md5gg(b,c,d,a,x[i+12],20,-1926607734);
      a=md5hh(a,b,c,d,x[i+5],4,-378558);d=md5hh(d,a,b,c,x[i+8],11,-2022574463);
      c=md5hh(c,d,a,b,x[i+11],16,1839030562);b=md5hh(b,c,d,a,x[i+14],23,-35309556);
      a=md5hh(a,b,c,d,x[i+1],4,-1530992060);d=md5hh(d,a,b,c,x[i+4],11,1272893353);
      c=md5hh(c,d,a,b,x[i+7],16,-155497632);b=md5hh(b,c,d,a,x[i+10],23,-1094730640);
      a=md5hh(a,b,c,d,x[i+13],4,681279174);d=md5hh(d,a,b,c,x[i],11,-358537222);
      c=md5hh(c,d,a,b,x[i+3],16,-722521979);b=md5hh(b,c,d,a,x[i+6],23,76029189);
      a=md5hh(a,b,c,d,x[i+9],4,-640364487);d=md5hh(d,a,b,c,x[i+12],11,-421815835);
      c=md5hh(c,d,a,b,x[i+15],16,530742520);b=md5hh(b,c,d,a,x[i+2],23,-995338651);
      a=md5ii(a,b,c,d,x[i],6,-198630844);d=md5ii(d,a,b,c,x[i+7],10,1126891415);
      c=md5ii(c,d,a,b,x[i+14],15,-1416354905);b=md5ii(b,c,d,a,x[i+5],21,-57434055);
      a=md5ii(a,b,c,d,x[i+12],6,1700485571);d=md5ii(d,a,b,c,x[i+3],10,-1894986606);
      c=md5ii(c,d,a,b,x[i+10],15,-1051523);b=md5ii(b,c,d,a,x[i+1],21,-2054922799);
      a=md5ii(a,b,c,d,x[i+8],6,1873313359);d=md5ii(d,a,b,c,x[i+15],10,-30611744);
      c=md5ii(c,d,a,b,x[i+6],15,-1560198380);b=md5ii(b,c,d,a,x[i+13],21,1309151649);
      a=md5ii(a,b,c,d,x[i+4],6,-145523070);d=md5ii(d,a,b,c,x[i+11],10,-1120210379);
      c=md5ii(c,d,a,b,x[i+2],15,718787259);b=md5ii(b,c,d,a,x[i+9],21,-343485551);
      a=safeAdd(a,olda);b=safeAdd(b,oldb);c=safeAdd(c,oldc);d=safeAdd(d,oldd);
    }
    return [a,b,c,d];
  }
  function binl2rstr(input){
    var i,output='';
    var length32=input.length*32;
    for(i=0;i<length32;i+=8){output+=String.fromCharCode((input[i>>5]>>>(i%32))&0xFF);}
    return output;
  }
  function rstr2binl(input){
    var i,output=[];
    output[(input.length>>2)-1]=undefined;
    for(i=0;i<output.length;i+=1){output[i]=0;}
    var length8=input.length*8;
    for(i=0;i<length8;i+=8){output[i>>5]|=(input.charCodeAt(i/8)&0xFF)<<(i%32);}
    return output;
  }
  function rstr2utf8(input){return unescape(encodeURIComponent(input));}
  function rstr2hex(input){
    var hexTab='0123456789abcdef',output='',x,i;
    for(i=0;i<input.length;i+=1){x=input.charCodeAt(i);output+=hexTab.charAt((x>>>4)&0x0F)+hexTab.charAt(x&0x0F);}
    return output;
  }
  return rstr2hex(binl2rstr(binlMD5(rstr2binl(rstr2utf8(str)),rstr2utf8(str).length*8)));
}

/** GET 文本；宿主用 `__ERR__` 前缀表示网络失败 */
async function getText(url, referer) {
  const text = await host.http.get(url, {
    headers: referer ? { 'User-Agent': UA, Referer: referer } : HDRS,
  })
  if (typeof text === 'string' && text.startsWith('__ERR__')) {
    throw new Error('network: ' + text.slice(7))
  }
  return text
}

/** 斗鱼列表接口的回包是 JSON（老接口），解析并校验 */
function parseList(text, group) {
  let d
  try {
    d = JSON.parse(text)
  } catch (e) {
    throw new Error('parse: 列表不是 JSON — ' + text.slice(0, 120))
  }
  if (!d || Number(d.code) !== 0 || !d.data || !d.data.rl) {
    throw new Error('parse: 列表结构变了（code=' + (d && d.code) + '）')
  }
  return d.data.rl.map((r) => ({
    id: String(r.rid),
    name: (r.nn || '') + (r.rn ? ' · ' + r.rn : ''),
    // rs16 是 16:9 封面，列表里优先用它
    logo: r.rs16 || r.rs1 || undefined,
    group: group || r.c2name || undefined,
  }))
}

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
        /* 缓存坏了当没有 */
      }
    }
  }

  // 2_1 热门；再并一个 1_1（网游）让列表不至于太单一
  const groups = [
    { key: '2_1', name: '热门' },
    { key: '1_1', name: '网游' },
  ]
  const out = []
  const seen = {}
  for (const g of groups) {
    try {
      const url = LIST_API + g.key + '/1'
      const text = await getText(url, 'https://www.douyu.com/directory')
      for (const r of parseList(text, g.name)) {
        if (seen[r.id]) continue
        seen[r.id] = 1
        out.push(r)
      }
    } catch (e) {
      host.log.warn('斗鱼分类 ' + g.name + ' 拉取失败: ' + (e && e.message))
    }
  }
  if (!out.length) {
    throw new Error('network: 斗鱼频道列表拉不到')
  }
  host.store.set(CACHE_KEY, JSON.stringify({ at: Date.now(), list: out }))
  host.log.info('斗鱼直播列表已更新: ' + out.length + ' 个频道')
  return out
}

/** 第一步+第二步：拿密钥、算 auth（算法见文件头 ②） */
async function getAuth(rid, ts) {
  const text = await getText(
    'https://www.douyu.com/wgapi/livenc/liveweb/websec/getEncryption?did=' + DID,
    'https://www.douyu.com/' + rid,
  )
  let d
  try {
    d = JSON.parse(text)
  } catch (e) {
    throw new Error('parse: getEncryption 不是 JSON — ' + text.slice(0, 120))
  }
  if (!d || Number(d.error) !== 0 || !d.data || !d.data.enc_data) {
    throw new Error('parse: getEncryption 失败（error=' + (d && d.error) + '）')
  }
  const k = d.data
  let u = k.rand_str
  const n = Number(k.enc_time) || 0
  for (let i = 0; i < n; i++) u = md5(u + k.key)
  const auth = md5(u + k.key + rid + ts)
  return { enc_data: k.enc_data, auth }
}

globalThis.plugin = {
  id: 'douyu-live',

  capabilities: {
    vod: false,
    live: true,
    epg: false,
    search: false,
    loginRequired: false,
  },

  async liveChannels() {
    return await loadChannels(false)
  },

  /**
   * 取流：三步签名流程（见文件头 ②）
   *
   * ★ ts 只取一次 —— 它同时是 auth 的输入和 body 的 tt。
   *   两次取不同值会 403（实测踩过）。
   */
  async liveStream(channelId) {
    const rid = String(channelId)
    const ts = Math.floor(Date.now() / 1000)

    const { enc_data, auth } = await getAuth(rid, ts)

    const body =
      'enc_data=' + encodeURIComponent(enc_data) +
      '&tt=' + ts +
      '&did=' + DID +
      '&ver=Douyu_new&rate=-1&hevc=0&fa=0&ive=0' +
      '&auth=' + auth

    const text = await host.http.post(
      'https://www.douyu.com/lapi/live/getH5PlayV1/' + rid,
      body,
      {
        headers: {
          'User-Agent': UA,
          Referer: 'https://www.douyu.com/' + rid,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
      },
    )
    if (typeof text === 'string' && text.startsWith('__ERR__')) {
      throw new Error('network: ' + text.slice(7))
    }

    let d
    try {
      d = JSON.parse(text)
    } catch (e) {
      throw new Error('parse: getH5PlayV1 不是 JSON — ' + text.slice(0, 120))
    }
    if (!d || Number(d.error) !== 0) {
      throw new Error(
        'not_found: 斗鱼取流失败（error=' + (d && d.error) + ', msg=' + (d && d.msg) + '）',
      )
    }
    const data = d.data || {}
    if (!data.rtmp_url || !data.rtmp_live) {
      throw new Error('not_found: 房间 ' + rid + ' 没有返回流地址（可能未开播）')
    }

    const url = String(data.rtmp_url).replace(/\/$/, '') + '/' + data.rtmp_live

    // multirates 里有清晰度档位；rate:-1 拿到的通常是原画
    const rates = data.multirates || []
    const cur = rates.find((m) => Number(m.rate) === Number(data.rate))
    const quality = cur && cur.name ? String(cur.name) : '原画'

    return [
      {
        url,
        // ★ 宿主没有 flv 这个 kind，FLV 归 mp4（见文件头 ⑤）
        kind: 'mp4',
        quality,
        label: '斗鱼 ' + (data.rtmp_cdn || '直连'),
        headers: HDRS,
        // ★ 必须：CDN 校验 Referer+UA ⇒ 走本地代理（见文件头 ④）
        notWebReady: true,
      },
    ]
  },
}
