# Publishing to GitHub

This machine currently has **no** gh CLI, no configured git credentials, and no global git identity,
so the push step is up to you. Below is the sequence you can copy as is.

> Below, `<repo>` stands for the project directory you cloned/unpacked; replace it yourself.
> The document writes no machine-specific absolute paths.

## 0. First, change the commit identity to your own

The author of the single commit in the repository is currently a neutral placeholder identity. Change
it to yourself (affects this repository only):

```powershell
cd <repo>
git config user.name  "your GitHub username"
git config user.email "your GitHub email"
git commit --amend --reset-author --no-edit
```

`--reset-author` rewrites the author of the existing commit too, so the history is clean.
If you want it to apply to **all** repositories, use `git config --global` instead of `git config`.

## 1. Create an empty repository on GitHub

- The suggested repository name is `vtuber-monitor-link` (apostrophes and spaces in a GitHub
  repository name are awkward; put `Vtuber's Monitor Link` in the display name/description instead).
- Do **not** tick "Add a README / .gitignore / LICENSE" -- they already exist locally, and ticking
  them adds an unrelated commit that you would have to pull before pushing.

## 2. Add the remote and push

```powershell
cd <repo>
git remote add origin https://github.com/<your username>/vtuber-monitor-link.git
git branch -M main
git push -u origin main
```

The first HTTPS push opens a GitHub login (browser authorisation or pasting a Personal Access Token).

## 3. Tag it, and let Actions build the package

`release.yml` listens for `v*` tags: it builds on a clean windows-latest, runs `npm run verify` and
`npm run sanitize-check`, zips the result, and attaches it to the Release.

```powershell
git tag -a v1.0.0 -m "Vtuber's Monitor Link v1.0.0"
git push origin v1.0.0
```

Then watch the `release` workflow finish on the repository's **Actions** page, and a release carrying
`VtuberMonitorLink-1.0.0-win-x64.zip` appears on the **Releases** page.

## Alternative: attach the package manually instead of waiting for Actions

It is already built and proofread locally, so uploading it directly works too:

```
dist\VtuberMonitorLink-1.0.0-win-x64.zip   40 MB
```

On GitHub: `Releases` -> `Draft a new release` -> pick tag `v1.0.0` ->
drag the zip in -> Publish.

## Suggested self-check before publishing

**One heavy step at a time.** Every command below is heavy in a different way - `workers` compiles Java,
C++ and Go and then runs eight interpreters, `release` builds a portable package and drives a browser,
`verify:fast` runs twenty-odd test scripts. What makes that a rule is **memory, not cores**, and it is worth
being exact because the obvious guess is wrong. Measured on the development machine for this project (6
physical cores, 12 logical): one CPU-bound process runs at 142 ms of work, two at 142 ms, four at 144, eight
at 144, twelve at 150 - i.e. light single-threaded processes are nearly free up to the core count, and the
serialisation rule has nothing to do with them. What is not free is allocation: the machine had 4.8 GB free
of 15.9 GB, so the steps that spawn many processes or allocate heavily - a portable build, a .NET or JVM
build, a browser traversal with its dozen helper processes - are the ones that make everything else crawl,
themselves included. Run *those* one at a time, and when a step exists in a narrow form, prefer it
(`node tools/workers.mjs --cap <name> --only <worker>`) while anything else is running.

```powershell
npm run sanitize-check   # any hard-coded paths / secrets / private names in the source
npm run brand            # VML naming consistency: full name for outward-facing artifacts, VML for internal identifiers
npm run english          # English coverage (percentages for the engineering layer / the UI side)
npm run commit-msg       # is every commit message English (the whole history)
npm run workers          # the multilingual worker layer: build what is missing, then diff the corpus
npm run release          # build + proofread + endpoint traversal + UI traversal (needs a browser on this machine)
node tools/make-release.mjs --out ../VML-release   # the sanitized public tree, plus releases/<version>/
npm run verify:release-copy -- --root ../VML-release   # does that copy actually correspond to this tree?
```

The last two are the release *directory* rather than the repository, and they answer different
questions: `make-release` builds and copies, the project's own scanner runs inside it and reports on
content, and `verify-release-copy` then checks correspondence - that the development-only worker layer
and the machine-local overlay are absent, that the last source fix is inside the copy and inside a
packaged UI built after it, that the README's locale count agrees with the registry in the copy, and
that the zip still hashes to the value its own `SHA256SUMS.txt` records. A scan cannot tell you any of
those, because none of them is about the text of a file.

`npm run verify:fast` already gates the first two of those (`vml-brand`, `english-logic`) together
with the proofread pass for every shipped locale, so "it builds" and "naming/language/proofread have not
regressed" are the same gate.
`npm run commit-msg` is not part of `verify:fast` (it has to read the **whole git history**, and a
shallow clone only sees the tip), so it is guarded in two places: the `check` job of `ci.yml`
(`fetch-depth: 0`) and the local hook `.githooks/commit-msg`.

**Commit messages are always English** (2026-09-14): the rule, the criterion and the citations allowed
to remain are in `docs/ENGLISH-LOGIC.md` §8.
Enable the hook locally once:

```powershell
git config core.hooksPath .githooks
```

### Turning commit messages English: how it was done this time

After the first public release, **14 of the 57 commits** in the repository had **Chinese bodies** (the
subject was already English; Chinese was only in the body) -- which for an outside reader amounts to
being unreadable. They were rewritten in place into English with `git filter-branch --msg-filter`. Key
points:

```powershell
# Back up the whole history first (outside the repository). Then, in order - replace messages only:
# msg-filter does a lookup-table replacement, commit-filter re-signs the commits that were originally
# signed, tag-name-filter cat points the two tags at the rewritten commits. Compare one by one: commit
# count, tree, author/date, parent-child structure and signature status must all be unchanged, with
# only the messages different. Atomic push with leases, so a failure pushes nothing at all.
git bundle create <backup path>.bundle --all
$env:FILTER_BRANCH_SQUELCH_WARNING = '1'
git filter-branch -f --msg-filter "node <filter>" `
  --commit-filter 'if git cat-file -p "$GIT_COMMIT" | grep -q "^gpgsig"; then git commit-tree -S "$@"; else git commit-tree "$@"; fi' `
  --tag-name-filter cat -- --branches --tags
git push --atomic --force-with-lease=refs/heads/main:<old value> `
  --force-with-lease=refs/tags/v1.0.0:<old value> --force-with-lease=refs/tags/v1.0.1:<old value> `
  origin refs/heads/main refs/heads/main refs/tags/v1.0.0 refs/tags/v1.0.0 refs/tags/v1.0.1 refs/tags/v1.0.1
```

Three pitfalls you must know about (all measured the hard way; recorded in BUGS #72-#74):

- **`--msg-filter` rewriting drops signatures**: a commit whose local `%G?` is `G` becomes unsigned
  after the rewrite -- the commit signature must be restored by `git commit-tree -S` inside
  `--commit-filter`, otherwise every "Verified" is lost.
- **An annotated tag's signature is rebuilt into an invalid one**: `filter-branch` rebuilds the tag
  object (the message is preserved, the signature is kept but no longer matches). Re-sign with
  `git tag -f -s -F <message file>` and keep the tagger time unchanged with `GIT_COMMITTER_DATE`
  (`git tag -v` has to show `Good "git" signature` to count).
- **GitHub's Verified and local `G` are two different things**: when the SSH key used for signing is
  not registered on the account (Settings -> SSH and GPG keys -> New SSH signing key), the API always
  answers `verified=false, reason=no_user` -- unrelated to what this machine displays, and unrelated
  to this rewrite.

**About machine paths in the git history**: the working tree no longer contains any machine-specific
path (the rules in `tools/verify-release.cjs` stop leftovers during `npm run release`; this file itself
was caught once), but the **history** still keeps early document command examples like "cd to the
development directory" -- only a drive letter and the project name, **no username and no credentials**.

This rewrite replaced **commit messages** only (`--msg-filter`); the content of the trees did not
change by a single byte, so those 4 examples are still in the history. Leaving them does not affect
security; if you want to clear them out as well, replace them with `<clone dir>` using `--tree-filter` /
`git-filter-repo --replace-text` and rewrite once more (a rewrite changes all commit hashes again, and
since a Release is already attached to a tag, do it with the atomic push from step 4 above).

`ci.yml` runs automatically on every push / PR: build the frontend, `sanitize-check`, the syntax check
of four tools, `launcher --doctor` / `--paths`, and the ASCII assertion on the launcher script.
It does **not** run `traverse*` (they need a real browser and network); those two run locally before a
release.

## Notes

- `.sanitize-names` (the local private-name list) and `config.json`, `reports/`, `feeds/`, `logs/`,
  `dist/`, `build/` are all in `.gitignore` and do not enter the repository.
- In CI `.sanitize-names` does not exist, so the "private names" rule is skipped automatically and the
  remaining rules apply as usual.
