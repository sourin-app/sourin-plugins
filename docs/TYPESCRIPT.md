# TypeScript

本仓库的示例插件**用 TypeScript 写**，构建成单个 JS 文件后交给播放器加载。

```text
src/        SDK —— 类型定义 + definePlugin() / getJson()
plugins/    示例插件（.ts 源码）
dist/       构建产物（.js）—— **这个才是丢给播放器的文件**
```

## 常用命令

```bash
pnpm install
pnpm run typecheck     # tsc --noEmit，类型检查（编辑器里也能直接看到提示）
pnpm run build         # 构建到 dist/
pnpm run build:watch   # 改一个编一个
pnpm run check         # 两个都跑
```

## 安装插件

**装构建产物，不是 .ts 源码** —— 播放器读的是 `dist/` 里的文件：

```text
dist/plugins/bilibili.js   →  播放器的插件目录（设置 → 内容源 → 安装插件，选这个文件）
```

## 为什么必须构建（不能直接写 JS 吗）

能，但 TS 给你两样 JS 给不了的东西：

| | JavaScript | TypeScript |
|---|---|---|
| 参数/返回值类型 | 无提示，靠记忆 | 编辑器直接提示，写错立刻红 |
| 上游接口数据 | `d.list[0].vod_name` 拼错到运行时才报 | 声明 interface，拼错**编译期**就报 |
| 契约字段 | `quality` / `label` / `notWebReady` 靠翻文档 | 补全列表 + 悬停看说明 |

而插件运行的 QuickJS 环境**没有 `import` / `require`**，所以 TS 必须打成一个自包含的 JS 文件 ——
这就是 `build.mjs` 的作用（esbuild，iife 格式）。

## build.mjs 的三条硬断言

构建完会**逐条检查**产物，不满足直接报错退出：

1. **头部注释必须还在** —— 宿主靠 `/** @id xxx */` 识别插件，
   esbuild 默认会剥掉普通注释，所以是用 `banner` 把它贴回去的（本项目踩过这个坑）。
2. **产物里不能有 `import` / `export`** —— QuickJS 不支持模块语法。
3. 产物不能是空的。

## 类型从哪来

`src/types.ts` 与 `src/host.d.ts` 是**照着宿主实现逐条核出来的**，不是设计稿。
每处约定都写了对应的宿主行为与踩坑记录，要改请连同播放器仓库的
`rust/sourin_core/src/plugins/mod.rs` 一起改。

## 照着示例写

`plugins/bilibili.ts` 是一份**完整、真跑过**的示例：1180 行，覆盖了
首页分区、分类、列表、排行、搜索、详情、取流、登录（Cookie 导入）全部方法。

它是**真实在用的插件**，不是伪代码 —— 所以里面那些注释记的都是实测结论
（比如为什么必须用 DASH 的 `try_look=1`、为什么必须挑 avc1 而不是 hvc1）。
看不懂某个方法时，直接照它的写法改。
