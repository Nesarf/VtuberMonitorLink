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
npm run traverse:ui   # 遍历：真实浏览器里点完六个页面 + 用 mock LLM 真跑一次
npm run release       # 上述全套
```

`npm run sanitize-check` 另有一条：扫描仓库源码里的硬编码路径与隐私残留。
私人名字清单**不写死在代码里**（否则检查脚本自己就成了泄漏源），改为读
`$SANITIZE_NAMES` 或仓库根目录下已被 gitignore 的 `.sanitize-names`。

## 6. 网络出口：为什么代理不能是全局开关

实测两个方向都会翻车：

- **不过代理**：本机直连被阻断的站点（Reddit、Fandom…）全部 ECONNRESET / 超时；
- **过代理**：B 站反而稳定 412 / -352 风控。

所以 `net.js` 提供三档出口，来源与监视对象都能单独覆盖：

| 取值 | 行为 |
| --- | --- |
| （省略） | 跟随全局 `proxy.enabled` |
| `'proxy'` | 强制走代理 |
| `'direct'` | 强制直连 |

外加一条硬规则：**回环地址永远直连**。本地 Ollama（`127.0.0.1:11434`）与遍历用的
mock LLM 都在本机，丢给代理只会失败。

## 7. 监视系统 / watch

数据模型：

```
config.watch = { enabled, targets: [...], rules: {...} }
<app>/watch/history/<id>.baseline.json   每个对象一份基线
<app>/watch/history/<id>.jsonl           每次有变更就追加一行历史
```

基线是「上次看到的样子」，不是「上次抓到的时间」—— 首次检查只建立基线并明确
标注 `first: true`，绝不计为变更，避免第一次跑就刷一屏假告警。

`diff.js` 是自写的行级 LCS diff，先做公共前后缀裁剪把 DP 规模压下去，超限就退化成
整块替换；`diffHunks()` 只留有变化的片段并带上下文行，供网页直接渲染。

告警判定集中在 `applyRules()`：

| 规则 | 触发条件 |
| --- | --- |
| 大编辑 / 大删除 | 字节增减超过阈值 |
| 新建页面 | MediaWiki `new` 标记 |
| 匿名编辑 | `anon` 标记 |
| 未巡查编辑 | `unpatrolled` 标记 |
| 日志类型 | 命中配置的 logtype 列表 |
| 可疑关键词 | 标题/摘要/正文命中词表 |

URL 型的关键词判定用的是「新增行 + 新内容前 1500 字」，只看新增行会漏掉
「改词不增行」的情况。

## 8. B 站动态

见 README 的「B 站动态」一节。代码在 `server/src/fetchers/bilibili.js`，三条路按优先级：

1. **登录态 + JSON 接口**（首选）：从配置的 profile **只读提取** cookie（`cookies.js`），
   调 `feed/space`。数据最干净 —— 正文、配图、发布时间、点赞数都有，而且**不需要关掉浏览器**。
2. **浏览器渲染**：拿不到登录态时用 Playwright 渲染 `space.bilibili.com/<uid>/dynamic` 抓 DOM。
   要求目标浏览器已关闭；被锁时会把 Playwright 的报错翻译成人话再抛出。
3. **免登录 opus 接口**：`bili-opus` 来源专用，只有正文与点赞数，没有配图。

`cookies.js` 的实测要点：

- cookie 库在 `<userData>/<Profile>/Network/Cookies`（老版本可能少一层 `Network`）；
- 密钥在 `<userData>/Local State` 的 `os_crypt.encrypted_key`：base64 → 去掉 5 字节
  `DPAPI` 前缀 → DPAPI 解出 32 字节 AES 密钥；
- 值前缀 `v10` = AES-256-GCM（nonce 12B / tag 16B）；**明文前 32 字节是 Chromium 130+
  加的域名绑定哈希，必须剥掉**；
- 前缀 `v20` 或 `Local State` 里存在 `app_bound_encrypted_key` = App-Bound Encryption
  （Chrome 127+ 默认），外部解不了 —— 这时要明确报错，不能假装成功；
- 复制时连 `-wal`/`-shm` 一起复制，否则 SQLite 视图可能不一致；
- 全程**不改动原 profile**，所以浏览器开着也能跑。

`feed/space` 的解析要点（都踩过）：

- 必须带 `features=itemOpusStyle`。不带的话新版图文动态的 `major` 是 `MAJOR_TYPE_DRAW`
  且 `items` 为空、`desc` 为 null（正文全丢）；带上之后变成 `MAJOR_TYPE_OPUS`，
  正文在 `major.opus.summary.text`，而**配图的数量与 URL 完全不变**（已对比验证：
  正文覆盖 3→11 / 0→7，配图 5 条 14 图两种模式一致）。
- 判别字段是 `major.type`，不是 `it.type`。
- 转发动态的正文在被转发的 `it.orig` 里，要拼成 `//@原作者: …`。

## 9. LLM 档位

`llm.js` 只依赖 OpenAI 兼容的 `/chat/completions` 与 `/models`：

- `PRESETS` 是预设目录；`newProvider()` 由预设派生一个档位；
- `activeProvider(cfg)` 取当前档位，**并把 v1.0.0 的扁平写法（`llm.apiKey` 等）
  即时降级成单档位**，老配置不用手改；
- `chatRequest()` 统一拼请求体，`analyze.js` / `preflight()` 都走它。

## 10. 情报条目

`items.js` 把各来源的抓取结果统一成一种结构：

```
{ id, kind, sourceId, sourceName, title, text, url, time, images[], stats{}, keywords[] }
```

网页卡片流、报告来源清单、关键词高亮、关注量增长全都吃这一份，落盘在
`<app>/feeds/<date>/_items.json`。这样「呈现层」不必再理解每种抓取方式的差异。

## 11. 多语言 / i18n

界面的每一句话都来自源码里的两本底本（`web/src/i18n.jsx` 的 `STRINGS.zh` / `STRINGS.en`），
其余 23 个地区按**回落链**继承（`zh-TW → zh-Hant → zh-Hans`、`pt-BR → pt-PT` …），
跨语言不继承、一律落到英文。层次优先级：**机器译文 → 人工通用词条 → 该地区自己的词条**
（人工永远压过机器；`locales/overlays.js` 是人工层，`locales/machine.json` 是机器层）。

工具链（全部离线可跑，`npm run verify:fast` 里卡着）：

| 工具 | 回答什么问题 |
| --- | --- |
| `tools/locale-coverage.mjs` | **有没有值** —— 覆盖率与基线棘轮（只算该语言自己提供的键） |
| `tools/i18n-proofread.mjs` | **能不能用** —— 逐条比对显示值与源串：占位符、加粗标记、换行、首尾空格、残留哨兵（结构性 → 直接失败），以及全角标点、术语没生效、跨语言长度离群（可疑项 → 记账不许变多） |
| `tools/i18n-translate.mjs` | **怎么补上** —— 机翻管线：术语与占位符哨兵保护、源串+语言两级缓存、`--bust terms/suspicious/all` 失效策略、`--keys` 定点重译 |
| `tools/i18n-hant.mjs` | 繁体三变体（OpenCC 词典，构建期整份生成，含台/港用词） |

几条被真实事故教出来的规矩（细节见 `docs/BUGS.md` 41~52）：

- **译坏的不如不写**：补译之后仍含原文、或残留 `⟦n⟧` 哨兵 → 不写进机器层，
  界面回落英文（英文没翻译至少不冒犯任何人）；旧值同样是坏的则一并删掉。
- **源串有歧义就是全语言出错**：「天后」被当成「歌后」（Diva / Королева），
  所以带数字的成分要写成带占位符的整句（`{n} 天后`），位置交给各语言自己决定。
- **术语保护会切断复合词**：「监测」会把「开播监测」切成两半，模型于是把「开播」当动词翻。
  复合词要作为**整条术语**进术语表。
- **还欠着的一项**：量词复数（`21 элементов` 应为 `21 элемент`）。界面目前是
  `${n} ${t('items')}` 拼接，单一形式；正式修法是 `t(key, {n})` + `Intl.PluralRules`
  的复数分类表，先把 `items` 这类高频标签改掉（见 BUGS #54，状态：待修）。

## 12. 观测模式 / observation mode

想判断一个箱的真实状态，就得同时看箱内多人；但「同一时刻把整箱扫一遍」这件事本身就是痕迹，
而且**与你是从哪个 IP 来的无关**。所以这一块的取舍是：**Tor 只解决「谁在看」，
取样与抖动才解决「在看什么、什么时候看」**。完整威胁模型、实测数据（B 站经 Tor 慢约 8 倍、
箱自托管站点 anycolor 被 Cloudflare 403、换出口的实测 IP）与配置说明都在 `docs/OBSERVE.md`；
纯逻辑在 `server/src/observe.js`，自检 `tools/observe-test.mjs`（固定随机源钉住行为）。

一句话版本：

- **取样**：每轮随机取一部分（默认 50%）。按「最久没看过」排候选池、再从池里随机取、取完打乱顺序
  —— 纯随机会补得慢，纯 LRU 又变得可预测。本地增量归档保证几天下来画像仍然完整。
- **抖动**：间隔随机（默认 3–12 秒）；`base = 0` 时不抖（显式的「不要等」优先）。
- **按日志归属分出口**：只有箱自托管站点（`AGENCY_HOSTS` 白名单）走 Tor；平台源不动它
  —— 箱看不到那些日志，而经 Tor 更慢、个别接口还会被限流。
- **不发身份**：需要登录态的来源在这一模式下不跑（比 IP 严重得多的一条关联）。
- **换出口**：靠 Tor 的 SOCKS 用户名隔离，不同来源落到不同出口；同一来源同一轮保持一条链路。
- **诚实显示**：运行页与报告都写明「本轮是取样」，并强调「本轮没出现 ≠ 没有动静」。

## 13. 看一个「箱」/ looking at a whole group

「今天有什么新东西」和「这个箱现在怎么样」是两个问题，逐条情报流只回答前一个。
围绕后者有四块（都是纯逻辑 + 离线自检）：

| 模块 | 回答什么 | 自检 |
| --- | --- | --- |
| `silence.js` | 谁停了、停了多久、是不是整箱一起停（判据相对**各人自己的节奏**，不用固定天数） | `silence-test.mjs` 16 项 |
| `groups.js` | 按 agency 的活动热力图、同刻出现（企划联动的形状）、共同沉默、个人异常；`/api/groups` + 关注页的箱视角区块 | `groups-test.mjs` 11 项 |
| `dormant.js` | 停止活动 ≥6 个月的人：日报**最后**统一列他们的最新内容；其中最近又动的单独标「可能复出」 | `dormant-test.mjs` 10 项 |
| `fetchplan.js` | 抓取调度：按出口分组并行（队内串行）、连续失败隔离、抓取方式降级阶梯 | `fetchplan-test.mjs` 15 项 |

两条踩过的坑值得留在代码注释里：基线的窗口**不能锚在「最后一次活跃那天」**（月更的人会被
算成日更，容忍区间塌到 3 天，于是停 5 天就误报）；「复出」**不能只看最后活跃日**
（复出的人最后活跃日就是今天，看上去很健康 —— 要看「在那之前安静了多久」）。

成本方面：`cost.js` 按运行记账（`logs/cost.jsonl`），`/api/cost` 汇总，LLM 页有看板；
预算默认只警告，`llm.budget.onExceed = 'stop'` 才真拦。拿不到用量的调用单独计数，不猜数字。

## 14. 花名册 / roster（VDB）

箱视角与「按人关注」共同缺的那一维是**社团**：手填 30 人就要填 30 次，而「这个人的其他平台账号」
靠抓新闻也凑不齐。所以接了一份公开花名册 `dd-center/vdb`（vtbs.moe 的上游），**一文件一人**：
多语言名字 + `accounts`（平台 → id）+ `group`。

三条设计取舍：

1. **一条请求拿全库**，不做增量、不逐个调 API。整库 tarball 0.54 MB / 10035 条 / 215 个社团，
   一次 `codeload` 请求一两秒；逐个调 GitHub API 要几千次请求、吃配额、日志噪声大。
   花名册变化极慢，TTL 7 天。
2. **平台无关是硬要求**，不是「顺便支持 B 站以外」。`accounts` 里有什么平台就收什么平台
   （`PLATFORM_URLS` 27 个：bilibili / youtube / twitter / twitch / tiktok / weibo / acfun / niconico /
   showroom / pixiv / afdian / ci-en / booth / fantia / marshmallow / instagram / telegram / patreon /
   line / github …）。别名生成、搜索、导入全都按「平台 → id」的通用形状走，代码里没有
   「if (platform === 'bilibili')」这种分支。搜索时输入**任何平台**的 id 或链接形态都能命中。
3. **许可是数据的一部分**。VDB 数据是 **CC BY-NC-SA 4.0**、代码 GPL，而本项目是 MIT：
   于是**只运行时获取**，缓存在 `app/vdb/`，**绝不进仓库、绝不进发行包**（`.gitignore` +
   `make-zip` 排除清单 + `verify-release` 的运行期状态清单，三处都盯着），界面与文档都署名来源。

导入不是后门：选中的记录先转成标准关注对象形状，再过**和手工新增同一个** `sanitizePerson()`
（id 冲突、别名、链接合法性都在那里挡），被挡的逐条回报原因。

上游标准里有两条和我们独立设计的规则**撞上了**：它的删档条件是「删除历史信息…且 **6 个月无活动**」，
与我们「停止活动」判定的 6 个月一致；它的社团收录要求 **≥2 位成员**佐证，我们的箱级信号要求
**≥3 位成员**才下结论 —— 同一种谨慎，算一次交叉验证。有社团的只占 17.6%（1770/10035），
这不是数据缺陷而是现实，所以界面不把「没有社团」当异常。

细节（数据形状、许可边界、接口、自检、没做的事）在 `docs/VDB.md`；纯逻辑在 `server/src/vdb.js`
与 `server/src/tar.js`（零依赖 tar 读取），自检 `tools/vdb-test.mjs` 25 项。

