# Observation mode / 观测模式

> Goal: **to see the state of a whole agency, without leaving a trace that "someone is watching the whole agency".**
> The measured data and the criteria are below; the implementation is in `server/src/observe.js` and the self-check in `tools/observe-test.mjs`.

## 1. First, state the threat model clearly

To judge the real state of an agency (team), you have to look at what several of its members do at the same time. The trouble is that **this act itself**
-- "sweep the whole agency at one moment" -- does not depend on which IP you come from.

| Signal | Who can see it | Can Tor hide it |
| --- | --- | --- |
| Your real IP | The site being visited | **Yes** (replaced by a Tor exit) |
| Request content: which uids and which members were queried at once | The site being visited | **No** |
| Timing: the same moment every day, intervals exactly equal, fixed order | The site being visited | **No** |
| Login state (SESSDATA / BotPassword / account) | The platform, and it is bound to your real-world identity | **No** (worse, in fact: it links the identity to the observation) |
| Access logs on the agency's own site | **The agency itself** | **Yes** -- this is the only category where the logs are in the other party's hands |

Conclusion: Tor only solves the first row. What really reduces sensitivity is **sampling (changing "how much is looked at in one pass")** and **jitter (changing "when it is looked at")**,
and neither of those has anything to do with Tor; where Tor should be used is decided by "whose hands the logs are in".

Honesty also requires this: Tor traffic **is conspicuous** in the eyes of a security department (Tor exit IPs are a public list).
Its value is not "invisibility", but that it **cannot be attributed to you**; and the fact that "a Tor exit looked at the whole agency once"
is still in the other party's logs -- which is exactly why sampling and jitter are needed, to erase the "whole agency in one go" pattern.

## 2. Measured boundaries (2026-09-12, local machine)

Measured with **the project's own signed fetcher** (this point matters: hitting bilibili's API directly with curl returns 412,
which is "unsigned" rather than "blocked by Tor"; that was my first misjudgement):

| Target | Direct | Via Tor |
| --- | --- | --- |
| `api.bilibili.com` space dynamics (bili-opus source) | `ok=true items=20`, 321ms | **`ok=true items=20`, 2521ms** |
| `api.live.bilibili.com` batch stream-start status | `code=0` | `code=0` |
| `api.bilibili.com/x/web-interface/nav` (fetch the WBI key) | Works | Works |
| `api.bilibili.com/x/space/acc/info` | Works | **`-799 请求过于频繁`** (transient: "requests too frequent") |
| Agency self-hosted sites | — | hololivepro 200 / vspo 200 / cover-corp 200, **anycolor 403 (Cloudflare blocks Tor)** / brave-group timeout |

Changing exits (Tor's `IsolateSOCKSAuth`, isolating circuits by SOCKS username):

```
obs1:x → 192.42.116.48     obs2:x → 193.189.100.201
obs3:x → 45.84.107.174     obs4:x → 64.190.76.13
repeated three times without a username → 199.195.253.124 (the same one all three times)
```

In other words, **by default a whole sweep leaves through the same exit**; only after rotation is it spread out.

## 3. How the four things land

### 3.1 Sampling (`sampleRatio`, default 50%)

Each round takes only part of the objects. The selection is neither purely random nor purely LRU:

- Purely random lets some object go unseen for several rounds in a row, so coverage is filled in very slowly;
- Purely LRU means "the batch unseen longest" is always the same batch, and the pattern becomes predictable again.

So: **first order a candidate pool by "unseen longest" (the pool is larger than the sample size), then take a random selection from the pool, then shuffle the order.**
Coverage is filled in by the local incremental archive -- after a few days the profile is complete all the same, but no **single** observation points at "someone is watching the whole agency".

Watch targets (`watch.targets`) and sources (`sources`) are sampled separately, each with its own minimum count (default 2 / 1),
so that a round does not take only one when there are very few objects.

### 3.2 Jitter (`jitterSeconds`, default 3-12 seconds)

Random waits drawn from the interval are applied both between requests and between watch targets, replacing the fixed `run.defaultGapSeconds`.
When `base = 0` there is **no jitter** (an explicit "do not wait" wins -- the diagnostic path relies on it to skip rate-limit waits).

### 3.3 Assigning exits by "whose hands the logs are in" (`torForAgency`)

- **Agency self-hosted sites -> Tor.** The allowlist is `AGENCY_HOSTS` in `observe.js` (hololivepro / anycolor /
  nijisanji / brave-group / vspo / cover-corp / a-soul / yousa...). Only for this kind of entry point do the logs
  sit on the other party's server, which is where Tor means anything.
- **Platform sources (bilibili / Reddit / Fandom) are left alone** -- the agency cannot see those logs, and via Tor they measured 8 times slower,
  with individual endpoints getting rate-limited. If the user has explicitly pinned `tor` on the source page, that is still respected (it is an explicit intent).
- Any domain not on the allowlist is treated as a platform: **better to use Tor less than to apply it indiscriminately**.

### 3.4 Login-required sources are not run (`skipLoginSources`)

Sources with `login: required` are **skipped outright** in this mode, and the reason is written into both the logs and the report.
Binding a real-world identity to observation behaviour is far more serious than an IP.

### 3.5 Changing exits (`rotateExit`)

`torEgressUrl()` in `net.js` stuffs a username into the SOCKS address (`obs-<source id>`),
and Tor isolates circuits by username -> different sources take different exits. One source keeps the same circuit within one round
(it does not change per HTTP request, avoiding reconnection overhead and exit jitter).

## 4. Honest display

Sampling **changes** what the UI readings mean, so it has to be said, otherwise "no sample was taken this round" gets read as "that person did nothing":

- Run page: `本轮为取样 · 来源 3/6 · 监视对象 3/6 · Tor: official-hololive …` (transient: "this round sampled · sources 3/6 · watch targets 3/6")
- Start of the report: a blockquote stating the sampling ratio for the round, which sources went via Tor, and which login-required sources were skipped;
- Run log: one line each for the sampled counts, the Tor sources and the skip reasons.

**"Did not appear this round" ≠ "no activity"**, and this sentence is written in both the UI and the report.

## 5. Configuration

Settings page -> "Observe mode" (UI string: `观测模式`) (or edit `config.json` directly):

```json
"observation": {
  "enabled": true,
  "sampleRatio": 0.5,
  "minSources": 2,
  "minWatch": 1,
  "jitterSeconds": [3, 12],
  "torForAgency": true,
  "skipLoginSources": true,
  "rotateExit": true
}
```

Rotation state is stored in `logs/observation.json` (runtime data; it does not enter the repository or the release package).

## 6. Self-check

`npm run test:observe` (already wired into `verify:fast`) pins the behaviour down with a **fixed random source**:

- Log attribution decisions (including "if it cannot be recognised, treat it as a platform");
- Sampling ratio, minimum counts, **rotation fairness** (after 8 rounds every object has been taken at least once), **unpredictability** (the same history plus
  a different random source -> a different selected set), and the order being shuffled;
- The jitter interval, explicit 0 meaning no jitter, and a base above the interval's lower bound not leading to shorter waits instead;
- The overall plan in observe mode: take half, agency sites switched to Tor, platform sources not forced over, login-required sources removed with a stated reason;
- Every domain in the allowlist is recognised (guarding against a typo in a hand-written domain).
