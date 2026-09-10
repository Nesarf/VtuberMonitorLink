# 隐私与发布须知 / Privacy & Publishing Notes

> 本文件说明 Vtuber's Monitor Link 在隐私上的边界，以及发布（提交到公共仓库 / 分发 .exe）前必须做的清理。

## 我们的承诺

1. **绝不打包、绝不上传任何账号或 cookie。**
   需要登录的站点（例如 X 推文正文、Twitch 关注列表）一律由用户**在自己的浏览器里**登录；
   本工具只是"借用"该浏览器的 profile 去渲染页面，配置里存的是**浏览器路径 + profile 目录**，不是凭据本身。

2. **不做任何回传。**
   工具只监听 `127.0.0.1`，报告与抓取结果只落本机磁盘。

3. **运行期数据不入库。**
   `config.json`（含 LLM Key、代理地址、浏览器路径）、`reports/`、`feeds/`、`logs/` 全部在 `.gitignore` 中排除。

## 发布前必做 / Pre-publish checklist

```bash
npm run sanitize-check
```

该脚本会扫描仓库内所有文本文件，报告：

| 规则 | 检查内容 |
| --- | --- |
| `home-path` | 个人主目录路径（`C:\Users\<name>` 之类） |
| `specific-drive` | 写死的盘符绝对路径 |
| `api-key` | 疑似 API Key（`sk-…`） |
| `cookie-blob` | 疑似 cookie 内容（`cf_clearance` / `SID=` / `__Secure-` …） |
| `named-persona` | 私人角色名等个性化标识 |
| `runtime-data` | 运行期数据/目录是否被误放进仓库 |

## 开发者注意

- **不要**在代码里写死任何绝对路径；一切走 `config.json`（见 `server/src/config.js` 的 `DEFAULT_CONFIG`）。
- 内置来源清单元数据（`server/src/sources.js`）只包含**公开 URL**，不含任何个人配置。
- 添加新来源时，请只填公开端点，**不要**把带 token / cookie 的私有地址写进清单。
- 如需示例配置，请用 `config.example.json` 这类占位文件，且**不得**包含真实 Key。

## 分发形态

- **便携包**：`VtuberMonitorLink.exe`（单文件启动器）+ `app/`，解压即用；
  包内**不含**任何用户数据、账号、cookie 或 Key。
- 首次运行时生成 `app/config.json`，由用户自己填写 LLM Key、浏览器路径与代理。
- 打包脚本会拒绝把 `config.json`、`reports/`、`feeds/`、`logs/`、`watch/` 复制进产物；
  发布前再用 `npm run verify` 独立复核一遍（含「Key 是否被填过」这一项）。

## 本机凭据都放在哪

这个工具会用到两类凭据，**都只写进本机 `app/config.json`**：

| 凭据 | 用途 | 说明 |
| --- | --- | --- |
| LLM API Key | 调用你自己的模型接口 | 接口只以掩码 `***` 回传；需要编辑时网页里可以点「显示」 |
| 萌百 BotPassword | 读你自己的监视列表 | 可选功能。**不要用主密码**，建议开一个只读权限的 BotPassword |

两者都不会进版本库（`config.json` 在 `.gitignore` 里），也不会进发行包。
`.sanitize-names` 里的私人名字清单同理。

## 浏览器登录态（`server/src/cookies.js`）

有些来源必须登录才能抓（B 站带配图动态、X 推文正文）。本工具提供了两条路，
**默认都不会把 cookie 写到任何持久化位置**：

### 路线 A：只读提取（推荐，浏览器可以开着）

把浏览器的 cookie 库**复制一份**到临时目录再解密：临时副本用完即删，
原 profile 不会被锁定、不会被改动。

- 只读取你指定的域名（默认 `bilibili.com`），其余域名一律不碰；
- 解密出的明文只在本进程内存里拼成一个 Cookie 头，直接发给对应站点；
- **不写日志、不写报告、不进 `feeds/`**；`POST /api/cookies/check` 只回传
  「读到了哪些 cookie 的名字」，从不回传值；
- DPAPI 解密钥这一步会调用一次本机 `powershell.exe`（离线、不走网络）；
  失败就明确报错，不会静默降级。

实测：Opera / Chromium 130+ 的 `v10` 方案可解；**Chrome 127+ 默认启用
App-Bound Encryption（`v20`）时无法在外部解密** —— 这时工具会直接说明，
并引导你改用路线 B。

### 路线 B：Playwright 复用 profile

把 `profileDir` 指向已登录的浏览器，Playwright 以持久化上下文启动。
**要求该浏览器完全关闭**（否则 profile 被锁），代价更大但兼容所有浏览器。

> 如果你不希望任何工具去读你的 cookie，就不要配置 `profileDir`：
> 未配置时不会执行任何提取，需要登录的来源会如实失败并给出提示。

## 上线前请确认

`npm run verify` 与 `npm run traverse*` 全绿只代表**程序本身**没问题，不代表
已经用真实 Key 跑通过。产品第一次完整运行（抓取 → 监视 → LLM 分析 → 出报告）需要
使用者自己在网页「设置」里填入 LLM API Key，该步骤有意不放进自动化流程：
Key 只应存在于使用者本机的 `app/config.json`，绝不进仓库、不进发行包。

想在没有任何 Key 的情况下把链路跑通，用仓库自带的本地 mock LLM：

```bash
npm run mock-llm      # 127.0.0.1:43197，OpenAI 兼容，零依赖
```

`npm run traverse:ui` 就是这么做的 —— 它临时写入一份指向 mock 的配置，
跑完再把 `app/` 恢复成干净状态。
