# 工程逻辑英文化 / English in the engineering layer

> 这份文档（以及 `docs/` 下的其它文档）**保持中文**。它规定的是**代码里**哪些中文该改成英文、
> 哪些必须原样留着 —— 以及那条规则由哪个脚本守着。

## 1. 三类中文，三种处理

| 类别 | 例子 | 处理 |
| --- | --- | --- |
| **工程逻辑**：注释（`//`、`/* */`、JSDoc） | `// 基线的窗口不能锚在最后一次活跃那天` | **改英文** |
| **工程输出**：服务器日志、`console.*`、`process.stdout/stderr.write`、测试与巡检的检查名与详情 | `log.info('抓取完成：12 条')`、`check('箱视角接口可用', …)` | **改英文** |
| **界面与文档**：界面词条、API 返回给前端的错误串、`docs/*.md` | `web/src/i18n.jsx` 的 `zh:` 字典、`res.json({ error: '还没有花名册…' })` | **保持中文，不许动** |

判据一句话：**「给人看的界面文案」保持中文，「给维护者看的逻辑说明」改成英文。**

## 2. 一条最容易改错的地方

界面的中文会出现在**比较与断言**里，那是**数据**，不是输出：

```js
// ✅ 保留：这是在断言界面文本
check('the group view block is rendered', main.indexOf('箱视角') !== -1);
assert.match(indexSummary(null), /尚未获取/);

// ✅ 改成英文：这是给读日志的人看的
check('the group view block is rendered', ok, 'block present');
```

同理，`web/src/i18n.jsx` 里的 `zh:` 字典、`t('...')` 的键名、`docs/` 里的正文，
**一个字符都不要动**（改了会让 25 个地区的界面全乱）。

## 3. 守卫脚本

```bash
node tools/english-logic.mjs          # 有中文注释/输出串 → 退出 1（进 verify:fast）
node tools/english-logic.mjs --list   # 按文件列出全部命中（做工单用）
node tools/english-logic.mjs --json   # 机器可读
```

它扫描 `server/src`、`server/scripts`、`web/src`（跳过词条本体 `i18n.jsx` 与 `locales/`）、
`tools/`、`launcher/`，判定两件事：

1. **注释文本**里不许有汉字（全角标点 `「」——·` 也算，一并换成 ASCII）；
2. **输出串**里不许有汉字 —— `log.*` / `console.*` / `process.std*.write` 的所有实参，
   以及 `check()/t()/ta()/note()/banner()` 的**检查名**（第一个实参）。

参与比较的实参整段跳过（`===` / `indexOf` / `matches` / `includes` / `assert` …），
所以上面第 2 节那种「拿中文当数据」的写法不会误报。

## 4. 灰区：**没有词条的硬编码产品文案**保持中文

有些中文串既不是 `t('key')` 词条，也不是日志 —— 它们硬编码在服务端，但**最终会被渲染给使用者**：

| 例子 | 去处 |
| --- | --- |
| `silence.js` 的 `reason`（「X 已 N 天没有新条目…」） | **日报 markdown** + 推送正文 |
| `notify.js` 的 `reason`（`静默时段 22:00–08:00`） | 设置页「🔕 正在静默 · …」 |
| `probe.js` 的 `hint`（「direct 最快（…）」） | 来源页的 toast 与出口提示 |
| `egress.js` 的 `why`/`note`/`reason` | 来源页自动出口的 tooltip |
| `groups.js` 的 `groupSignal.reason`、`dormant.js` 的报告块、`watch.js` 的 `summary`/`reasons` | 日报 / 监视历史 |
| `scheduler.js` 的默认任务名「任务 N」、`live.js` 的 `note` | 界面直接显示 / 随接口返回 |

判据：**会被使用者看到的字符串就是产品文案 → 中文**（哪怕它没有走 `t()`）。
反过来，只有日志 / 诊断报告 / 自检输出会读到的串 → 英文：
`silenceSummary()` 的摘要行（只有 `log.*` 与 `/api/silence` 读，界面不渲染）、
`observe.js` 的跳过理由、`diagnose.js` 生成的诊断 markdown 等。

守则的边界之外还有一条：**守卫只认 `log/console/stdout` 与 `check()/t()`**，
所以「塞进对象里再被日志打印」的串（例如 `skipped.push({ error: … })`）它看不见。
这类地方靠这条规则判断，不要指望脚本兜住。

## 5. 数字 + 量词：用 `tn()`，不要 `{n} ${t('word')}`

数量标签走 `tn('items', n)`（`web/src/plural.js` + `locales/plurals.js`），
它会按 `Intl.PluralRules` 选词形 —— `21 элемент` 而不是 `21 элементов`。
`t('key')` 只用于固定文案；`tn` 也一样会被覆盖度 / 校对统计（见 BUGS #54）。

## 6. 翻译时的纪律

- **保留全部「为什么」**：这里的注释解释的是取舍与踩过的坑（BUGS #NN、实测数字、上游行为），
  英文化是换语言，不是缩写。信息密度不许下降。
- **专有名词原样保留**：路径、标识符、`BUGS #52`、`docs/OBSERVE.md`、接口名、平台名、
  实测数字（`10035 条` / `0.54 MB` / `Bootstrapped 100%`）都不翻。
- **不改变行为**：只动注释与输出文本，不改逻辑、不改比较字面量、不改键名、不重排代码。
- 改完至少跑 `node --check <file>`（`.jsx` 跳过，靠最终构建校验）。
