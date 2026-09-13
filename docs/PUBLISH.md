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
npm run commit-msg       # 每条提交信息是不是英文（整段历史）
npm run release          # 构建 + 校对 + 端点遍历 + UI 遍历（需要本机有浏览器）
```

`npm run verify:fast` 已经把上面三条里的前两条（`vml-brand`、`english-logic`）连同
25 个语言的校对一起卡住了，所以「能构建」和「命名/语言/校对没退化」是同一道闸门。
`npm run commit-msg` 不在 `verify:fast` 里（它要读**整段 git 历史**，浅克隆里只能看到末端），
所以它由 `ci.yml` 的 `check` job（`fetch-depth: 0`）和本地钩子 `.githooks/commit-msg` 两个地方守。

**提交信息一律英文**（2026-09-14）：规则、判据与允许保留的引用见 `docs/ENGLISH-LOGIC.md` §8。
本地启用钩子一次：

```powershell
git config core.hooksPath .githooks
```

### 提交信息英文化：这次是怎么改的

首次对外发布后，仓库里 57 条提交中有 **14 条正文是中文**（subject 早已是英文，中文只在 body）——
对外部读者等于读不懂。已用 `git filter-branch --msg-filter` 原地重写为英文，要点：

```powershell
# 1) 先备份整段历史（仓库外）
git bundle create <备份路径>.bundle --all

# 2) 只换信息：msg-filter 查表替换，commit-filter 给原本签过名的提交重新签名，
#    tag-name-filter cat 把两个 tag 指到重写后的提交
$env:FILTER_BRANCH_SQUELCH_WARNING = '1'
git filter-branch -f --msg-filter "node <过滤器>" `
  --commit-filter 'if git cat-file -p "$GIT_COMMIT" | grep -q "^gpgsig"; then git commit-tree -S "$@"; else git commit-tree "$@"; fi' `
  --tag-name-filter cat -- --branches --tags

# 3) 逐条比对：提交数、tree、作者/日期、父子结构、签名状态都必须不变，只有信息变了
# 4) 原子推送（带 lease，失败就整体不推）
git push --atomic --force-with-lease=refs/heads/main:<旧值> `
  --force-with-lease=refs/tags/v1.0.0:<旧值> --force-with-lease=refs/tags/v1.0.1:<旧值> `
  origin refs/heads/main refs/heads/main refs/tags/v1.0.0 refs/tags/v1.0.0 refs/tags/v1.0.1 refs/tags/v1.0.1
```

三个必须知道的坑（都是实测踩出来的，记在 BUGS #72–#74）：

- **`--msg-filter` 重写会丢掉签名**：本机 `%G?` 为 `G` 的提交重写后会变成无签名 ——
  提交签名必须由 `--commit-filter` 里的 `git commit-tree -S` 补回来，否则「Verified」全掉。
- **annotated tag 的签名会被重建成无效签名**：`filter-branch` 会重建 tag 对象（信息保留、
  签名留着但已经对不上）。用 `git tag -f -s -F <信息文件>` 重签，并用 `GIT_COMMITTER_DATE`
  保持 tagger 时间不变（`git tag -v` 要看到 `Good "git" signature` 才算数）。
- **GitHub 的 Verified 与「本机 `G`」是两回事**：签名用的 SSH key 没在账号里
  （Settings → SSH and GPG keys → New SSH signing key）注册时，API 一律回
  `verified=false, reason=no_user` —— 与本机显示无关，也与这次重写无关。

**关于 git 历史里的本机路径**：工作区里已经没有任何机器专属路径（`tools/verify-release.cjs`
的规则会在 `npm run release` 时把残留拦下，本文件自己也被拦过一次），但**历史**里仍留着
早期文档中「cd 到开发目录」这类命令示例 —— 只有盘符与项目名，**不含用户名与凭据**。

这次重写只换了**提交信息**（`--msg-filter`），树的内容一个字节都没动，所以那 4 处示例仍在
历史里。不重写不影响安全；若要连它们一起清掉，用 `--tree-filter` / `git-filter-repo
--replace-text` 替换成 `<clone dir>` 再重写一次即可（重写会再次改变全部提交哈希，
因为已经有 Release 挂在 tag 上，请按上面第 4 步的原子推送方式做）。

`ci.yml` 会在每次 push / PR 上自动跑：构建前端、`sanitize-check`、
四个工具的语法检查、`launcher --doctor` / `--paths`、启动器脚本的 ASCII 断言。
它**不会**跑 `traverse*`（需要真实浏览器与网络），那两个是发布前在本机跑的。

## 注意

- `.sanitize-names`（本地私人名字清单）与 `config.json`、`reports/`、`feeds/`、
  `logs/`、`dist/`、`build/` 都已在 `.gitignore` 里，不会进版本库。
- 在 CI 上 `.sanitize-names` 不存在，所以「私人名字」那条规则会自动跳过，
  其余规则照常生效。
