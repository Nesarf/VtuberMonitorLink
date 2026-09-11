# Bug 记录 / Bug log

持续监测期间的发现，按时间倒序。**只有在能复现或被日志/实测证据支撑时才记进来**；
每条都写明「现象 → 根因 → 修法 → 怎么验的」。

状态：`已修` / `待修` / `不是 bug（实测澄清）`

---

## v1.7.x — 设置区审计与实时监测（2026-09-11）

| # | 现象 | 根因 | 状态 |
| --- | --- | --- | --- |
| 17 | 繁体界面出现「部分繁体 + 部分简体」混排（`情報 / 檢索 / 运行 / 监视`） | 简→繁靠**手写对照表**，而「简繁同形字」与「我漏掉的字」在表里无法区分：`运`/`监` 漏了 → 它们原样留在繁体界面里。586 个汉字里只有 203 个有映射 | **已修**（删掉整张手写表，改为构建期用 **OpenCC 词典**整份生成 `locales/generated.js`：`t`/`hk`/`twp` 三变体，3×447 条。生成器 `tools/i18n-hant.mjs` 带三道自检：① ASCII/占位符结构不许被改；② 差异率异常低＝词典没加载，报错；③ 单字复查「疑似漏转简体字」，未复核的直接让构建失败。`npm run verify` 会校验词条是否最新） |
| 16 | 「自检」把命中的 API Key 原文打印到了终端 | `verify-release.cjs` 报告问题时回显了匹配到的整行 | **已修**（`redact()`：只报文件/行号/长度，输出 `"sk-…<35 chars redacted>"`。**自检的第一职责是不制造泄漏**） |
| 15 | 巡检断言「点开 .html 报告应出现 iframe 预览」总是失败，且点到的其实是 `.md` 那一行 | 用 Playwright `hasText: '.html'` 挑表格行 —— **每行「对比」下拉里都列着别的报告名**，于是 `.html` 的文件名在 `.md` 那一行的文本里也匹配上了 | **已修**（改成先取 `button.link` 的文本列表再按 `/\.html$/` 选名字；断言输出里带上 `clicked=… opened=…`，下次一眼就能看出挑错了行） |
| 14 | `npm run build` 只跑了 vite，没出 exe；直接跑 `node npm-cli.js` 报 `Cannot find module` | `build` 脚本 = `vite build`，打包是独立的 `tools/build-portable.cjs`；而 `npm-cli.js` 不在仓库里（在 Node 安装目录下） | **已修**（打 exe 走 `node tools\build-portable.cjs`；这条写进 RELEASE.md 的流程） |
| 13 | 打包时 `EBUSY: resource busy or locked, copyfile …VtuberMonitorLink.exe` | 正在运行的 app 锁住了 exe | **已修**（先停 app 再打包；脚本给出可操作提示，不再拿过滤后的输出把错误吞掉） |
| 12 | `GET /api/client-log` 返回 500 | 新加的路由用了 `resolveDir` 但没 import（`server.js` 只 import 了 `APP_ROOT`） | **已修**（补 import；JSON 错误兜底把它变成 500 而不是崩进程） |
| 11 | 设置页整个白屏 | 我在 `if (!cfg) return` **之后**加了 `useRef` → 首帧/后续帧 hook 数不一致 → React #310 卸掉整棵树。**同一类错误第二次犯** | **已修**（hook 全部提到早退之前；文件里注释写明踩过两次） |
| 10 | 每次保存配置都排一次补跑；新建的任务立刻被判为「错过」并马上跑 | 补跑判断只看「上次执行 < 上一个应触发时间」：① 没历史 = 从未执行 ⇒ 一律当成错过；② `scheduler.start()` 在 `onConfigChanged` 里，每存一次配置就重排一次 | **已修**（三道闸门：必须跑过至少一次 / 同「任务+时间点」只补一次 / 只补 7 天内。验证：新任务 0 次、真错过 1 次、再存 10 次 0 次） |
| 9 | 任务名输入框每敲一个字发一次 `PUT /api/config`，每次都会把整份配置写盘 | `onChange` 直接落库，没有防抖 | **已修**（本地改 + 停输 800ms/失焦再存。验证：10 字 → 1 次 PUT，修复前 10 次） |
| 8 | 有输入框却不显示（设置页只有一句「请先填入 API Key」） | 那些字段包在 `{active && (...)}` 里，档位数组为空时 `active` 为 null | **不是 bug，但状态不好**（已用 API 预建 DeepSeek 档位） |
| 7 | 设置页某个 `select` 点不动 | 那是「启用代理」，出口已设为 Tor，该字段被**正确禁用** | **不是 bug**（联动是对的） |
| 6 | 任务行的「模式 / 频率」select 没有 label | 表格单元格里没放 `.field` 包裹 | **已修**（表头不是 label，读屏读到的是一个孤立的 combobox。给任务行 7 个控件都补了 `aria-label`，带上任务名做区分；`section.tasks` 的「新增任务」按钮也加了 `.add-task` 钩子，巡检不再按文案选按钮。验证：traverse-ui 断言 `7/7`） |

## v1.6.0 — 用一个新遍历去覆盖「从没跑过的流程」

新增 `tools/traverse-flows.cjs`：把打包 exe + mock LLM + **一个真的本地 webhook 接收器**
一起跑起来，覆盖告警推送实际投递、配置导入导出、情报标记、计划任务执行、LLM 助手。
三个 bug 全是它抓到的：

| # | 现象 | 根因 | 状态 |
| --- | --- | --- | --- |
| 5 | 导入「脱敏导出」的配置会**抹掉已存的 LLM Key** | 合并逻辑对数组是**整体替换**，绕过了「空字符串不覆盖已有非空值」的保护 | **已修**（按 id 合并对象数组） |
| 4 | webhook 地址没打码，`/hook` 这种短路径原样漏出 | 掩码规则只处理 ≥6 字符的末段；而 Discord/飞书的密钥**就在路径里** | **已修**（整条路径与查询串都抹掉） |
| 3 | 给条目打自定义标签**写不进去** | `PATCH /api/intel/:id` 只接受 `starred/read/note`，`tags` 被静默丢弃 | **已修**（接受并清洗，最多 20 个、每个 40 字） |

## v1.5.0 — 特征抽取与 Tor

| # | 现象 | 根因 | 状态 |
| --- | --- | --- | --- |
| 2 | 应用进程直接退出、网页全白 | `features.js` 的 prompt 模板里写了 `${startIndex + n}`，`n` 不存在 → `ReferenceError`；**Express 4 不捕获 async 路由抛错** → 未处理拒绝带走进程 | **已修**（修变量 + `unhandledRejection`/`uncaughtException` 兜底 + JSON 错误中间件；并让遍历捕获被测应用的 stdout/stderr —— 正是这条改动找到了根因） |
| 1 | 报告页一个标题都没有、导出只有 1.3KB | mock LLM 用 `/共\s*(\d+)\s*条/` 判断是不是抽取请求，而**报告 prompt 里也有这句话** → 报告被换成了 JSON 数组 | **已修**（只按 system prompt 区分两条路径） |

## v1.4.0 — 本地检索

| # | 现象 | 根因 | 状态 |
| --- | --- | --- | --- |
| — | 打包后的 exe 起不来（`Invalid or unexpected token`） | `3D披露` / `2434` 作为对象键**没加引号** —— 以数字开头的键不是合法标识符，整个模块加载失败。打包脚本只看 `--doctor`，那时还没加载到出错的模块，完全没拦住 | **已修**（加引号 + `verify` 新增「随包每个 .js/.cjs/.mjs 跑 node --check」） |
| — | B 站免登录图文动态一设时间区间就被整批排除 | `opus/feed/space` 的 `pub_time` 为空，条目没有时间戳 | **已修**（回落到「首次见于哪次运行」并标 `tsSource`） |
| — | 内容类型是 HTML 却让前端 `JSON.parse` | 路由抛错时 Express 默认回 HTML 错误页 | **已修**（JSON 错误兜底） |

---

## 持续监测的机制（怎么看见问题的）

三层，缺一层就会有盲区：

1. **服务端请求日志** —— `createApp` 里的中间件记 `METHOD path -> status (ms)`，
   写操作（POST/PUT/PATCH/DELETE）标「写入」，≥400 走 warn。排除了 3 秒一次的 `/api/state` 轮询。
2. **客户端错误信标** —— `web/index.html` 里在**任何模块加载之前**挂 `error` /
   `unhandledrejection` / `console.error` 监听，发到 `POST /api/client-log`，
   落进服务端日志与 `logs/client-errors.jsonl`。同一个错误只报一次，避免刷屏。
   **没有它，页面崩了服务端一无所知** —— 这一条是被 #11 逼出来的。
3. **行为取证** —— `logs/` 下还有 `danmaku.jsonl`（发弹幕审计）、
   `schedule-history.jsonl`（计划任务执行）、`live-state.json`（开播状态基线）。

## 追加：打包/调试流程上的坑（2026-09-12）

| # | 现象 | 根因 | 状态 |
| --- | --- | --- | --- |
| 14 | 反复出现「改了代码但产物没变」：`app/web/dist` 里还是旧的哈希，遍历断言一直失败 | **运行中的 app 锁住了 `dist\...\VtuberMonitorLink.exe`**，`build-portable` 复制 exe 时抛 `EBUSY` 直接中止 —— 后面的「收集 app/」这一步根本没执行，所以前端产物没更新。而我用 `Select-String` 只筛了几行，把失败信息全过滤掉了，看起来像「构建成功」 | **已修**（两点：① 构建脚本捕获 EBUSY 并给出人话提示「exe 正在运行，先关掉或用 --out 换目录」；② 我自己的流程改成**先停 app 再打包**。教训：**过滤构建输出时必须保留错误**） |
| 13 | LLM/API 填写入的地方「找不到」 | 它埋在「设置」里，且字段包在 `{active && ...}` 里 —— 档位数组为空时连输入框都不渲染，只剩一句「请先填入 API Key」 | **已修**（单独拉出独立页面 `pages/Llm.jsx`，并且没有档位时给一个明确的「建一个档位」按钮，不再是死路） |
