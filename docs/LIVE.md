# 开播监测与多屏观看 / Live status & multi-screen

## 功能来源（署名与许可）

本功能参考 **dd-center/bilibili-dd-monitor**（作者 wdpm，**MIT License**, Copyright (c) 2020 wdpm），
以及它派生自的 dd-center/bili-dd-monitor。上游是「专为 DD 设计的多屏直播观看工具」，
核心是两件事：**开播/下播实时检测** 与 **多播放器自动网格布局**。

本项目按其自己的技术栈（Express + React）**重新实现**了这两件事：
**没有复制上游的代码、图片、banner、样式或配置**，只借鉴了功能构思。
MIT 允许衍生，这里选择重写而非搬运；上游许可以上句署名形式记录。

## 上游数据源已失效

上游依赖 vtbs.moe 的 `/v1/live` 取开播列表。实测（2026-09-11）：

| 端点 | 结果 |
| --- | --- |
| `https://api.vtbs.moe/v1/live` | **404**（已下线；上游本身也停更了） |
| `https://api.vtbs.moe/v1/info/<uid>` | 404 |
| `https://api.vtbs.moe/v1/short` | 200，约 9762 条 `{mid, uname, roomid}` 花名册，**仍可用** |

所以本实现改用实测可用的 B 站批量接口；花名册只留作「按名字找 uid」的辅助：

```
GET https://api.live.bilibili.com/room/v1/Room/get_status_info_by_uids?uids[]=<uid>&uids[]=...
  -> code=0，data 以 uid 为键: { room_id, live_status, title, uname, cover, online, area_name }
```

## 必须区分的三种状态

`live_status`：`0` 未开播、`1` 直播中、**`2` 轮播**。

**轮播不是真开播。** 把它当开播会稳定误报 —— 实测时嘉然、泠鸢、hanser 三个都处于 `2`（轮播），
若按「非 0 即开播」处理，一上来就会推三条假警报。因此界面分三档显示，
`live.notifyOnLive` 也只在状态变成 `1` 时才推送。

## 多屏观看

用 B 站官方的内嵌播放器 `https://live.bilibili.com/blanc/<roomId>?hidePanel=1`。

实测该页**没有 `X-Frame-Options` / `frame-ancestors`**，可以直接 iframe 嵌入，
因此**不需要任何转发、代理或本地播放服务**，也就不涉及任何登录态、cookie 或用户数据。
iframe 上加 `referrerPolicy="no-referrer"`，不向 B 站回传本页地址。

网格是纯前端的：列数可选（自适应 / 1–4 列），选择存在 localStorage（不污染配置文件）。

## 多平台与「码率 / 帧数」——实测边界（2026-09-11）

需求里提到「YouTube、Twitch 等平台的直播源 + 实时评论流，并在每个源下方显示延迟、丢包、码率、帧数」。
先把**能做的**和**做不到的**分开，避免做出一个显示假数字的功能。

### 1. 码率 / 帧数 / 丢帧：跨域嵌入播放器**测不到**

YouTube / Twitch / B 站的官方嵌入播放器都跑在**跨域 iframe** 里。同源策略下父页面拿不到它的
`<video>` 元素，因此 `getVideoPlaybackQuality()`（总帧数 / 丢帧数）、`buffered`（缓冲与直播沿）、
协商码率（MSE/ABR）**全都读不到**。这不是实现没做，是浏览器安全边界。

界面上如实写「码率 / 帧数：跨域嵌入播放器测不到」，不给假数字。

**要真测只有一条路：把流地址拿过来自己播。**
- bilibili：`getRoomPlayInfo` 可用（实测 `code=0`），但**只有真正在播的房间才有流地址** ——
  实测时嘉然/泠鸢/hanser 都在**轮播**（`live_status=2`），返回的 stream 列表是空的。
  拿 `<video>`/mse 自己播之后，帧数、丢帧、码率、直播沿延迟都能真测。
- YouTube / Twitch：需要 yt-dlp / streamlink 一类工具取流，有 ToS 与稳定性代价，且要额外依赖。
  本项目是便携 exe，不打算为它引入这种依赖。

### 2. 实时评论流：bilibili 弹幕**当前被风控挡住**

| 尝试 | 结果 |
| --- | --- |
| `getDanmuInfo`（仅 buvid3/buvid4 + referer） | **-352** |
| `getDanmuInfo`（用 Opera profile 的 **SESSDATA** 登录态） | **-352** |
| WebSocket `wss://<host>/sub`（protover=3，brotli） | 拿不到 token，无法建连 |

即**带登录态也进不去**，判断是这批接口又加了 WBI 签名要求（本项目在 B 站动态接口上已经踩过同类风控）。
`getDanmuInfo` 拿不到 token，后面的 brotli 解包（Node 内置 `zlib.brotliDecompressSync`）也就无从验证。
**所以这一轮没有把弹幕塞进来** —— 半残的实时流比没有更糟。下一步是给该接口补 WBI 签名（`w_rid`/`wts`）。

Twitch 的匿名 IRC（`wss://irc-ws.chat.twitch.tv` + `justinfan`）思路可行且不需要鉴权，
但 Node 内置的 `WebSocket` **不支持走 HTTP 代理**，而本机访问 Twitch 必须走代理 ——
所以要做得先自己实现「CONNECT → TLS 升级 → WebSocket 握手」，属于独立的一块工作。

### 3. 真的做了：每个直播源的**网络层**延迟与失败率

这一层是第三方页面**能够诚实测量**的，已经接上：

- 每张直播卡下方有「测网络」，走本项目已有的探测器；
- 直连测 **TCP 握手 RTT**，代理测**经代理请求的首字节时间**；「失败率」= 失败次数 ÷ 尝试次数；
- 给出结论（哪个出口更快 / 哪个不通），正在直播的房间打开页面时会自动测前 6 个。

实测样例（bilibili 直播间）：直连 **19ms / 0%**，代理 **316ms / 0%** → 「直连更快（19ms vs 316ms）」。

### 4. Tor 出口（实测 2026-09-12）

**Tor 本身**：这台机器上装的是 Tor Browser 的 `tor.exe` 0.4.9.11，配置走 **snowflake 网桥**
（`ClientTransportPlugin snowflake exec ...\lyrebird.exe`）。按下面的参数唤起后，
引导日志走到 `Bootstrapped 100% (done)`，全程约 55 秒 —— 不需要额外做端口转发之类的事。

```
cd "<Tor Browser>\Browser"           # cwd 必须是这里：可插拔传输用的是相对路径
tor.exe --defaults-torrc "TorBrowser\Data\Tor\torrc-defaults" ^
        -f "TorBrowser\Data\Tor\torrc" ^
        --SocksPort 9150 --DisableNetwork 0
```

（`<Tor Browser>` 指你装 Tor Browser 的那个目录。页面上那个「唤起 Tor」按钮会自动按这个布局
拼参数，不需要手敲 —— 这里写出来是为了说明它到底在做什么。）

三个坑（都写进了 `torLaunchPlan()` 与 BUGS #56）：

1. `torrc-defaults` 要用 **`--defaults-torrc`** 传：命令行只允许一个 `-f`，传两个会被拒
   （`Duplicate -f options`），于是 snowflake 的传输插件全丢，报
   `there is no configured transport called "snowflake"`；
2. Tor Browser 退出时会在 torrc 里留 `DisableNetwork 1`，必须显式覆盖，否则永远停在 0%；
3. 裸 spawn 会用默认值（SocksPort **9050**、无网桥、数据目录落在 C 盘）—— 页面上那个
   「唤起 Tor」按钮原先就是裸 spawn，所以按下去了却等于没起。

**app 侧实测**（`POST /api/proxy/tor`）：`{"ok":true,"socks":"127.0.0.1:9150","isTor":true,"ip":"185.220.101.23"}`。

**三出口对比**（`POST /api/probe`，samples=1）：

| 目标 | 直连 | 经 Tor |
| --- | --- | --- |
| `https://example.com/` | 186ms（TCP 握手） | 1800ms（首字节） |
| `https://api.bilibili.com/x/web-interface/nav` | 24ms | 1764ms |

也就是说 **B 站经 Tor 也抓得到**，只是慢一个量级（snowflake 本身带宽就小）。
所以合理用法是「个别来源单独走 Tor」（来源页那个下拉就能设），而不是全局切 Tor。

**隐私提醒**：Tor 出口下不要带登录态（B 站登录、萌百 BotPassword 等）——
把实名账号的身份和 Tor 出口绑在一起，等于自己把两者连起来。出口 IP 每次也会变。


## 无痕化处理

按本项目一贯的隐私约束，这一批功能做到：

- **不引入上游任何资源**（图片、字体、样式、配置），因此不存在来源不明的二进制或元数据；
- 播放器直连 B 站官方页，**不经过任何第三方中转**，且不回传本机地址（`no-referrer`）；
- 开播查询走直连（与本项目其它 bilibili 来源一致），**不使用、不保存任何 cookie**；
- 发弹幕那一段要看登录态，但**打开页面不会去读** —— 它读的是浏览器的 cookie 库，读取过程
  要同步解 DPAPI（实测 3~4 秒，期间整个服务是停的），所以只有点了「检查登录态」才读，
  且服务端读一次缓存 60 秒（BUGS #47）；
- 代码里不写死 uid：监测对象全部来自配置或已有来源；出现的 uid 只在**测试脚本**里，
  且都是可公开的官方账号；
- `docs/` 与发行包都不含任何机器路径、账号、密钥（由 `npm run verify` 与 `npm run sanitize-check` 强制）。

## 与上游的功能对照

| 上游功能 | 本项目 |
| --- | --- |
| 正在直播的 vtber 列表 | 「直播」页，并区分直播中 / 轮播 / 未开播 |
| 分组关注 | 复用「来源」的分类与「监视对象」标签 |
| vtuber 信息库列表 | vtbs.moe 花名册按名字查 uid（辅助功能） |
| 本地设置 | 网页设置（config.json） |
| 播放器 / 多播放器自动网格 | 多屏网格（列数可选，选择本地保存） |
| Electron 桌面应用 | 收进本项目已有的本地网页控制台，不需要第二个程序 |
