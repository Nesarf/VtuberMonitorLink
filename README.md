# Vtuber's Monitor Link

> **本地网页式的 VTuber 情报监测工具** —— 自己选浏览器、自己选站点、自己决定哪些站需要登录。
>
> **A local-web VTuber intelligence monitor** — pick your own browser, your own sources, and which sites require a login.

---

## 中文

### 它做什么

在你本机起一个小服务（默认 `http://127.0.0.1:43110`），用网页界面配置好之后，它会：

1. **按你的勾选抓取站点**（Reddit / Fandom / 萌娘百科 / Twitch / X / YouTube / 各家官方 NEWS / 通贩平台…）
2. **交给 LLM 分析**，产出结构化 Markdown 情报报告（严格区分「已确认」与「传闻」，每条附来源）
3. **落盘到本地** `reports/`，可在网页里直接查看

### 两种用法

**① 直接跑发行版（推荐给只想用的人）**

下载 `VtuberMonitorLink.zip`，解压到任意目录，双击 `VtuberMonitorLink.exe`。
不需要装 Node，不需要管理员权限，不需要命令行。

**② 跑源码（推荐给想改的人）**

```bash
npm install          # 安装依赖
npm run dev          # 开发模式（后端 43110 + 前端 43111）
# 或
npm run build        # 构建前端
npm start            # 生产模式：起服务并自动打开浏览器
```

首次运行请到「设置」里填写 **LLM API Key**；若你的网络需要代理才能出网，请在「设置 → 网络代理」里启用（可点「探测本机常见代理端口」自动填入）。

### 发行版目录结构

```
VtuberMonitorLink/
  VtuberMonitorLink.exe     单文件启动器（内嵌 Node 运行时，约 90 MB）
  package.json              版本号来源
  README.txt                纯 ASCII 快速上手（任何代码页都能正常显示）
  app/                      程序本体
    server/                 后端（Express）
    web/dist/               已构建的前端
    config.json             首次保存设置时生成（含 API Key，注意保密）
    reports/ feeds/ logs/   报告 / 原始抓取 / 运行日志
```

> 移动或重命名整个文件夹都可以；**exe 必须和 `app/` 待在一起**，单独拷走 exe 是跑不起来的。

### 命令行

```
VtuberMonitorLink.exe --help      显示全部参数
VtuberMonitorLink.exe --doctor    自检：运行时 / 程序目录 / 前端构建 / 配置
VtuberMonitorLink.exe --paths     打印解析出来的实际路径（排查用）
VtuberMonitorLink.exe --port 8080 换端口
VtuberMonitorLink.exe --no-open   不自动打开浏览器
```

### 打包发行版

```bash
npm run build:exe        # 产出 dist/VtuberMonitorLink/
npm run build:portable   # 同上，并把 Chromium 也下进 pw-browsers/
```

打包脚本 `tools/build-portable.cjs` 全自动：构建前端 → 生成 Node SEA blob →
复制 `node.exe` 并注入 blob 得到单文件 exe → 收集 `app/` → 安装生产依赖 →
跑一遍 exe 的 `--doctor` 自检。全程只依赖 Node 与 npx，没有别的构建工具。

### 隐私

- **不打包、不上传任何账号或 cookie**；需要登录的站点一律由你自己在自己的浏览器里登录。
- `config.json`、`reports/`、`feeds/`、`logs/` 都不会进版本库（见 `.gitignore`）。
- 发布/提交前可运行自检：`npm run sanitize-check`。

---

## English

### What it does

Runs a small local service (`http://127.0.0.1:43110` by default) with a web UI. Once configured, it will:

1. **Scrape the sources you tick** (Reddit / Fandom / Moegirlpedia / Twitch / X / YouTube / official news pages / merch platforms …)
2. **Analyse them with an LLM** into a structured Markdown intel report (confirmed facts vs. rumours kept separate, each item citing its source)
3. **Save everything locally** under `reports/`, viewable right in the web UI

### Two ways to run

**1. Use the release build (for people who just want to use it)**

Download `VtuberMonitorLink.zip`, unpack it anywhere, double-click
`VtuberMonitorLink.exe`. No Node install, no admin rights, no terminal.

**2. Run from source (for people who want to change it)**

```bash
npm install          # install dependencies
npm run dev          # dev mode (server 43110 + frontend 43111)
# or
npm run build        # build the frontend
npm start            # production: start the server and open a browser
```

On first run, open Settings and paste your **LLM API key**. If your network needs
a proxy, enable it under Settings → Proxy (there is a port-probe button).

### Release layout

```
VtuberMonitorLink/
  VtuberMonitorLink.exe     single-file launcher (embeds Node, ~90 MB)
  package.json              version source
  README.txt                pure-ASCII quickstart (safe on any code page)
  app/                      the application
    server/                 backend (Express)
    web/dist/               prebuilt frontend
    config.json             created on first save (holds your API key - keep it private)
    reports/ feeds/ logs/   reports / raw fetches / run logs
```

> Moving or renaming the folder is fine; **the exe must stay next to `app/`**,
> because that is where it loads the console from.

### Command line

```
VtuberMonitorLink.exe --help      show all options
VtuberMonitorLink.exe --doctor    check runtime / app dir / web build / config
VtuberMonitorLink.exe --paths     print the resolved paths (for troubleshooting)
VtuberMonitorLink.exe --port 8080 use another port
VtuberMonitorLink.exe --no-open   do not open a browser
```

### Building the release

```bash
npm run build:exe        # produces dist/VtuberMonitorLink/
npm run build:portable   # same, plus downloads Chromium into pw-browsers/
```

`tools/build-portable.cjs` does the whole chain: build the frontend → generate the
Node SEA blob → copy `node.exe`, inject the blob to get one single-file exe →
collect `app/` → install production dependencies → run the exe's `--doctor` check.
It needs nothing but Node and npx.

### Privacy

- **No account or cookie is ever bundled or uploaded.** Any site that needs a login is logged into by you, in your own browser.
- `config.json`, `reports/`, `feeds/` and `logs/` are never committed (see `.gitignore`).
- Run `npm run sanitize-check` before publishing.

---

## License

MIT
