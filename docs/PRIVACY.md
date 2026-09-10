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
- 打包脚本会拒绝把 `config.json`、`reports/`、`feeds/`、`logs/` 复制进产物；
  发布前再用 `npm run verify` 独立复核一遍（含「Key 是否被填过」这一项）。

## 上线前请确认

`npm run verify` 与 `npm run traverse*` 全绿只代表**程序本身**没问题，不代表
已经用真实 Key 跑通过。产品第一次完整运行（抓取 → LLM 分析 → 出报告）需要
使用者自己在网页「设置」里填入 LLM API Key，该步骤有意不放进自动化流程：
Key 只应存在于使用者本机的 `app/config.json`，绝不进仓库、不进发行包。
