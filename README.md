# Vtuber's Monitor Link

> **本地网页式的 VTuber 情报监测工具** —— 自己选浏览器、自己选站点、自己盯住想盯的人与页面。
>
> **A local-web VTuber intelligence monitor** — pick your own browser, your own sources, and the exact pages you want watched.

---

## 中文

### 它做什么

在你本机起一个小服务（默认 `http://127.0.0.1:43110`），用网页界面配置好之后，它会：

1. **按你的勾选抓取站点**（Reddit / Fandom / 萌娘百科 / Twitch / X / YouTube / 各家官方 NEWS / **B 站动态** / 通贩平台…）
2. **检查你指定的监视对象**：某个百科条目、某个任意网页、某个 B 站 UP，给出「改了什么」的 diff 与告警
3. **按「人」而不是按「来源」归拢情报**：填进名字与账号，程序在本地把条目归属到人（纯字符串匹配，不联网、不用 LLM），并显示每次匹配是哪条别名在哪个字段命中
4. **合并多来源的同一件事**：相似度去重 + 来源权重（官方 > 新闻 > 社区 > 社交），并标出「几个来源确认」
5. **交给 LLM 分析**（可选），产出结构化情报报告；配图还可以交给**视觉模型打标**，变成可检索的标签
6. **在网页里直接读与用**：情报卡片流、渲染后的报告、**趋势图表**、**纪念日倒计时**、全文检索、**一键分享成单文件**、导出 Word/Excel

### 十一个页面

| 页面 | 干什么 |
| --- | --- |
| **情报** | 卡片流；可切「合并重复事件」视图；图片标签、命中关注对象、告警关键词都会标出来 |
| **检索** | 纯本地匹配（关键词/标签/时间），不需要 LLM、不需要联网 |
| **直播** | 开播状态（直播/轮播/下播）+ 多屏；频道里可以直接发弹幕（需登录，手动确认） |
| **关注** | 关注名单：名字、别名、账号；单人情报流与单人导出；命中依据可查；**可从 VDB 花名册导入**（自动带上社团与各平台账号） |
| **日历** | 生日 / 出道日 / 3D披露 / 周年倒计时 + 月历；闰日与地区时区都处理了 |
| **运行** | 立即跑一次（常规 / 通贩 / 只检查监视对象），实时进度与日志 |
| **来源** | 30 条内置适配器逐条勾选；单站出口、延迟/丢包、自检；也可可视化新增自定义来源 |
| **监视** | 自定义监视对象 + 告警规则 + 变更历史与 diff |
| **LLM** | 档位（多 provider / 模型 / Key，掩码显示、一键测试、拉模型表）；哪些功能需要它 |
| **设置** | 浏览器、出口（直连/代理/Tor，可按站自动匹配）、定时任务、推送、隐私、界面 |
| **报告** | 趋势图表 + 一键分享 + 报告列表：渲染视图 / 源码、检索、导出、两版对比 |

### 十项能力一览（都有自检）

| 能力 | 要点 |
| --- | --- |
| **纪念日倒计时** | 2/29 在平年顺延到 3/1 并**标出来**；「今天」按你配置的时区算；月历一周起始日跟地区走 |
| **弹幕发送** | **WBI 签名**（nav 取 key → 64 位置换 → `w_rid`）；六道闸门：明确确认、指名账号、现场重读 cookie、本地限速、审计留痕、绝不自动化 |
| **推送与静默时段** | 12 种渠道（Bark / Server酱 / Telegram / **钉钉加签** / 企业微信 / ntfy / Gotify / PushPlus / Slack / Discord / 飞书 / 自定义）；静默期内的通知**入队补发而不是丢弃**，跨午夜正确，配置写坏时 fail-open |
| **按人关注** | 中日文子串匹配 + 拉丁词边界匹配（避免 `Rei` 命中 `Reimu`）；命中带证据 |
| **图片理解打标** | 8 类 kind + 可见文字；按图 URL 缓存；**默认关闭** —— 把图发到外部服务必须你明确开启 |
| **事件合并与来源权重** | IDF 加权相似度（专治「官方公告」这类套话）+ 并查集单链接 + 时间窗；权重可从「谁先报」的历史里自己长 |
| **SQLite 归档与图表** | 按条目 id 幂等增量写入；每天计数；图表用**内联 SVG**，不引图表库 |
| **一键分享** | 零外部引用的单文件 HTML（离线可看）；**按平台如实说明登录需求**，做不到的直接标「不支持」 |
| **多语言与地区** | 25 个地区（含 zh-Hant/HK/TW、en-US/GB/AU/CA、es-ES/419/MX/AR、pt-PT/BR、fr-FR/CA、de/it/ja/ko/ru/uk/pl/sr/ar）；RTL；日期/数字/一周起始日按地区格式化；**数词词形**按 `Intl.PluralRules` 选形（`1 запись / 2 записи / 5 записей`，顺带修掉英语的 `1 items`）；逐条校对与覆盖度棘轮 + 「记号渲染」守卫都进 `verify:fast` |
| **自动出口** | 每个站点按「等效延迟 = 平均延迟 ×（1 + 丢包 × 4）」自动选直连或代理，带粘滞（优势不足 20% 不切换），真实抓取结果会反哺判定 |

### 社团花名册（VDB，多平台）

「按人关注」和「箱视角」缺的那一维是**社团**。手填 30 人就要填 30 次，所以这里接了一份公开花名册：
`github.com/dd-center/vdb`（vtbs.moe 的上游数据库），**一文件一人** —— 多语言名字 + 各平台账号 + 社团。

- **一条请求拿全库**：整库 tarball 只有 **0.54 MB / 10035 条 / 215 个社团**，一次请求一两秒；比逐个调 API 省几千次请求
- **平台无关**：27 个平台（bilibili / youtube / twitter / twitch / tiktok / weibo / acfun / niconico / showroom / pixiv / afdian / ci-en / booth / fantia / marshmallow / instagram / telegram / patreon / line / github …）。搜**任意平台**的账号 id 或链接形态都能命中，代码里不假设 bilibili
- **导入走同一条净化路径**：选中 → 转成关注对象 → 过和手工新增同一个校验，被挡的逐条回报原因，不静默丢弃
- **许可是 CC BY-NC-SA 4.0**：所以**只运行时获取**，缓存在运行期目录，**绝不进仓库、绝不进发行包**（巡检会拦），界面与文档都署名
- 详见 `docs/VDB.md`

### 箱视角、静默与休眠、观测模式、用量与预算

「什么都没发生」也是情报。这四块专门处理**沉默、缺失和代价**：

| 能力 | 要点 |
| --- | --- |
| **箱视角** | 按社团聚合的活跃热力图；同日活动（企划/联动长什么样）；共同静默；以及相对**每个人自己节奏**的异常。填了 Agency 的关注对象才会计入 |
| **静默与停止活动** | 基线取「最近活跃日之间的**平均间隔**」（不是钉在最后活跃日上的窗口 —— 那样每个月只发一次的人看起来像每天都在动）；容差 `间隔×2.5` 并夹在 3~90 天；**回归**要求「最近有活动 + 之前长时间空白」，所以回来的认得出、没回来的不会误报。≥6 个月无动静的进日报**最末尾**的「停止活动 / 毕业」块，附最新内容；突然有动静会标出来 |
| **观测模式** | 「有人把整个名册扫了一遍」这个痕迹本身就是信号。开启后每轮**随机取样**一个子集（按「最久没被抽到」排序，轮换自然补齐覆盖），间隔抖动，**只对日志归属在对方那边的站点**走 Tor，需登录的来源本轮跳过。取舍与实测都写在 `docs/OBSERVE.md` |
| **用量与预算** | 按次、按模型的 token 用量；可选每日预算，80% 告警、超限可拦截整次运行；模型没上报用量时**单列出来**而不是猜 |

### 监视对象（参考萌娘百科的监视技术）

萌百那套 `watchlist-brief` / `recent-changes-brief` 的思路是：**不要只报「变了」，要报「变了什么、变了多少、值不值得看」**。这里照搬并扩展成五类对象：

| 类型 | 在读什么 | 需登录 |
| --- | --- | --- |
| **任意网页** | 抓正文 → 归一化 → 哈希基线 → 行级 diff（可配忽略行正则） | 否 |
| **MediaWiki 条目** | 版本修订 `revid` 比对 + `action=compare` 拿 diff，含字节增减 | 否 |
| **MediaWiki 最近更改** | 最近更改流，按规则筛出值得关注的改动 | 否 |
| **MediaWiki 监视列表** | 你自己的监视列表（BotPassword 登录） | **是** |
| **B 站动态** | 新 opus_id 比对 + 粉丝数变化 | 否 |

告警规则（阈值都可改）：大编辑 / 大删除 / 新建页面 / 匿名编辑 / 未巡查编辑 / 指定日志类型 / **可疑关键词**（默认含毕业、卒業、解约、引退、炎上、休止、终止、解散、独立、移籍…）。

第一次检查只**建立基线**，不会误报；之后每次都给出「谁改的、改了多少、改了哪几行」。

### B 站动态

实测下来的结论（决定了它为什么这么接）：

- `api.bilibili.com` **直连可用，走代理反而稳定 412 / -352 风控** → B 站来源默认标记为直连出口；「网络代理」是全局的，但来源与监视对象都可以单独覆盖成直连。
- 需要先取一次 `buvid3/buvid4`（`x/frontend/finger/spi`）当 cookie，否则裸请求会被 412 拦。
- `x/polymer/web-dynamic/v1/opus/feed/space` **无需登录、无需 wbi 签名**，稳定返回图文动态（正文 + 点赞数 + opus 链接）—— 这是主力路径。
- `x/polymer/web-dynamic/v1/feed/space`（带配图的完整动态）风控极严，只有**复用登录态**才拿得到 → 那个来源标为「需登录」，走浏览器渲染。
- `x/relation/stat` 提供粉丝数，用来做关注量增长追踪。

### 登录态怎么拿（不需要关浏览器）

有些来源（B 站带配图动态、X 推文正文）必须登录。传统做法是「关掉浏览器 → Playwright 复用 profile」，
但那只为了拿一个 Cookie 头，代价太大。所以这里多了一条更轻的路：

**只读复制一份浏览器的 cookie 库来解密提取**，浏览器开着也没关系，不会锁定、不会改动它。

- 路径：`设置 → 浏览器 → 检查登录态`，填要读的域名（默认 `bilibili.com`）即可。
- 实测：Opera / Chromium 内核 130+ 走 `v10`（AES-256-GCM，密钥由 DPAPI 保护）能正常读出，
  明文前 32 字节的域名绑定哈希会自动剥掉。
- **Chrome 127+ 默认开启 App-Bound Encryption**（`v20`），这种在外部无法解密 ——
  工具会明确告诉你，并让你退回「关掉浏览器 + Playwright」那条路，而不是静默失败。
- 拿到的登录态只用于调用对应站点的接口；**cookie 值不会进日志、不会进报告、不会进 `feeds/`**，
  复制出来的临时库用完即删。接口只回报「读到了哪些 cookie 的名字」，从不回传值。

### LLM 自定义

- 内置 9 个提供商预设：DeepSeek / OpenAI / Moonshot·Kimi / 智谱 GLM / 阿里通义 / SiliconFlow / OpenRouter / **本地 Ollama** / 自定义。
- **可以存多个档位随时切换**（例如平时用便宜的、出报告时用贵的），网页里增删改。
- 支持「拉取模型列表」（打 `/models`）与「测试连通性」（`/chat/completions` ping）。
- Key 只存在本机 `app/config.json`；接口只回传掩码 `***`，需要编辑时才在输入框里显示。
- **本机地址（127.0.0.1 / localhost）永远直连**，所以本地 Ollama 不会被代理拦掉。

### 界面语言与翻译管线

界面支持 **25 个地区**（含 `zh-Hans/Hant/HK/TW`、`en-US/GB/AU/CA`、`es-ES/419/MX/AR`、`pt-PT/BR`、`fr-FR/CA`、`de/it/ja/ko/ru/uk/pl/sr/ar`），阿拉伯语走 RTL，日期/数字/一周起始日都按地区格式化。

**回落规则**：只在**同一语言内**继承地区差异（`es-MX → es-419 → es-ES`、`zh-TW → zh-Hant → zh-Hans`…），**跨语言一律落到英文**。这一条是踩过才立的 —— 最初 `uk/pl/sr` 的链里写了俄语，于是把俄语当成乌克兰语显示给使用者，那不是「翻译不够好」，是明确的错误。

**词条层级**（后面的压前面的）：

```
机器译文（可选，最低）  →  人工词条  →  构建期生成（繁体 OpenCC）  →  英文兜底
```

机器译文**单独一层、永远压不过人工** —— 这样「机翻铺过一遍」不会覆盖任何人工校对过的内容，也能随时分清哪些还需要复核。

**翻译管线**（`tools/i18n-translate.mjs`，机制参考 MTool）：

| 机制 | 为什么需要 |
| --- | --- |
| **多引擎可插拔** | 今天用 `mock`（本地假引擎，不花钱跑通管线），明天换成任意 OpenAI 兼容接口；换引擎不改管线。没配 url/key 时**明确拒绝运行**，不拿空 key 去调 |
| **按「源串 + 目标语言」哈希缓存** | 同一句永不重复花钱；改了源串自然是新键。缓存不含任何凭据，可复用 |
| **术语表**（`glossary.json`） | 人名/产品词必须锁死。做法是翻译前把术语换成哨兵 —— 模型根本没机会改它 |
| **占位符保护** | `{target}`、`${x}`、`%s`、换行、`MM-DD` 全部换成哨兵，译完**校验是否全部还原**；缺一个就丢弃该条（宁缺勿坏），绝不写进被模型改坏的值 |
| **增量 + 单条失败不拖垮整批** | 只翻缺失的键；失败的单独记账、下次重试；`--limit` 是本次工作量预算 |

用法：

```bash
npm run i18n:coverage                     # 看每个语言实际覆盖了多少（回落到英文的不算）
npm run i18n:translate -- --missing ja-JP # 列出该语言还没本地化的键（短的优先：按钮/字段）
npm run i18n:translate -- --engine openai --url <接口> --key <key> --locales ja-JP,ko-KR
npm run i18n:review -- ja-JP              # 列出机器译文供人工复核
npm run i18n:coverage:update              # 覆盖度上涨后更新基线（棘轮只许往上）
```

覆盖度是**可测量并卡下限**的：`verify` 会比对 `web/src/locales/coverage.json` 基线，掉下来就报错 —— 「加功能时忘了翻译」不会再悄悄发生。

### 两种用法

**① 直接跑发行版**

下载 `VtuberMonitorLink-1.0.0-win-x64.zip`（Releases 页），解压到任意目录，双击 `VtuberMonitorLink.exe`。
不需要装 Node，不需要管理员权限，不需要命令行。

> 命名约定：**面向使用者的文件用全名**（exe / zip / 解压出来的目录），**内部标识用短名 `VML`**
> （npm 包名、环境变量 `VML_*`、`localStorage` 的 `vml-*`、临时文件…）。
> 这条规则由 `npm run brand` 守着，理由写在 `docs/RELEASE.md` 的 1.0.0 一节。

**② 跑源码**

```bash
npm install
npm run dev          # 开发模式（后端 43110 + 前端 43111）
# 或
npm run build && npm start
```

### 想先试一下、又不想花钱？

仓库自带一个本地 mock LLM（OpenAI 兼容，零依赖）：

```bash
npm run mock-llm         # 监听 127.0.0.1:43197
```

在「设置 → LLM」新增一个自定义档位，接口地址填 `http://127.0.0.1:43197`、Key 随便填、模型填 `mock-model`，
就能把整条链路（抓取 → 监视 → 情报 → 分析 → 报告）跑通，不消耗任何 token。

### 隐私

- **不打包、不上传任何账号或 cookie**；需要登录的站点一律由你自己在自己的浏览器里登录。
- LLM Key 与（可选的）萌百 BotPassword 都只存在本机 `app/config.json`，不入仓库、不进发行包。
- `config.json`、`reports/`、`feeds/`、`logs/`、`watch/`、`thumbs/`、`advice/`、`vdb/` 都不会进版本库（见 `.gitignore`）。
- 发布/提交前可运行自检：`npm run sanitize-check`。

### 发布校验

```bash
npm run verify        # 校对发行包：必需文件 / ASCII / UTF-8 / 密钥与个人路径残留 / 运行数据
npm run traverse      # 遍历全部 HTTP 端点、SPA 兜底、错误路径
npm run traverse:ui   # 真实浏览器里走完十一个页面，并用 mock LLM 真跑一次
npm run brand         # 命名一致性：对外件用全名、内部标识用 VML
npm run english       # 英文覆盖率（工程层 / 界面两侧的百分比）
npm run release       # 上述全套
```

另外四条「约定」类守卫也在这条链里（`verify:fast`）：
`tools/english-logic.mjs`（工程层只许英文 —— 注释与日志，界面词条与产品文案不在此列，
见 `docs/ENGLISH-LOGIC.md`；`npm run english` 会打印覆盖率）、`tools/vml-brand.mjs`（两条名字不许串用）、
`tools/i18n-plural-test.mjs`（数词词形完整性）、`tools/hint-md-test.mjs`（带 markdown 记号的文案必须走 `<Inline>`）。

### 第三方数据与署名

本工具的代码是 MIT，但它会**在运行时**从外部取数据，那些数据有各自的许可与作者：

| 来源 | 用在哪 | 许可 / 署名 |
| --- | --- | --- |
| **[dd-center/vdb](https://github.com/dd-center/vdb)** | 社团花名册（`docs/VDB.md`） | 数据 **CC BY-NC-SA 4.0**、代码 GPL。**只运行时获取、不打包、不二次分发**，界面与文档署名 |
| **[api.vtbs.moe](https://vtbs.moe)** | 直播花名册辅助查询 | 上游服务，仅查询、不缓存分发 |
| **[dd-center/bilibili-dd-monitor](https://github.com/dd-center/bilibili-dd-monitor)** | 多屏直播的**思路**参考 | MIT（Copyright (c) 2020 wdpm）；本工具为**重写**而非搬运（见 `docs/LIVE.md`） |
| 萌娘百科 `watchlist-brief` / `recent-changes-brief` | 监视对象的设计参考 | 思路参考，未搬运代码 |

抓下来的条目本身属于各自的发布者。本工具只是本地聚合，**不转载、不公开分发**任何第三方内容。

---

## English

### What it does

Runs a small local service (`http://127.0.0.1:43110` by default) with a web UI. Once configured, it will:

1. **Scrape the sources you tick** (Reddit / Fandom / Moegirlpedia / Twitch / X / YouTube / official news pages / **bilibili dynamics** / merch platforms …)
2. **Check the watch targets you pin** — one wiki page, one arbitrary URL, one bilibili UP — and report exactly what changed
3. **Group intel by person, not by source**: fill in names and accounts and the app attributes items locally (plain string matching, no network, no LLM), showing exactly which alias hit which field
4. **Merge the same event across sources**: similarity dedupe + source weight (official > news > community > social), with a "confirmed by N sources" marker
5. **Analyse everything with an LLM** (optional) into a structured report; images can be tagged by a vision model and become searchable labels
6. **Show it all in the console**: intel cards, rendered reports, **trend charts**, **anniversary countdowns**, full-text search, **one-click single-file share**, Word/Excel export

### The eleven pages

| Page | What it does |
| --- | --- |
| **Intel** | Every item from the latest run as a card; merge-duplicates view; picture tags, person hits and keyword alerts are flagged |
| **Search** | Pure local matching (keyword / tag / time) — no LLM, no network |
| **Live** | Live status (live / rerun / offline) + multi-screen; you can send a danmaku from the channel (login required, manual confirmation) |
| **People** | The follow list — names, aliases, accounts; per-person feed and export; match evidence on demand; **import from the VDB roster** (brings group and per-platform accounts along) |
| **Calendar** | Birthday / debut / 3D reveal / anniversary countdowns + a month grid; leap days and regional time zones handled |
| **Run** | Collect now (regular / merch / watch-targets-only) with live progress and log |
| **Sources** | Tick any of 30 built-in adapters; per-source egress, latency/loss, self-test; add your own visually |
| **Watch** | Watch targets, alarm rules, change history and diffs |
| **LLM** | Profiles (multi-provider / model / key, masked, one-click test, model list); which features need it |
| **Settings** | Browser, egress (direct / proxy / Tor, auto-matched per site), schedule, notifications, privacy, interface |
| **Reports** | Trend charts + one-click share + report list: rendered / raw, search, export, two-version comparison |

### The ten capabilities (all with self-tests)

| Capability | Highlights |
| --- | --- |
| **Anniversary countdowns** | 2/29 rolls to 3/1 in common years **and says so**; "today" follows your configured time zone; week start follows the region |
| **Danmaku sending** | **WBI signing** (nav → key → 64-slot permutation → `w_rid`); six gates: explicit confirmation, named account, cookie re-read on the spot, local rate limit, audit trail, never automated |
| **Push channels & quiet hours** | 12 channels (Bark / ServerChan / Telegram / **DingTalk signed** / WeCom / ntfy / Gotify / PushPlus / Slack / Discord / Feishu / custom); notifications inside quiet hours are **queued and re-sent, not dropped**, midnight crossing handled, bad config fails open |
| **Follow by person** | CJK substring matching + Latin word-boundary matching (so `Rei` does not hit `Reimu`); every hit carries evidence |
| **Image tagging** | 8 kinds + visible text; cached per image URL; **off by default** — sending images to an external service requires you to turn it on |
| **Event merge & source weight** | IDF-weighted similarity + union-find single link + time window; weights grow from "who reported it first" |
| **SQLite archive & charts** | Idempotent incremental writes keyed by item id; daily counts; charts are **inline SVG**, no chart library |
| **One-click share** | A single HTML file with zero external references (readable offline); **login requirements stated honestly per platform**, unsupported ones are labelled as such |
| **Locales & regions** | 25 locales (zh-Hant/HK/TW, en-US/GB/AU/CA, es-ES/419/MX/AR, pt-PT/BR, fr-FR/CA, de/it/ja/ko/ru/uk/pl/sr/ar); RTL; dates, numbers and week start formatted per region; **plural forms** chosen by `Intl.PluralRules` (`1 запись / 2 записи / 5 записей`, which also fixes the old English `1 items`); per-entry proofreading, a coverage ratchet and a markup-rendering guard all run inside `verify:fast` |
| **Automatic egress** | Each site picks direct or proxy by "effective latency = mean latency × (1 + loss × 4)", with stickiness (no switch below a 20% edge); real fetch results feed the decision back |

### VDB roster (multi-platform)

The dimension "follow by person" and "group view" were missing is **the agency**. Filling in 30 people by hand means 30 forms, so this connects to a public roster: `github.com/dd-center/vdb` (the upstream database behind vtbs.moe), **one file per person** — multilingual names + per-platform accounts + group.

- **The whole database in one request**: the tarball is only **0.54 MB / 10035 records / 215 groups**; one request, a second or two, instead of thousands of API calls
- **Platform-agnostic**: 27 platforms (bilibili / youtube / twitter / twitch / tiktok / weibo / acfun / niconico / showroom / pixiv / afdian / ci-en / booth / fantia / marshmallow / instagram / telegram / patreon / line / github …). Searching **any** platform's account id or URL form works; nothing in the code assumes bilibili
- **Import takes the same sanitising path**: selection → person shape → the same validation as manual entry; anything rejected is reported per row with a reason, never silently dropped
- **Licensed CC BY-NC-SA 4.0**: so it is **fetched at runtime only**, cached in a runtime directory, and **never committed or bundled** (the release checks stop it), with attribution in both the UI and the docs
- Details: `docs/VDB.md`

### Group view, silence & dormant, observation mode, usage & budget

"Nothing happened" is intelligence too. These four blocks deal with **silence, absence and cost**:

| Capability | Highlights |
| --- | --- |
| **Group view** | Per-agency activity heatmap, same-day activity (what a project or collab looks like), joint silence, and per-person anomalies relative to **each person's own cadence**. Only followed people with an Agency filled in are counted (importing from VDB fills it for you) |
| **Silence & dormant** | The baseline is the **average spacing between recent active days** — not a window anchored on the last active day, which makes a once-a-month poster look daily. Tolerance is `gap × 2.5`, clamped to 3–90 days. **Comeback** requires recent activity *and* a long prior gap, so returnees are recognised and quiet accounts are not false-alarmed. Entities idle for 6+ months are collected in a "stopped activity / graduated" block at the very **end** of the daily report with their latest content, and a sudden stir is flagged |
| **Observation mode** | "Someone swept the whole roster" is itself a signal. Each round samples a **random subset** (ranked by least-recently-picked, so rotation fills coverage in), gaps are jittered, Tor is used **only for sites whose logs the other side owns**, and sources that need a login are skipped for that round. Trade-offs and measurements: `docs/OBSERVE.md` |
| **Usage & budget** | Token usage per run and per model; an optional daily budget warns at 80% and can block a whole run; when a model does not report usage those calls are **counted separately instead of guessed** |


### Watch targets (borrowed from Moegirlpedia's watch technology)

MediaWiki's `watchlist-brief` / `recent-changes-brief` idea is: **don't just say "it changed" — say what changed, by how much, and whether it deserves attention.** That is what this does, across five target kinds:

| Kind | What it reads | Login |
| --- | --- | --- |
| **Any web page** | Fetch → normalise → hash baseline → line diff (ignorable lines configurable) | no |
| **MediaWiki page** | `revid` comparison + `action=compare` diff, with byte delta | no |
| **MediaWiki recent changes** | The recent-changes stream, filtered down to what matters | no |
| **MediaWiki watchlist** | Your own watchlist (BotPassword login) | **yes** |
| **bilibili dynamics** | New `opus_id`s plus follower growth | no |

Alarm rules (all thresholds editable): large edit / large delete / new page / anonymous edit / unpatrolled edit / chosen log types / **suspicious keywords** (graduation, contract termination, retirement, scandal, hiatus, dissolution, transfer …).

The first check only **builds a baseline** — it never cries wolf. Later checks say who changed what, by how much, and which lines.

### bilibili dynamics

What the measurements forced:

- `api.bilibili.com` works **direct**, and going through a proxy gets you a steady 412 / -352 risk-control block. So bilibili sources default to the *direct* egress; the proxy setting is global, but sources and watch targets can each override it.
- A bare request is blocked with 412 until you fetch `buvid3/buvid4` from `x/frontend/finger/spi` and send them as cookies.
- `x/polymer/web-dynamic/v1/opus/feed/space` needs **no login and no wbi signature** and reliably returns text/image dynamics (text, likes, opus link) — that is the main path.
- `x/polymer/web-dynamic/v1/feed/space` (full dynamics *with* pictures) is heavily rate/risk-controlled and only works with **a reused login** → that source is marked login-required and rendered in a browser.
- `x/relation/stat` provides the follower count used for growth tracking.

### Getting a login without closing your browser

Some sources need a login (bilibili dynamics with pictures, X post bodies). The old answer was
"close the browser, then let Playwright reuse the profile" — a steep price for one Cookie header.
So there is a lighter path:

**Copy the browser's cookie store and decrypt it read-only.** The browser can stay open; nothing is
locked or modified.

- Settings → Browser → *Check login*, with the domain to read (defaults to `bilibili.com`).
- Measured: on Opera / Chromium 130+ the `v10` scheme (AES-256-GCM, key protected by DPAPI) reads
  fine, including stripping the 32-byte domain-binding prefix Chromium 130+ prepends.
- **Chrome 127+ enables App-Bound Encryption by default** (`v20`), which cannot be decrypted from
  outside. The tool says so explicitly and points you back at the close-the-browser route instead
  of failing silently.
- The login is used only to call that site's own API. **Cookie values never reach a log, a report
  or `feeds/`**, the copied store is deleted immediately, and the HTTP endpoint only ever reports
  cookie *names*, never values.

### LLM

- Nine built-in presets: DeepSeek / OpenAI / Moonshot·Kimi / Zhipu GLM / Alibaba Qwen / SiliconFlow / OpenRouter / **local Ollama** / custom.
- **Keep several profiles and switch between them** — add, edit and delete them in the UI.
- "Fetch models" hits `/models`; "Test connection" pings `/chat/completions`.
- The key lives only in the local `app/config.json`; the API returns a masked `***` and only reveals it in the input when you ask.
- **Loopback addresses are always direct**, so a local Ollama never gets swallowed by the proxy.

### Two ways to run

**1. Use the release build** — download `VtuberMonitorLink-1.0.0-win-x64.zip` from the Releases page, unpack anywhere, double-click `VtuberMonitorLink.exe`. No Node install, no admin rights, no terminal.

> Naming: **user-facing files keep the full name** (exe / zip / the unpacked folder), **internal identifiers use the short brand `VML`** (npm package names, `VML_*` environment variables, `vml-*` storage keys, temp files). `npm run brand` enforces the split.

**2. Run from source** — `npm install`, then `npm run dev` (server 43110 + frontend 43111) or `npm run build && npm start`.

### Want to try it without spending tokens?

The repo ships a local mock LLM (OpenAI-compatible, zero dependencies):

```bash
npm run mock-llm         # listens on 127.0.0.1:43197
```

Add a custom profile in Settings → LLM with base URL `http://127.0.0.1:43197`, any key, model `mock-model`, and the whole pipeline (scrape → watch → intel → analyse → report) runs end to end at no cost.

### Privacy

- **No account or cookie is ever bundled or uploaded.** Any site that needs a login is logged into by you, in your own browser.
- The LLM key and the optional Moegirlpedia BotPassword live only in the local `app/config.json` — never committed, never shipped.
- `config.json`, `reports/`, `feeds/`, `logs/`, `watch/`, `thumbs/`, `advice/`, `vdb/` are never committed (see `.gitignore`).
- Run `npm run sanitize-check` before publishing.

### Third-party data & attribution

The code here is MIT, but the tool **fetches data at runtime** that has its own licence and authors:

| Source | Used for | Licence / attribution |
| --- | --- | --- |
| **[dd-center/vdb](https://github.com/dd-center/vdb)** | The agency roster (`docs/VDB.md`) | Data **CC BY-NC-SA 4.0**, code GPL. **Fetched at runtime, never bundled, never redistributed**, attributed in the UI and docs |
| **[api.vtbs.moe](https://vtbs.moe)** | Roster lookups for the live page | Upstream service; queried only, never cached and redistributed |
| **[dd-center/bilibili-dd-monitor](https://github.com/dd-center/bilibili-dd-monitor)** | The *idea* behind multi-screen live viewing | MIT (Copyright (c) 2020 wdpm); rewritten here, not copied (see `docs/LIVE.md`) |
| Moegirlpedia's `watchlist-brief` / `recent-changes-brief` | Design reference for watch targets | Idea only, no code copied |

Scraped items belong to their own publishers. This tool aggregates them locally and **republishes nothing**.

### Release checks

```bash
npm run verify        # proofread the release: required files / ASCII / UTF-8 / leaked keys & paths / run data
npm run traverse      # walk every HTTP endpoint, the SPA fallback and the error paths
npm run traverse:ui   # walk all eleven pages in a real browser and do a real run against the mock LLM
npm run brand         # naming: user-facing files keep the full name, internal identifiers use VML
npm run english       # English coverage, for both the engineering layer and the UI
npm run release       # all of the above
```

Four convention guards ride along in the same chain (`verify:fast`):
`tools/english-logic.mjs` (the engineering layer is English only — comments and logs; UI strings and
product copy are out of scope, see `docs/ENGLISH-LOGIC.md`; `npm run english` prints the coverage),
`tools/vml-brand.mjs` (the two names must not swap roles), `tools/i18n-plural-test.mjs`
(plural-form tables are complete per language) and `tools/hint-md-test.mjs`
(any string carrying markdown must be rendered through `<Inline>`).

---

## License

MIT
