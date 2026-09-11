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

## 无痕化处理

按本项目一贯的隐私约束，这一批功能做到：

- **不引入上游任何资源**（图片、字体、样式、配置），因此不存在来源不明的二进制或元数据；
- 播放器直连 B 站官方页，**不经过任何第三方中转**，且不回传本机地址（`no-referrer`）；
- 开播查询走直连（与本项目其它 bilibili 来源一致），**不使用、不保存任何 cookie**；
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
