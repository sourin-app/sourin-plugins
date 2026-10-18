# 数据目录插件 → 私库（2026-10-18）

> 来源：`%APPDATA%\app.sourin.player\plugins\`（32 个 `.js`）
> 去向：本私库 `plugins/`
> 原则：**只读复制，不动数据目录任何文件**

---

## 一、判断：32 个 `.js` 是源码，不是构建产物

### 证据

| 检查项 | 结果 | 含义 |
|---|---|---|
| `sourceMappingURL` | 0 / 32 个文件命中 | 不是构建产物 |
| 最长行长度 | 192–201 字符（154/787 行、api/902 行、cctv/790 行） | 无压缩痕迹（压缩后会达几万字符） |
| 语法 | `const` 44 处、`async` 9 处、箭头函数 5 处 | 现代语法，非 ES5 降级产物 |
| TypeScript 类型注解 | 0 处（函数签名无 `: string` 等） | 不是 TS |
| `import` / `export` | 0 处 | 不是模块文件 |
| **顶层结构** | **32/32 都是 `globalThis.plugin = { ... }` 直挂** | ★ 手写插件的标准写法 |

### 决定性判据：iife 包装

```text
手写：globalThis.plugin = { id: 'xxx', ... }        ← 数据目录 32 个全是这种
产物：(() => { ... })()                            ← 私库 dist/bilibili.js 第 53 行是这种
```

原因是 `build.mjs` 用 esbuild 的 `format: 'iife'`（QuickJS 无模块系统，必须包一层）。
⇒ **有没有 iife 包装，是"手写"与"编出来"最硬的区分点。**

### 来源分布（@author）

```text
  22 个  tvbox-convert    ← TVBox 源批量转换生成（2026-09-18 同一分钟 57ms 内）
   7 个  dsh              ← 手写
   3 个  sourin           ← 手写
```

---

## 二、`build.mjs` 不会误收这些 `.js`

```js
function entriesOf(dir) {
  return readdirSync(abs)
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.d.ts'))  // ★ 只收 .ts
    ...
}
```

⇒ 放进 `plugins/` 的 `.js` **不会**被构建、不会被编译、不与 TS 链冲突。
⇒ 情况 A 成立：直接作为源码放在 `plugins/`。

---

## 三、★ bilibili：两套实现，差异巨大，谁也不许覆盖谁

### 两套实现

| | A：数据目录版 | B：私库产物 |
|---|---|---|
| 位置 | `plugins/_legacy/bilibili-20261012.js` | `dist/plugins/bilibili.js` |
| 源码 | 无（只有这份 JS） | `plugins/bilibili.ts`（1174 行） |
| 行数 | 1630 行 | 591 行 |
| 其中注释 | **908 行（56%）** | 191 行 |
| 其中代码 | ≈ 620 行 | ≈ 398 行 |
| 修改时间 | 2026-10-12 07:48 | 未知（随源码） |

### ★ 关键结论：不是"新旧版本"，是**功能不等**

行数差 1039 行，但**注释差 717 行** —— 光看行数会误判。
按功能点比，真正的差异是：

| 功能 | A（数据目录） | B（私库产物） | 说明 |
|---|---|---|---|
| **番剧 / PGC 取流** | ✅ 支持 | ❌ **完全没有** | A 有 `/pgc/player/web/playurl` 分支 |
| `ep_id` 处理 | 20 处 | **0 处** | A 能播番剧剧集 |
| `season` 处理 | 27 处 | **0 处** | A 能处理季/番剧结构 |
| `bangumi` | 9 处 | 0 处 | 同上 |
| 登录态 / SESSDATA | 21 / 11 处 | 9 / 2 处 | A 更完整 |
| 字幕 subtitle | 5 处 | 2 处 | A 更多 |
| `playurl` 端点 | 8 处（含 PGC 专用） | 1 处（只有投稿视频） | ★ 核心差异 |

**代码片段对照：**

```text
A（1630 行版）第 1572 行：
  `${API}/pgc/player/web/playurl?ep_id=${encodeURIComponent(epId)}` + ...

B（591 行版）resolve 里只有：
  `${API}/x/player/playurl?bvid=...&cid=...&qn=120&fnval=16&fnver=0&fourk=1&try_look=1`
  ⇒ 只处理投稿视频，遇到 ep_id（番剧）走不通
```

### 我的判断

```text
· A（数据目录版）功能更完整 —— 多出完整的番剧/PGC 支持
· B（私库产物）是从 TS 编的，但**那份 TS 源码不含 PGC 分支**

⇒ 最可能的情况：私库的 bilibili.ts 是**较早的版本**，
  而数据目录这份 JS 是后来在别处继续开发、加了 PGC 支持的版本
  （它文件头写「2026-09-27 task-71 新增 PGC 取流」，而私库 TS 里没有这些）

⚠️ 所以**不能用私库覆盖数据目录** —— 会丢掉番剧播放能力。
⚠️ 也不建议用数据目录覆盖私库 —— 那份没有 TS 源码，会破坏构建链。
⇒ 定案前两边都保留，等 Owner 决定。
```

---

## 四、私库现在的结构

```text
plugins/
  bilibili.ts                       ← 原有 TS 源码（1174 行）
  *.js  × 31                        ← 本次从数据目录搬入（原生 JS 源码）
  _legacy/
    bilibili-20261012.js            ← 数据目录那份 bilibili（留档，非主版本）

dist/
  plugins/bilibili.js               ← 原有构建产物（591 行）

build.mjs                           ← 只编译 plugins/*.ts，.js 不受影响
```

---

## 五、以后的同步方法

### 数据目录 → 私库（本方向安全）

```bash
# 1. 看哪些变了（只读）
diff -rq "$APPDATA/app.sourin.player/plugins" plugins --include="*.js" 2>/dev/null

# 2. 逐个复制（显式列名，不要用 *）
cp "$APPDATA/app.sourin.player/plugins/xxx.js" plugins/xxx.js

# 3. 校验
(cd "$APPDATA/app.sourin.player/plugins" && sha256sum xxx.js)
sha256sum plugins/xxx.js
# 两个值必须相同

# 4. 提交（显式路径）
git add plugins/xxx.js && git commit
```

### 私库 → 数据目录（**不要做**，直到 bilibili 定案）

```text
⚠️ 在 bilibili 两套实现定案前，不要从私库往数据目录推任何东西。
   私库的 bilibili.ts 产物缺 PGC 支持，推过去会削掉番剧播放能力。
```

### 以后 TS 化这 31 个时

```text
· `plugins/*.js` 与 `plugins/*.ts` 可以并存，构建只收 .ts
· 逐个 TS 化时：把 .js 内容翻成 .ts → 编出 dist/plugins/*.js → 删掉 plugins/ 下的 .js
· 在完成前，两边靠 sha256 比对保持一致
```

---

## 六、★ 我没做的 / 未定的

```text
❌ 没有改 %APPDATA% 里任何文件（全程只读：head / grep / sha256 / stat / cp）
❌ 没有覆盖私库的 bilibili.ts 或 dist/bilibili.js
❌ 没有覆盖数据目录的 bilibili.js
❌ 没有做 TS 化（31 个仍是原生 JS）
❌ 没有验证这 31 个在 QuickJS 里能跑（只做了格式判断，没跑运行时）

🟡 **未定**：bilibili 两套实现谁是正式版 —— 需要 Owner 决定
🟡 **未定**：数据目录那份 JS 的 PGC 支持要不要反哺进 bilibili.ts
   （那需要实际对比两边取流逻辑，工作量不小，且要真机验证）
```
