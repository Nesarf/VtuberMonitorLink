# VDB 花名册 / VDB roster

> 这一页说明「社团（箱）名册」这个能力是怎么接的、为什么这么接、边界在哪。
> 它不是十项能力里的第十一项，而是**给「按人关注」和「箱视角」补上缺失的那一维**：社团。

---

## 1. 为什么需要它（缺口在哪）

我们原本的「人」是从情报条目里长出来的：条目里出现名字 → 按别名归属到人。
这套能跑，但缺三样东西，而且都是**结构化事实，靠抓新闻永远凑不齐**：

| 缺的 | 后果 |
| --- | --- |
| **社团（箱）** | 「箱视角」的热力图、共同静默、箱级信号全都要求每人先手填 Agency。一个箱 30 人就要手填 30 次 |
| **多语言名字 / 别名** | 中文名、日文名、英文名各写一遍才会命中；拉丁词边界匹配再好，别名没填也是白搭 |
| **各平台账号** | 同一个人在 bilibili / YouTube / Twitch / X 上的 id 是分散填的，漏一个就等于漏一条情报 |

VDB（`github.com/dd-center/vdb`，vtbs.moe 的上游数据库）就是干这个的：**一文件一人**，
每条记录长这样——

```json
{
  "name": { "cn": "嘉然", "en": "Diana" },
  "accounts": { "bilibili": "672328094", "weibo": "7595006312" },
  "group": "A-SOUL"
}
```

## 2. 为什么是「一条请求拿全库」

实测（2026 年）：整库 tarball **0.54 MB**、**10035 条记录**、**215 个社团**，一次 `codeload` 请求、一两秒拿完。

对比逐个调 GitHub API：几千次请求、吃配额、会被限流、日志里全是噪声 —— 对使用者更吵，对上游更不礼貌。
所以选择**整库快照 + 本地索引**，缓存 TTL 7 天（花名册变化很慢，要立刻刷新可以点「同步花名册」）。

### 实测到的构成

| 项 | 数量 |
| --- | --- |
| 记录总数 | 10035 |
| 社团数 | 215 |
| 有社团归属的记录 | 1770 |
| 按平台（有该平台账号的记录） | bilibili 9734 · twitter 680 · youtube 616 · youtubeAt 48 · twitch 45 · acfun 36 · weibo 30 … |
| 人数最多的箱 | VirtuaReal 115 · NIJISANJI 104 · ChaosLiveSprout 52 · 极光社 51 · P-SP 36 · HoloLIVE 35 |

> 注意：**有社团的只占 17.6%**。绝大多数独立势本来就没有社团，这不是数据缺陷，是现实。
> 所以界面不把「没有社团」当异常，箱视角也只对真正填了 Agency 的人生效。

## 3. 许可（这一节比功能本身重要）

VDB 的数据是 **CC BY-NC-SA 4.0**，代码是 **GPL**。我们是 MIT。结论：

- ✅ **只运行时获取**：使用者点一下才下载，缓存在运行期目录 `app/vdb/index.json`
- ❌ **绝不进仓库、绝不进发行包**：`vdb/` 在 `.gitignore` 里，`tools/make-zip.mjs` 与
  `tools/verify-release.cjs` 都把 `app/vdb` 列进排除/校验清单 —— 有人把缓存提交进来会被巡检拦住
- ✅ **署名**：界面花名册区块显示 `dd-center/vdb · CC BY-NC-SA 4.0`，README 与本文都有来源说明
- ✅ **非商业**：个人工具用途没问题；要商用请自行联系上游

这份数据的所有权与解释权在上游。我们只读、只缓存、不改写、不二次分发。

## 4. 实现

| 文件 | 干什么 |
| --- | --- |
| `server/src/tar.js` | **零依赖** tar 读取：ustar / 目录 / GNU 长名 `L` / pax 扩展头 `x`。pax 的长度字段按**字节**算且要计入自身位数 |
| `server/src/vdb.js` | 下载 → gunzip → 解 tar → 解析每条 JSON → 建索引；`searchIndex` / `membersOfGroup` / `toPerson` |
| `server/src/people.js` | 别名改为**平台无关**：从 `PLATFORM_URLS` 生成「id / 带 www 的链接 / 裸链接 / `@handle`」四种形态 |
| `web/src/pages/People.jsx` | 搜索 → 勾选 → 导入（花名册区块） |

### 平台无关是硬要求

`PLATFORM_URLS` 现有 **27 个平台**：bilibili · youtube · youtubeAt · twitter · twitch · tiktok · weibo ·
weiboByName · acfun · niconico · showroom · pixiv · afdian · ci-en · booth · fantia · marshmallow ·
userlocal · instagram · telegram · patreon · peing · 163music · line · github · web · other。

代码里**不假设 bilibili**：`accounts` 里有什么平台就收什么平台，匹配与展示都走「平台 → id」的通用形状。
搜索时，输入**任何平台**的账号 id 或链接形态（twitch 名、YouTube 频道、X handle…）都能命中。

### 导入走同一条净化路径

导入不是后门：选中的记录先经过 `toPerson()` 变成标准关注对象形状，再**过和手工新增同一个
`sanitizePerson()`**（id 冲突、别名长度、链接合法性都在那里挡）。挡下来的会逐条回报
`skipped` 与原因，不静默丢弃。

## 5. 上游的判定标准（和我们的规则是否一致）

VDB 自己的收录/删除标准里有一条值得记下来，因为它和我们独立设计的规则**撞上了**：

| 上游标准 | 我们这边的对应 |
| --- | --- |
| 「删除历史信息…且 **6 个月无活动**」才删档 | 我们的「停止活动 / 毕业」判定就是 **≥6 个月无动静**（`DORMANT_DEFAULTS.months: 6`） |
| 社团收录要求 **≥2 位符合条件的成员**佐证归属 | 箱视角的箱级信号要求 **≥3 位成员**才敢下结论（`SILENCE_DEFAULTS.minMembers`），同一种谨慎 |

两边独立得出同一个数量级，算是一次交叉验证。

## 6. 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/vdb/status` | **只读缓存、不联网**（离线可用）；返回 `cached / count / groups / platforms / generatedAt / source / license` |
| POST | `/api/vdb/sync` | 真的去下载（0.54 MB 一条请求），`force` 语义 |
| GET | `/api/vdb/search?q=&group=&limit=` | 名字（任意语言/别名）与**任意平台**的账号 id / 链接都能命中；缓存不存在时自动拉一次 |
| GET | `/api/vdb/groups` | 社团 → 成员数 |
| POST | `/api/vdb/import` | 把选中的 key 变成关注对象，返回 `added` / `skipped` |

## 7. 自检（`npm run test:vdb`，25 项）

离线断言，不联网：

- tar：ustar 头 / 目录 / GNU `L` 长名 / pax `x` 扩展头（含「长度字段要计入自身位数、按字节算」这个坑）
- 解析：`{name:{cn,en}}` 多语言名、缺失字段、`accounts` 里的任意平台
- 索引：社团分组、平台计数、搜索（中文名 / 英文名 / bilibili mid / twitch 名 / 带 www 的链接 / `@handle`）
- 导入：`toPerson()` 的形状能被 `sanitizePerson()` 接受；重名 / 重复 id 被挡
- **真 tarball 对账**：用本机 `tar.exe` 解同一份压缩包，逐条比对记录数（我们的 JS 读者 10035 条，与上游文件数一致）

> 关于那次对账：`tar.exe` 解出来的条目名有 mojibake（`-大咲-` → `-婢堝瓙-`），导致它的记录数偏少。
> 这反而说明我们的读取路径（显式按 UTF-8 解）是对的。

## 8. 没做 / 待观察

- **不打包快照**：许可禁止我们再分发（NC/SA），所以离线环境下花名册不可用 —— 这是刻意的取舍
- **不做增量**：每次整库快照。0.54 MB / 7 天，不值得为增量引入复杂性
- **社团归属冲突不自动裁决**：同一个人在多处标了不同社团时，以 VDB 记录里的 `group` 为准；我们不去猜
- **毕业判定不依赖 VDB**：VDB 是花名册不是时间线，没有「最近活动时间」。权威的毕业信号仍然来自我们自己的
  条目 + 静默检测（见 `docs/DESIGN.md` §13）。VDB 只回答「这个人属于哪个箱、还有哪些账号」
