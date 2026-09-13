# 发行说明 / Release notes

## v1.7.0

**社团（箱）花名册（多平台）+ 箱视角 / 静默与休眠 / 观测模式 / 用量与预算。**

### 新增 / Added

1. **VDB 花名册（`server/src/vdb.js` + `server/src/tar.js`，关注页「从 VDB 导入关注对象」）**：
   `dd-center/vdb`（vtbs.moe 的上游）**一文件一人** —— 多语言名字 + 各平台账号 + 社团。
   - **一条请求拿全库**：整库 tarball **0.54 MB / 10035 条 / 215 个社团**（实测），
     一次 `codeload` 请求；逐个调 GitHub API 要几千次请求，对使用者与上游都更吵。TTL 7 天，可手动同步。
   - **平台无关**：27 个平台（bilibili / youtube / twitter / twitch / tiktok / weibo / acfun / niconico /
     showroom / pixiv / afdian / ci-en / booth / fantia / marshmallow / instagram / telegram / patreon /
     line / github …）。搜索**任意平台**的账号 id 或链接形态都能命中，代码里没有「只认 B 站」的分支。
   - **导入走同一条净化路径**：先转成标准关注对象形状，再过和手工新增同一个 `sanitizePerson()`，
     被挡的逐条回报原因（重复 id、别名不合法…），不静默丢弃。
   - **许可**：VDB 数据是 **CC BY-NC-SA 4.0**（代码 GPL），本项目是 MIT → **只运行时获取**，
     缓存在 `app/vdb/`，**绝不进仓库、绝不进发行包**（`.gitignore` + `make-zip` 排除 + `verify-release` 校验），
     界面与文档都署名。详见 `docs/VDB.md`。
2. **箱视角 / 静默与休眠 / 观测模式 / 用量与预算**（`silence.js` `groups.js` `dormant.js` `fetchplan.js`
   `cost.js` `observe.js`）：设计取舍见 `docs/DESIGN.md` §12–13，观测模式的威胁模型与实测见 `docs/OBSERVE.md`。
   - 静默判据取「最近活跃日之间的**平均间隔**」，不锚在最后活跃日上；容差 `间隔×2.5`（夹 3~90 天）；
     复出要求「最近有活动 + 之前长时间空白」。
   - ≥6 个月无动静的人：日报**最末尾**统一列最新内容（保证日报时效性），突然有动静会标出来。
   - 抓取层：按出口分组并行（队内串行 + 抖动）、连续失败隔离（默认 3 次失败隔离 6 小时）、
     抓取方式降级阶梯（API/RSS → 浏览器）。
   - 用量：按运行与模型记账，预算默认只警告，`onExceed='stop'` 才真拦；模型没上报用量的调用单独计数。

### 本次验证 / Verification evidence

| 检查 | 命令 | 结果 |
| --- | --- | --- |
| 快速自检（22 步） | `npm run verify:fast` | 全过 —— 含 25 个语言 × 615 词条的逐条校对（结构性破坏 **0**，可疑 17 条记账）、花名册 25 项、提示语渲染守卫 5 项、图片打标 25 项 |
| 发行包校对 | `npm run verify` | clean —— 71 个文本文件、0 处密钥/个人路径、0 份运行数据、`app/vdb/` 不在包里 |
| 发行 zip | `tools/make-zip.mjs` | **1338 个文件 / 40.3 MB**，排除运行期状态；抽查确认包内**没有** `app/config.json`、`app/vdb/`、`app/reports/`、`app/logs/` |
| exe 自检 | `VtuberMonitorLink.exe --doctor` | All checks passed（sea=true, mode=inline） |
| HTTP 端点遍历 | `npm run traverse` | **80/80** —— 新增第 8b 节「花名册」：状态接口**离线可答**、带来源与许可署名、不把整库塞进响应、空选择导入被拒、花名册里没有的 key 被拒并给出原因 |
| UI 遍历 | `npm run traverse:ui` | **202/202** —— 真实浏览器走完十一个页面 + 用 mock LLM 真跑一次（20 条条目入情报流）；新增花名册区块与箱视角热力图的渲染断言；0 控制台错误、0 失败 API 调用 |
| 花名册真实数据 | 开发期实测 | 上游 tarball **0.54 MB → 10035 条记录 / 215 个社团**（有社团的 1770 条，17.6%）；与 `tar.exe` 对账，条目数与上游文件数一致 |

### 追加：工程逻辑英文化 + 数词词形 / engineering layer in English + plural forms

> 使用者要求「把工程逻辑全英文化」，边界是：**注释、服务器日志、测试与巡检输出**改英文；
> **界面词条、API 错误串、`docs/*.md`、以及会被使用者看到的产品文案（日报/推送/界面提示）保持中文**。
> 规则写成 `docs/ENGLISH-LOGIC.md`，并由 `tools/english-logic.mjs` 守进 `verify:fast`。

| 检查 | 命令 | 结果 |
| --- | --- | --- |
| 工程层语言守卫 | `node tools/english-logic.mjs` | **clean**（扫描 118 个文件；注释与输出串里没有中文） |
| 数词词形自检 | `node tools/i18n-plural-test.mjs` | **27/27** —— 含完整性棘轮：某语言用到的每个类别都必须有词形 |
| 提示语渲染守卫 | `node tools/hint-md-test.mjs` | 5/5 |
| 逐条校对 | `node tools/i18n-proofread.mjs` | 25 个语言 × 615 词条，**结构性破坏 0**，可疑 17 条（记账） |
| 快速自检（25 步） | `npm run verify:fast` | 全过 |
| 发行链 | `npm run release` | build-portable ✓ · verify-release **clean**（72 个文本文件） · traverse **80/80** · traverse:ui **202/202** · zip **1339 文件 / 40.3 MB** |

这一批顺带修掉的真问题（细节见 `docs/BUGS.md`）：

1. **阿拉伯语界面真的显示过 `⟦n⟧`**（BUGS #64）：管线哨兵检测只认 `⟦数字⟧`，带**名字**的哨兵一路进了
   `machine.json` 并显示给使用者。现已把 `i18n-proofread.mjs` 与 `i18n-translate.mjs` **两处**检测
   都放宽成「任意 `⟦…⟧`」——原来那两处是不对称的（校对认数字、翻译期闸门也认数字）。
2. **守卫脚本自己有两个盲区**（BUGS #65）：`log?.info(...)` 匹配不上、正则字面量里的引号会让
   字符扫描**失步**（其后的中文注释全部漏报）。补完后立刻多报出 6 处此前隐形的中文。
   同时加了具名逃生口 `english-logic:allow`，只用于「注释必须引用 CJK 字符本身」的场合。
3. **`vdb-test` 里「slug 稳定」的断言偶发红**（BUGS #66）——它调用两次 `slug('')` 再比较，
   而空名字的兜底 id 故意带时间戳（避免撞号），于是**看着像测确定性，其实在测时钟**。
   现在断言真正的契约：非空名字必须稳定 + 空名字返回合法形状。
4. 数词词形（原 BUGS #54，已修）：`21 элементов` → `21 запись/записи/записей`，
   同时修掉英语的 `1 items`。做法见 `docs/DESIGN.md` §11。

### 追加：界面词条补齐 + 抽读英文注释 / missing UI entries + English comment review

> 英文化那一轮**只动工程层**，于是界面里 30 处硬编码中文被留在原地 —— 它们没有 `t()` 键，
> 25 个地区都显示中文。这一轮把它们全部补成词条（zh 文案逐字不变，所以中文界面与巡检断言都不受影响）。
> 同时抽读了 68 个文件的英文注释，修掉翻译腔与事实错误。

| 检查 | 命令 | 结果 |
| --- | --- | --- |
| 界面硬编码中文 | 脚本扫描 `web/src/**/*.jsx`（排除词条本体） | **0 处**（此前 30 处） |
| 语言覆盖度 | `node tools/locale-coverage.mjs` | 25 个地区 **633/633**（新增 20 个词条、机器层已补齐；分母从 635 降到 633 是因为 `peopleItems` / `chartsDays` 这两个键被复数感知的共用键接管，不再是「界面用到的键」—— 每个地区仍是 100%） |
| 数词词形 | `node tools/i18n-plural-test.mjs` | **31/31** —— 词形表从 5 个键扩到 13 个键（新增 `groupMembers`/`groupPeopleCount`/`costCalls`/`matches`/`alerts`/`cookieCount`/`cookieCountWithSession`/`followersCount`），11 个会词形变化的地区共 296 条新词形，完整性棘轮自动覆盖新键 |
| 逐条校对 | `node tools/i18n-proofread.mjs` | 结构性破坏 **0**，可疑 18 条（记账；新增的那条是韩语译文比中文源短，属启发式误报） |
| 工程层语言守卫 | `node tools/english-logic.mjs` | clean（字符类已扩到 CJK 双破折号与带圈数字，见 BUGS #65） |
| 快速自检 | `npm run verify:fast` | 全过 |
| 发行链 | `npm run release` | build-portable ✓ · verify-release **clean** · traverse **80/80** · traverse:ui **202/202** |

这一轮的真问题（细节见 `docs/BUGS.md` 68~70）：

1. **`danmaku.js` 的非 JSON 分支引用了不存在的变量**（BUGS #68）：`text.slice(0,200)` 里的 `text`
   在该作用域根本不存在，ReferenceError 被 catch 吞掉 —— 使用者看到的是 `text is not defined`
   而不是 B 站真正的回复。这是「逐个文件通读注释」时读出来的，`node --check` 看不见。
2. **账号 id 泄露 profile 路径前缀**（BUGS #69）：注释写「短哈希」，代码是截断的 base64url 编码
   （可逆），而它随接口回给前端。已改成真正的 sha256 摘要；顺带修掉服务端「（设置里指定的）」
   被界面再套一层括号的双重括号。
3. **三条永远为真的断言**（BUGS #70）：自己跟自己比、`|| true`、以及「两个元素只可能是 1 或 2 个簇」
   的恒真式；另有一条把 `async` 回调交给同步运行器，失败会变成未处理的 Promise 拒绝。
   绿的报告在说谎 —— 全部改成真断言。
4. 抽读修掉的事实错误：`cost.js` 声称「此前界面完全没有用量」（实际有 `/api/cost`）、
   `runner.js` 把「关注对象」写成「监视目标」、`config.js` 声称停止活动的人「不会出现」
   （他们出现在日报末尾，正是那一块的意义）、`tar.js` 把 pax 的「记录总长」写成「路径长度」、
   `live.js` 注释写 100 而代码按 50 分批、`probe.js` 的 JSDoc 漏了 `tor` 档。

### 校对期间发现并修掉的问题

1. **提示语里的 `**粗体**` 会以字面星号显示**（BUGS #61）：文案里写了 markdown 记号、渲染处却是纯文本。
   这是 BUGS #52 的**复发** —— 当时只是把出错的六处改成 `<Inline>`，没留下断言。
   现在有了：`tools/hint-md-test.mjs` 要求「值里带记号的键，每个调用点都必须同行出现 `Inline`」，
   反向也查「纯文本渲染点里没有记号」，并校验 zh/en 记号一致；并用**变异测试**确认这条断言真的会失败。
2. **图片打标的失败只有一个数字**（BUGS #63）：`tagItems()` 现在回传 `errors`（最多 5 条，带 url 与原因）；
   另外只对**传输层**错误重试一次（HTTP 5xx/401 与解析失败**不**重试），并把「重试过一次」如实记在 `retried` 里。
   根因待复现（曾怀疑 keep-alive 复用旧 socket，写了复现脚本 3 轮全部成功，该假设已排除）。
3. **两个遍历之间可能留着上一轮的 app**：前一个进程刚被 kill 时端口未必立刻放开，
   后一个可能对着残留实例说话 —— 症状会漂到「报告 0 条」这类看起来毫不相干的地方。
   现在起 app 前先等端口真空出来，并断言「答话的就是我们刚起的那个进程」，收工时等它真的退出。
4. **`tar.exe` 对账的 mojibake 曾让我怀疑自己的 tar 读者**（BUGS #62）：实际是 `tar.exe` 在中文 Windows 上
   按本地代码页解文件名；我们显式按 UTF-8 解，**我们是对的**。

### 尚未验证 / Not yet verified

- **花名册在打包后的应用里真的下载一次**：遍历时刻意只验证「离线可答」（不联网、可重复）；
  真实下载与解析在开发期用同一段代码跑过（上面的 0.54 MB / 10035 条），发行版里没再跑一遍。
- **用真实 Key 的视觉打标**，以及**真实账号的弹幕发送**：两者都需要使用者的凭据，自检一律用本地假服务。
- 打包时 postject 会打印 `warning: The signature seems corrupted!` —— 这是它对 node 基线签名的既有提示，
  注入成功且 `--doctor` 与两个遍历都过；属于**已知的无害提示**，不是产物损坏。

---

## v1.4.0

**本地情报检索（不需要 LLM）+ 自检改到运行最后 + 随包脚本语法自检。**

### 新增 / Added

1. **情报检索页（新标签页「检索」）**（`server/src/search.js`）：
   **纯本地匹配 —— 不需要 LLM，也不需要联网**，没配 AI 一样能用，和查论文、浏览器里
   Ctrl+F 是一个思路。
   - 关键词（空格分隔为 AND）、**检索范围**（全部字段 / 标题 / 正文 / 标签 / 来源 / 链接）；
   - **标签面**：像论文检索左侧那样可点选，多个标签是 AND；再点一次移除；
   - **时间区间**：近 7 / 30 / 90 天 / 近一年 / 自定义起止日期；
   - **别名展开**：词表里 `2434 = にじさんじ = 彩虹社 = nijisanji`、`马车 = マリオカート`…，
     输一个词能命中全部写法；词表可在 `feeds/tags.json` 里自己改；
   - **分面计数**：标签 / 来源 / 分类 / 月份的命中数，知道该往哪收窄；
   - 被时间条件排除的条数会单独报出来（「不是没搜到，是被时间挡了」）。
2. **「帮我认人」助手（可选，需要 LLM）**：只记得特征、忘了名字时用
   （外貌 / 声音 / 名场面 / 所属）。没配 LLM 会明确说「用不了」，不影响普通检索。
3. **自检改到运行最后**（按需求修正）：添加自定义来源后**不再**立刻自检。
   现在每次运行的**最后一步**才对本次出异常的来源做诊断并生成诊断文件，
   诊断链接也会随告警推送一起发出去。连通正常的来源完全不打扰。
4. **随包脚本语法自检**（`npm run verify` 第 4 步）：对随包的每一个 `.js/.cjs/.mjs`
   跑一遍 `node --check`。
5. **API 异常统一回 JSON**：以前路由里抛错会返回 Express 的 HTML 错误页，
   前端 `JSON.parse` 只得到 `Unexpected token '<'`，极难排查；现在统一转成 JSON 并记日志。

### 本次验证 / Verification evidence

| 检查 | 命令 | 结果 |
| --- | --- | --- |
| 源码隐私自检 | `npm run sanitize-check` | clean |
| 发行包校对 | `npm run verify` | clean（含新增的「31 个脚本语法自检」一项） |
| HTTP 端点遍历 | `npm run traverse` | **73/73** |
| UI 遍历 | `npm run traverse:ui` | **61/61**（新增检索一节：关键词命中、空查询、时间区间、来源过滤、别名展开、词表与自动标签） |

### 校对期间发现并修掉的问题

1. **`3D披露` / `2434` 作为对象键没加引号** —— 以数字开头的键不是合法标识符，
   整个 `search.js` 加载即失败，打包后的 exe 起不来（`Invalid or unexpected token`）。
   已加引号，并新增「随包脚本语法自检」这一关，**这类错误以后不可能再上路**
   （打包脚本只看 exe 的 `--doctor`，那时还没加载到出错的模块，所以漏掉了）。
2. **检索路由缺 import**，Express 抛错回 HTML 页 —— 同上，加了 JSON 错误兜底。
3. **B 站免登录图文动态没有发布时间**（`pub_time` 为空），一旦设了时间区间就会被整批排除。
   现在回落到「首次见于哪次运行」并标注来源（`tsSource: item|run`），
   时间筛选对这类条目也能用了。
4. **`outsideTimeRange` 语义太窄**（只在「完全没有时间」时计数），改成
   「被时间条件排除的条数」，这才是使用者真正想知道的信息。

---

## v1.3.0

**站点连通可视化 + 网页内计划任务 + 告警推送 + 排版 DIY + 站点缩略图 + 自定义站点自检。**

### 新增 / Added

1. **每站实时连通数据**（`server/src/probe.js`）：来源页每个站点下方显示两个徽标 ——
   「直连」与「代理」的延迟与失败率，并给出「建议直连 / 建议走代理 / 两个出口都不通」的结论。
   - 直连测的是 **TCP 握手耗时**（最接近 ping）；代理测的是**经代理请求的首字节时间**；
   - 「失败率」= 失败次数 ÷ 尝试次数，界面与文档都按这个口径写，不冒充 ICMP 丢包；
   - 结果缓存 30 分钟（可改），避免每次开页面都去打站点。
2. **单站出口开关**：任意来源（含内置）都能单独设「跟随全局 / 强制直连 / 强制代理」。
3. **自动换出口**：来源未显式指定出口时，失败会自动换另一条路重试一次，并在结果里标明
   `failover from→to`。显式指定过出口的来源（例如 B 站）不会被自动改。
4. **站点健康看板**：一屏汇总已启用来源的延迟/失败率/上次运行结果，并单独列出「有问题的站点」。
5. **计划任务（网页内）**（`server/src/scheduler.js` 重写）：可建多条任务，各自设模式
   （常规 / 通贩 / 只检查监视对象）、频率（每周某天 / 每天）、时间、是否补跑；
   显示下次运行与接下来 3 次预览、上次运行时间、以及执行历史。程序没开时错过的任务会在启动后补跑一次。
6. **告警推送**（`server/src/notify.js`）：Bark / Server酱 / Telegram / Discord / 飞书 / 自定义 Webhook，
   每条通道可选触发条件（每次都推 / 仅告警 / 仅失败）。运行结束会推摘要，监视告警与关键词命中最优先。
   网页里可单独发一条测试消息。
7. **站点缩略图**（`server/src/thumbs.js`）：按 `og:image` → `apple-touch-icon` → `/favicon.ico`
   的顺序取图，抓到后缓存在本机 `thumbs/`，网页读本地缓存（不重复打站点、绕过防盗链与跨域）。
   还可以点「截图」用浏览器渲染一张真正的页面截图。
8. **自定义站点自检**（`server/src/diagnose.js`）：添加自定义来源后自动自检一次。
   **能连通就不动它**；只有出现明显异常时才生成一份人可读的诊断文件（结论 / 实测数据 /
   原始错误 / 推荐研究项），网页「诊断文件」里点开就是一份可读网页。
9. **排版 DIY**（`web/src/layout.js`）：卡片墙（小鸡词典式罗列）/ 列表 / 紧凑 / 时间线 / 表格，
   列数、密度、字号缩放、主题色、显示哪些字段都可调，改完立刻生效。
10. **情报星标与已读**、**本次 vs 上次对比**（新增 / 变化 / 消失）、**报告逐行对比**。
    条目 id 改为内容派生，星标才能跨运行保持。
11. **代理节点面板**（`server/src/proxyctl.js`）：从本机 mihomo / Clash 读节点列表，
    测**每个节点到你指定站点**的延迟（内核的延迟接口本身接受 URL），一键切换。
12. **配置导入导出**：脱敏（默认）或含密钥导出成 JSON，换机器一键导入；空字符串不会覆盖已有密钥。
13. **匿名模式**：完全不使用登录态（不读浏览器 cookie、不复用 profile），准备发布时打开。

### 本次验证 / Verification evidence

| 检查 | 命令 | 结果 |
| --- | --- | --- |
| 源码隐私自检 | `npm run sanitize-check` | clean |
| 发行包校对 | `npm run verify` | clean |
| HTTP 端点遍历 | `npm run traverse` | **73/73** |
| UI 遍历 | `npm run traverse:ui` | **48/48** |

### 校对期间发现并修掉的问题

1. **React #310（hooks 顺序错乱）**：设置页新增的 `useState` 排在了
   `if (!cfg) return <Loading/>` 之后 —— 首帧 10 个 hook、数据到齐后 16 个，
   React 直接卸掉整棵树，页面变成空白。已把所有 hook 提到早退之前。
2. **缩略图 404 被当成请求失败**：「这个站没有可用缩略图」是正常结果，
   改用 200 + `{ok:false}`，否则遍历里的「无失败请求」断言会误报。
3. **UI 遍历选择器歧义**：诊断文件名里含来源 id，导致「删掉自定义来源后页面不该再出现该 id」
   这条断言永远失败；改为查接口断言，并精确定位到那一行的删除按钮。

---

## v1.2.0

**登录态不必再关浏览器**，B 站带配图动态从此可开箱使用。

### 新增 / Added

1. **只读 cookie 提取**（`server/src/cookies.js`）：把浏览器的 cookie 库复制一份再解密，
   浏览器开着也能读，**不锁定、不改动原 profile**。实测 Opera / Chromium 130+ 的 `v10`
   方案（AES-256-GCM + DPAPI）可解，并自动剥掉 Chromium 130+ 加的 32 字节域名绑定哈希。
2. **Chrome 127+ 的 App-Bound Encryption 会被显式识别**（`v20` / `app_bound_encrypted_key`），
   给出可执行的替代方案，而不是静默失败。
3. **`POST /api/cookies/check`** 与「设置 → 浏览器 → 检查登录态」：只回报读到哪些 cookie 的
   **名字**与数量，**从不回传值**。
4. **B 站完整动态解析改进**：`feed/space` 加上 `features=itemOpusStyle`，
   正文覆盖 3→11（泠鸢）/ 0→7（嘉然）；转发动态的原文也拼进正文。
5. `bili-dynamic-login` 默认 uid 改为**确实会发图的 UP**，让「含配图」开箱可见
   （实测 7/12 条带配图、11/12 条有正文、12/12 条有发布时间）。

### 本次验证 / Verification evidence

| 检查 | 命令 | 结果 |
| --- | --- | --- |
| 源码隐私自检 | `npm run sanitize-check` | 57 个文本文件，0 处硬编码路径 / 密钥 / 私人名字 |
| 发行包校对 | `npm run verify` | clean |
| HTTP 端点遍历 | `npm run traverse` | **73/73**（新增登录态探测的契约检查与「绝不回传值」断言） |
| UI 遍历 | `npm run traverse:ui` | **48/48** |
| 真实登录态端到端 | 手工脚本 | 登录态识别为 `Nesarf_Mollor`；`feed/space` 由 `-352` 变 `code=0`；12 条动态 7 条带配图；`feeds/` 与报告里**均未出现任何 cookie 值** |

### 校对期间发现并修掉的问题

1. **`features=itemOpusStyle` 缺失导致正文全丢**：不带这个参数时新版图文动态的
   `major.draw.items` 为空且 `desc` 为 null，正文一条都取不到。已对比验证配上它之后
   配图数量与 URL 完全不变，只补齐正文。
2. **判别字段用错**：`it.type` 有时是 `DYNAMIC_TYPE_DRAW` 而真实结构在 `major.type`。
3. **转发动态内容为空**：正文在被转发的 `orig` 里，已拼接。
4. **默认演示来源选得不合适**：原先指向只发表情码的 UP，导致「含配图」这个特性
   开箱看不到，已改为会发图的 UP。

---

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
| 界面逐条校对 | `npm run i18n:proofread` | **565 个词条 × 25 个语言，结构性破坏 0 条** —— 占位符/加粗标记/换行/首尾空格/残留哨兵逐条与源串比对；可疑项 14 条（记账，不许变多） |
| UI 遍历 | `npm run traverse:ui` | **184/184** —— 真实 Chrome 走完六个页面；用 mock LLM **真跑一次**（20 条 B 站动态入情报流），验证 Markdown 渲染成真实元素、导出可下载、**默认深色主题**（含切浅色/记回选择）、韩语界面无中文残留、桌面通知存在、0 控制台错误、0 失败 API 调用 |
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
