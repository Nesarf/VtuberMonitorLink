# 设计说明 / Design

> Vtuber's Monitor Link —— 本地网页式的 VTuber 情报监测工具。
> A local-web VTuber intelligence monitor.

## 1. 总体架构 / Architecture

```
 launcher.exe
      │  起本地服务 + 打开默认浏览器
      ▼
 http://127.0.0.1:<port>   ← 仅监听回环，不对外暴露
      │
      ├─ Web UI (React + Vite)      配置 / 运行 / 报告
      └─ Backend (Node)
           ├─ config.js    配置读写（一切路径与密钥都在这里）
           ├─ net.js       网络层：代理（Node fetch 默认不读系统代理）
           ├─ sources.js   来源适配器目录（声明式）
           ├─ fetchers/    rss / mediawiki-api / browser / search-only
           ├─ digest.js    原始 feed → 精简摘要（控制 token）
           ├─ analyze.js   LLM 分析（OpenAI 兼容）
           ├─ runner.js    编排：前置检查 → 抓取 → 落 feeds → 分析 → 落报告
           ├─ scheduler.js 内置调度器
           └─ reports.js   报告与运行记录存储
```

## 2. 三个「用户可配置」的设计

### 2.1 浏览器

| 模式 | 实现 |
| --- | --- |
| `bundled` | 交给 Playwright 自带的 Chromium，开箱即用 |
| `system` | `detectBrowsers()` 探测系统已装的 Chrome / Edge / Opera / Brave / Vivaldi |
| `custom` | 用户填可执行文件路径 |

要复用登录态时，额外填 `profileDir`（即该浏览器的 user-data-dir）。
注意：**该浏览器必须处于关闭状态**，否则 profile 被锁。

### 2.2 来源（声明式适配器）

```js
{
  id: 'reddit-Hololive',
  category: 'community',
  fetch: 'rss',                    // rss | mediawiki-api | browser | search-only
  url: 'https://www.reddit.com/r/Hololive/.rss',
  login: 'none',                   // none | optional | required
  rateLimit: { gapSeconds: 35, retries: 1 },
  defaultEnabled: true,
}
```

`fetch` 的含义：

| 取值 | 用途 | 实战教训 |
| --- | --- | --- |
| `rss` | Atom/RSS 订阅 | Reddit 只有 `.rss` 可用；限流按 IP，**主动拉开间隔**比连击重试有效 |
| `mediawiki-api` | MediaWiki API | Fandom 的 `Special:RecentChanges` 被 Cloudflare 拦，API 直通 |
| `browser` | 浏览器渲染 | SPA（Twitch/X）与 Cloudflare 站点（萌娘百科）必须走浏览器 |
| `search-only` | 交给分析层检索 | YouTube、Fanbox、BOOTH 等无稳定直抓端点 |

### 2.3 登录要求

| 取值 | UI 表现 | 例子 |
| --- | --- | --- |
| `none` | 绿色 | Reddit、Fandom、各家官方 NEWS |
| `optional` | 黄色 | Twitch（登录后有「正在关注」） |
| `required` | **红色** | X/Twitter（未登录只有登录墙） |

**登录一律由用户在自己的浏览器完成，工具只借用 profile，绝不打包或上传凭据。**

## 3. 网络层与代理

实测结论：**Node 的 `fetch`（undici）默认不读系统代理**，在直连受限的网络下会 `ECONNRESET` / 连接超时。
因此 `net.js` 把代理做成显式配置：

- Node 侧抓取 → `undici` 的 `ProxyAgent` + `setGlobalDispatcher`
- 浏览器渲染 → Playwright 的 `proxy` 选项

UI 提供「探测本机常见代理端口」，逐个试探并填入可用地址（不做唯一硬编码）。

## 4. 报告与节奏

- 常规扫描（默认周更）→ `reports/<date>.md`
- 通贩/付费内容扫描（默认 14 天）→ `reports/merch-<date>.md`
- 抓取原始数据 → `feeds/<date>/`，分析层只吃 `digest.js` 压缩后的摘要，避免 token 爆炸

## 5. 打包

实际采用的形态：**单文件启动器 + `app/` 目录**。

```
dist/VtuberMonitorLink/
  VtuberMonitorLink.exe     Node SEA 单文件启动器（内嵌 Node 运行时，约 90 MB）
  package.json              启动器读取版本号
  README.txt                纯 ASCII 快速上手
  app/                      程序本体（server/ + web/dist/ + node_modules/）
```

### 5.1 启动器为什么要做成 SEA

- 用 Node 自带的 SEA（single executable application）把 `launcher/launch.cjs`
  注入一份 `node.exe`，得到真正的单文件 exe。用户不需要装 Node。
- **入口必须是 CommonJS**：SEA 的嵌入式 `main` 在 Node 24 上仍按 CJS 加载，
  用 ESM 会在运行时报 `Cannot use import statement outside a module`。
  所以启动器是 `.cjs`。
- **SEA 里 `process.execPath` 就是启动器自己**，所以不能靠「重新 spawn 自己」
  去跑程序（会无限递归）。两种运行模式：
  - `spawn`：包里存在 `runtime/node[.exe]` 时，用它拉起 `app/server/src/index.js`；
  - `inline`：包里没有 `runtime/` 时，直接在自身进程里 `import()` 程序入口。
    服务端本来就是磁盘上的普通 ESM，走标准 ESM loader 没有任何问题 —— 受限的
    只是「嵌入的那段 main」。这样能省掉一份 90 MB 的运行时副本，发行包减半。
- 路径解析全部相对启动器自身（`--paths` 可打印实际解析结果），不写死任何机器
  路径；`--doctor` 在打包最后一步自动跑一遍，作为产物的自检门禁。

### 5.2 其它可选形态

| 方案 | 产物 | 说明 |
| --- | --- | --- |
| 单文件 + app/（当前） | `VtuberMonitorLink.exe` + `app/` | 约 112 MB；无外部依赖，解压即用 |
| 同上 + 自带内核 | 再加 `pw-browsers/` | `npm run build:portable`；完全不依赖系统浏览器 |
| 带独立运行时 | 再加 `runtime/node.exe` | `--with-runtime`；启动器改走 `spawn` 模式 |

### 5.3 发布校验

```bash
npm run verify        # 校对：必需文件 / ASCII / UTF-8 / 隐私与密钥残留 / 运行数据
npm run traverse      # 遍历：全部 HTTP 端点、SPA 兜底、错误路径
npm run traverse:ui   # 遍历：真实浏览器里点完四个页面 + 跑一次运行
npm run release       # 上述全套
```

`npm run sanitize-check` 另有一条：扫描仓库源码里的硬编码路径与隐私残留。
私人名字清单**不写死在代码里**（否则检查脚本自己就成了泄漏源），改为读
`$SANITIZE_NAMES` 或仓库根目录下已被 gitignore 的 `.sanitize-names`。
