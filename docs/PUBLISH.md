# 发布到 GitHub / Publishing to GitHub

本机目前**没有** gh CLI、没有配置 git 凭据、也没有全局 git 身份，所以推送这一步
需要你自己执行。下面是可直接照抄的顺序。

> 下文用 `<repo>` 表示你克隆/解压出来的项目目录，请自行替换；
> 文档里不写任何机器专属的绝对路径。

## 0. 先把提交身份改成你自己的

仓库里那一个提交的作者目前是中性的临时身份。改成本人（只影响本仓库）：

```powershell
cd <repo>
git config user.name  "你的 GitHub 用户名"
git config user.email "你的 GitHub 邮箱"
git commit --amend --reset-author --no-edit
```

`--reset-author` 会把已有提交的作者一起重写，历史就干净了。
如果想让它对**所有**仓库生效，把 `git config` 换成 `git config --global`。

## 1. 在 GitHub 上建一个空仓库

- 仓库名建议 `vtuber-monitor-link`（GitHub 仓库名里放撇号和空格会很别扭；
  显示名/描述里再写 `Vtuber's Monitor Link` 即可）。
- **不要**勾选 "Add a README / .gitignore / LICENSE"——本地已经有了，
  勾了会多出一个无关的提交，还得先 pull 再推。

## 2. 关联远程并推送

```powershell
cd <repo>
git remote add origin https://github.com/<你的用户名>/vtuber-monitor-link.git
git branch -M main
git push -u origin main
```

第一次推 HTTPS 会弹 GitHub 登录（浏览器授权或粘贴 Personal Access Token）。

## 3. 打 tag，让 Actions 自动出包

`release.yml` 监听 `v*` tag：会在一台干净的 windows-latest 上构建，
跑 `npm run verify` 与 `npm run sanitize-check`，打 zip 并挂到 Release 上。

```powershell
git tag -a v1.0.0 -m "Vtuber's Monitor Link v1.0.0"
git push origin v1.0.0
```

然后到仓库的 **Actions** 页看 `release` 这个 workflow 跑完，
**Releases** 页就会出现带 `VtuberMonitorLink-1.0.0-win-x64.zip` 的发行版。

## 备选：不等 Actions，手动挂包

本地已经构建好并校对过了，直接上传也行：

```
dist\VtuberMonitorLink-1.0.0-win-x64.zip   40 MB
```

在 GitHub 上 `Releases` → `Draft a new release` → 选 tag `v1.0.0` →
把 zip 拖进去 → Publish。

## 发布前建议自查

```powershell
npm run sanitize-check   # 源码里有没有硬编码路径 / 密钥 / 私人名字
npm run brand            # VML 命名一致性：对外件用全名、内部标识用 VML
npm run english          # 英文覆盖率（工程层 / 界面两侧的百分比）
npm run release          # 构建 + 校对 + 端点遍历 + UI 遍历（需要本机有浏览器）
```

`npm run verify:fast` 已经把上面三条里的前两条（`vml-brand`、`english-logic`）连同
25 个语言的校对一起卡住了，所以「能构建」和「命名/语言/校对没退化」是同一道闸门。

**关于 git 历史里的本机路径**：工作区里已经没有任何机器专属路径（`tools/verify-release.cjs`
的规则会在 `npm run release` 时把残留拦下，本文件自己也被拦过一次），但**历史**里仍留着
早期文档中「cd 到开发目录」这类命令示例 —— 只有盘符与项目名，**不含用户名与凭据**。

不重写历史不影响安全；若你希望连历史也干净，在 push 之前重写即可（尚未 push，不影响任何人）：

```powershell
# 1) 先备份：把整个 .git 目录复制一份到仓库外
# 2) 用 git filter-branch --tree-filter，或更省事的 git-filter-repo --replace-text，
#    把历史里那串开发目录的绝对路径替换成 <clone dir>
# 3) 重写后确认闸门仍然全过：npm run verify:fast
```

重写会改变全部提交哈希 —— 因为还没有远程分支，这不会影响任何人。

`ci.yml` 会在每次 push / PR 上自动跑：构建前端、`sanitize-check`、
四个工具的语法检查、`launcher --doctor` / `--paths`、启动器脚本的 ASCII 断言。
它**不会**跑 `traverse*`（需要真实浏览器与网络），那两个是发布前在本机跑的。

## 注意

- `.sanitize-names`（本地私人名字清单）与 `config.json`、`reports/`、`feeds/`、
  `logs/`、`dist/`、`build/` 都已在 `.gitignore` 里，不会进版本库。
- 在 CI 上 `.sanitize-names` 不存在，所以「私人名字」那条规则会自动跳过，
  其余规则照常生效。
