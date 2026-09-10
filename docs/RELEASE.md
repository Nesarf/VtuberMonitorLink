# 发行说明 / Release notes

## v1.1.0

功能扩展版：**网页内完成 LLM 选择与情报呈现、自定义监视对象、B 站纳入情报源**。

### 新增 / Added

1. **LLM 多档位**：9 个提供商预设（DeepSeek / OpenAI / Kimi / 智谱 / 通义 / SiliconFlow / OpenRouter / 本地 Ollama / 自定义），
   可在网页里增删改并随时切换；支持「拉取模型列表」与「测试连通性」；Key 只在设置页需要时以明文显示，
   接口一律只回传掩码。旧版扁平配置会被自动升级成单档位，不用手改文件。
2. **情报卡片流**（新标签页「情报」）：最近一次运行的条目按来源/关键词过滤后铺成卡片，
   B 站配图内联显示（`referrerPolicy="no-referrer"` 绕过防盗链），`[表情]` 单独标出，
   命中告警关键词的条目打标。
3. **监视对象**（新标签页「监视」，参考萌娘百科的监视技术）：五类对象 —— 任意网页、MediaWiki 条目、
   MediaWiki 最近更改、MediaWiki 监视列表（BotPassword 登录）、B 站动态。
   含萌百那套告警规则（大编辑/大删除/新建页面/匿名编辑/未巡查/日志类型/可疑关键词）、
   行级 diff（带上下文片段）、变更历史与基线管理。首次检查只建基线，不误报。
4. **B 站情报源**：新增 5 条来源。免登录的 `opus/feed/space` 为主力（图文动态，含正文与点赞数），
   需登录的完整动态（带配图）走浏览器渲染。详见 README。
5. **分源网络出口**：来源与监视对象可单独设为「跟随全局 / 强制代理 / 强制直连」；
   回环地址永远直连（本地 Ollama 不会被代理拦掉）。
6. **报告页升级**：自写的 Markdown 渲染器（先转义再放行自产标签，绝不做危险注入）、
   渲染/原始双视图、全文检索、单文件 HTML 与 JSON 导出。
7. **自定义来源**：网页里可视化新增/删除 RSS、MediaWiki、B 站 UID、浏览器渲染等来源。
8. **界面**：深色 / 浅色 / 跟随系统主题（保存即生效）；运行结束的桌面通知。
9. **本地 mock LLM**（`npm run mock-llm`）：OpenAI 兼容、零依赖，可在不花钱、不填 Key 的情况下
   把整条链路跑通，也是自动化遍历用的测试替身。

### 本次验证 / Verification evidence

| 检查 | 命令 | 结果 |
| --- | --- | --- |
| 源码隐私自检 | `npm run sanitize-check` | 56 个文本文件，0 处硬编码路径 / 密钥 / 私人名字 |
| 发行包校对 | `npm run verify` | clean —— 必需文件齐全、文本全部 UTF-8 合法、`README.txt`/`package.json` 纯 ASCII、0 份运行数据（含新增的 `watch/`） |
| exe 自检 | `VtuberMonitorLink.exe --doctor` | All checks passed（sea=true, mode=inline） |
| HTTP 端点遍历 | `npm run traverse` | **70/70** —— 新增 LLM 档位、监视对象 CRUD 与基线、情报流过滤、报告检索与导出、自定义来源等阶段 |
| UI 遍历 | `npm run traverse:ui` | **48/48** —— 真实 Chrome 走完六个页面；用 mock LLM **真跑一次**（20 条 B 站动态入情报流），验证 Markdown 渲染成真实元素、导出可下载、桌面通知与主题选项存在、0 控制台错误、0 失败 API 调用 |
| 抓取层冒烟 | `npm run smoke` | 2/2（Reddit `.rss`、Fandom MediaWiki API） |

### 校对/遍历期间发现并修掉的问题

1. **`docs/PUBLISH.md` 里写死了本机绝对路径**，会被打进 `app/docs/` 随发行包分发。
   已改为 `<repo>` 占位，并把该文件纳入发布校对范围。
2. **私有名字清单又一次出现在随包文件里**（这次是 `tools/verify-release.cjs` 的规则表）——
   与上一版 `sanitize-check.mjs` 同一类错误，已一并改为读 `.sanitize-names`。
3. **回环地址被丢给代理**：本地 Ollama / mock LLM 会被代理拦掉，已加硬规则永远直连。
4. **`cadence` 字段语义不清**（上一版遗留）：`effectiveSources` 现在对每条来源显式给出。

### 尚未验证 / Not yet verified

- **用真实 LLM Key 的完整运行**。自动化流程一律用 mock LLM；真实 Key 只应存在于使用者本机。
  无 Key 的降级路径已验证：preflight 立刻返回「未配置 API Key」，状态变 `failed`，不产生半截报告。
- **B 站带配图的完整动态**：需要一份已登录 B 站的浏览器 profile，本机 Opera 里没有 B 站登录态，
  因此该路径只验证了「未登录时会被拦并给出明确提示」，没验证登录后的正常返回。
- **萌百监视列表**：需要 BotPassword，同样只验证了参数校验与失败提示。
  萌百本站（`zh.moegirl.org.cn`）有 Cloudflare 保护，最近的验证用的是 Fandom 的 MediaWiki API。
- Cloudflare 保护的页面（Fandom `Special:`、dic.pixiv.net）无头浏览器仍会被拦。
- Reddit 只有 `.rss` 可用且按 IP 限流（约 1 请求/30 秒）；复用登录态要求目标浏览器完全关闭。

---

## v1.0.0

单文件 exe 发行版。双击即用，不需要装 Node、不需要管理员权限、不需要命令行。

### 产物 / Artifacts

```
dist/VtuberMonitorLink/
  VtuberMonitorLink.exe     Node SEA 单文件启动器（内嵌 Node 24 运行时，89 MB）
  package.json              启动器从这里读版本号
  README.txt                纯 ASCII 快速上手（任何代码页都能正常显示）
  app/                      程序本体
    server/                 后端（Express）+ 生产依赖 node_modules/
    web/dist/               已构建的前端
    docs/ README.md LICENSE config.example.json
dist/VtuberMonitorLink-1.0.0-win-x64.zip   可直接分发的压缩包
```

整个文件夹约 112 MB（其中 89 MB 是 exe 内嵌的运行时）。可以随意移动或改名，
但 **exe 必须和 `app/` 待在一起**。

### 命令行 / CLI

```
VtuberMonitorLink.exe --help      显示全部参数
VtuberMonitorLink.exe --doctor    自检：运行时 / 程序目录 / 前端构建 / 配置
VtuberMonitorLink.exe --paths     打印实际解析出来的路径
VtuberMonitorLink.exe --port 8080 换端口
VtuberMonitorLink.exe --no-open   不自动打开浏览器
```

### 本次验证 / Verification evidence

| 检查 | 命令 | 结果 |
| --- | --- | --- |
| 发行包校对 | `npm run verify` | clean —— 必需文件齐全、30 个文本文件全部 UTF-8 合法、`README.txt`/`package.json` 纯 ASCII、0 处密钥/个人路径、0 份运行数据 |
| exe 自检 | `VtuberMonitorLink.exe --doctor` | All checks passed（sea=true, mode=inline, appRoot/webDist 正确） |
| HTTP 端点遍历 | `npm run traverse` | **39/39** —— 静态层与 SPA 兜底、config 读写回环、24 条来源的字段契约与列表计数、浏览器/代理探测、报告列表与 404、路径穿越被拒、preflight、运行状态机、未知 `/api/*` 返回 JSON 404 |
| UI 遍历 | `npm run traverse:ui` | **25/25** —— 真实 Chrome 里点完 运行/来源/设置/报告 四页，勾选持久化、API Key 输入框为掩码且未预填、代理探测按钮、切换中英双语、0 控制台错误、0 页面异常、0 失败 API 调用 |
| 抓取层冒烟 | `npm run smoke` | 2/2 成功（Reddit `.rss` 43997 B、Fandom MediaWiki API 7714 B） |

### 校对/遍历期间发现并修掉的问题

1. **SEA 入口必须是 CommonJS**：ESM 入口在 Node 24 的 SEA 里直接报
   `Cannot use import statement outside a module`。启动器改为 `launcher/launch.cjs`。
2. **`--port` / `--no-open` 在 inline 模式下失效**：环境变量原本只传给了
   「拉起子进程」那条分支，同进程运行时要写回自己的 `process.env`。
3. **未知 `/api/*` 被 SPA 兜底吞成 `200 + HTML`**：调用方会把 HTML 当成功。
   现在在静态层之前加 `/api` 兜底，返回 JSON 404。
4. **来源清单的 `cadence` 字段只在通贩来源上出现**：消费方得靠「不等于 merch」
   去猜。现在每条来源都显式给出 `daily` / `merch`。
5. **打包把仓库根 `package.json` 复制进产物**：它声明了 npm workspaces，导致
   `npm install` 把所有依赖（含前端工具链）提升到 `app/node_modules`；同时描述
   里有非 ASCII 的破折号。现在改为生成一份专用的纯 ASCII 清单。
6. **隐私自检脚本自己就是泄漏源**：`sanitize-check.mjs` 与 `verify-release.cjs`
   里写死了私人角色名/账号名，随包分发等于把名字送出去。现在改为从
   `$SANITIZE_NAMES` 或 gitignore 掉的 `.sanitize-names` 读取。

### 尚未验证 / Not yet verified

- **一次完整的真实运行**（抓取 → LLM 分析 → 出报告）需要使用者自己的 LLM API Key。
  该 Key 只应存在于使用者本机的 `app/config.json`，有意不放进任何自动化流程，
  也没有预置在发行包里（UI 遍历中已断言输入框为空）。
  无 Key 时的降级路径已验证：preflight 立刻返回「未配置 API Key」，运行状态
  变为 `failed`，不产生半截报告。
- Cloudflare 保护的页面（Fandom `Special:`、dic.pixiv.net）在无头浏览器下仍会被拦，
  走 MediaWiki API 或需要人工登录态。
- Reddit 对浏览器与 `.json` 均拦截，只有 `.rss` 可用，且按 IP 限流（约 1 请求/30 秒）。
- 复用登录态要求目标浏览器**完全关闭**，否则 profile 被锁。

### 已知取舍 / Known trade-offs

- exe 是「启动器 + `app/`」两个部分，为了省掉第二份 90 MB 运行时（`--with-runtime`
  可以找回来，代价是体积翻倍）。
- 若系统里没有 Chrome/Edge/Opera，需要在「设置 → 浏览器」选「随包 Chromium」，
  首次运行会下载内核；也可以用 `npm run build:portable` 预先打进 `pw-browsers/`。
