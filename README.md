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
3. **交给 LLM 分析**，产出结构化 Markdown 情报报告（严格区分「已确认」与「传闻」，每条附来源）
4. **在网页里直接读**：情报卡片流、渲染后的报告、变更历史与 diff、全文检索、单文件 HTML 导出

### 六大页面

| 页面 | 干什么 |
| --- | --- |
| **情报** | 最近一次运行抓到的条目铺成卡片流；配图内联显示，命中告警关键词的会标记出来 |
| **运行** | 立即跑一次（常规 / 通贩 / 只检查监视对象），实时进度与日志 |
| **来源** | 30 条内置适配器逐条勾选；也可可视化新增自定义来源 |
| **监视** | 自定义监视对象 + 告警规则 + 变更历史与 diff |
| **设置** | 浏览器、LLM 多档位、代理、定时、主题与桌面通知 |
| **报告** | 渲染视图 / 原始 Markdown、全文检索、导出 HTML/JSON |

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

### 两种用法

**① 直接跑发行版**

下载 `VtuberMonitorLink.zip`，解压到任意目录，双击 `VtuberMonitorLink.exe`。
不需要装 Node，不需要管理员权限，不需要命令行。

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
- `config.json`、`reports/`、`feeds/`、`logs/`、`watch/` 都不会进版本库（见 `.gitignore`）。
- 发布/提交前可运行自检：`npm run sanitize-check`。

### 发布校验

```bash
npm run verify        # 校对发行包：必需文件 / ASCII / UTF-8 / 密钥与个人路径残留 / 运行数据
npm run traverse      # 遍历全部 HTTP 端点、SPA 兜底、错误路径
npm run traverse:ui   # 真实浏览器里走完六个页面，并用 mock LLM 真跑一次
npm run release       # 上述全套
```

---

## English

### What it does

Runs a small local service (`http://127.0.0.1:43110` by default) with a web UI. Once configured, it will:

1. **Scrape the sources you tick** (Reddit / Fandom / Moegirlpedia / Twitch / X / YouTube / official news pages / **bilibili dynamics** / merch platforms …)
2. **Check the watch targets you pin** — one wiki page, one arbitrary URL, one bilibili UP — and report exactly what changed
3. **Analyse everything with an LLM** into a structured Markdown report (confirmed facts vs. rumours kept separate, each item citing its source)
4. **Show it all in the console**: an intel card stream, rendered reports, change history with diffs, full-text search, single-file HTML export

### The six pages

| Page | What it does |
| --- | --- |
| **Intel** | Every item from the latest run as a card; pictures inline, keyword hits flagged |
| **Run** | Collect now (regular / merch / watch-targets-only) with live progress and log |
| **Sources** | Tick any of 30 built-in adapters, or add your own visually |
| **Watch** | Watch targets, alarm rules, change history and diffs |
| **Settings** | Browser, LLM profiles, proxy, schedule, theme and desktop notifications |
| **Reports** | Rendered / raw Markdown, full-text search, HTML/JSON export |

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

**1. Use the release build** — download `VtuberMonitorLink.zip`, unpack anywhere, double-click `VtuberMonitorLink.exe`. No Node install, no admin rights, no terminal.

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
- `config.json`, `reports/`, `feeds/`, `logs/` and `watch/` are never committed (see `.gitignore`).
- Run `npm run sanitize-check` before publishing.

### Release checks

```bash
npm run verify        # proofread the release: required files / ASCII / UTF-8 / leaked keys & paths / run data
npm run traverse      # walk every HTTP endpoint, the SPA fallback and the error paths
npm run traverse:ui   # walk all six pages in a real browser and do a real run against the mock LLM
npm run release       # all of the above
```

---

## License

MIT
