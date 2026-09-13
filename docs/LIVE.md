# Live status & multi-screen / 开播监测与多屏观看

## Feature provenance (attribution and licence)

This feature draws on **dd-center/bilibili-dd-monitor** (author wdpm, **MIT License**, Copyright (c) 2020 wdpm),
and on the dd-center/bili-dd-monitor it derives from. Upstream is "a multi-screen live viewing tool designed for DDs",
built around two things: **real-time stream start/stop detection** and **automatic grid layout for multiple players**.

This project **reimplemented** both on its own stack (Express + React):
**no upstream code, images, banner, styles or configuration were copied**, only the functional idea was borrowed.
MIT permits derivatives, but here we chose a rewrite rather than a port; the upstream licence is recorded as attribution in the sentence above.

## The upstream data source is dead

Upstream relies on vtbs.moe's `/v1/live` for the list of live streams. Measured (2026-09-11):

| Endpoint | Result |
| --- | --- |
| `https://api.vtbs.moe/v1/live` | **404** (taken down; upstream itself has stopped updating too) |
| `https://api.vtbs.moe/v1/info/<uid>` | 404 |
| `https://api.vtbs.moe/v1/short` | 200, about 9762 `{mid, uname, roomid}` roster entries, **still usable** |

So this implementation switched to the measured-usable bilibili batch endpoint; the roster is kept only as an aid for "find a uid by name":

```
GET https://api.live.bilibili.com/room/v1/Room/get_status_info_by_uids?uids[]=<uid>&uids[]=...
  -> code=0, data keyed by uid: { room_id, live_status, title, uname, cover, online, area_name }
```

## Three states that must be distinguished

`live_status`: `0` not live, `1` live, **`2` 轮播** (transient: "looping a recording").

**Loops are not real streams.** Treating them as streams produces a steady stream of false alerts -- in the measured run 嘉然, 泠鸢 and hanser
were all at `2` (looping), so handling it as "anything non-zero is live" would have pushed three false alarms immediately. The UI therefore shows
three levels, and `live.notifyOnLive` only notifies when the state becomes `1`.

## Multi-screen viewing

Uses bilibili's official embedded player, `https://live.bilibili.com/blanc/<roomId>?hidePanel=1`.

Measured: that page has **no `X-Frame-Options` / `frame-ancestors`**, so it can be embedded in an iframe directly,
and therefore **no forwarding, proxy or local playback service is needed**, which also means no login state, cookie or user data is involved.
The iframe carries `referrerPolicy="no-referrer"`, so this page's address is not sent back to bilibili.

The grid is pure frontend: the column count is selectable (adaptive / 1-4 columns), and the choice is stored in localStorage (it does not pollute the configuration file).

## Multi-platform and "bitrate / frame count" -- measured boundaries (2026-09-11)

The requirement mentions "live sources from YouTube, Twitch and similar platforms plus real-time comment streams, showing latency, packet loss, bitrate and frame count below each source".
So let us separate **what can be done** from **what cannot**, rather than build a feature that shows fake numbers.

### 1. Bitrate / frame count / dropped frames: **not measurable** across an embedded cross-origin player

The official embedded players of YouTube / Twitch / bilibili all run inside a **cross-origin iframe**. Under the same-origin policy the parent page cannot reach its
`<video>` element, so `getVideoPlaybackQuality()` (total frames / dropped frames), `buffered` (buffer and live edge) and the
negotiated bitrate (MSE/ABR) **are all unreadable**. This is not something left unimplemented; it is a browser security boundary.

The UI states it plainly: "bitrate / frame count: not measurable across an embedded cross-origin player" (UI string: `码率 / 帧数：跨域嵌入播放器测不到`), with no fake numbers.

**There is only one way to really measure it: take the stream URL and play it ourselves.**
- bilibili: `getRoomPlayInfo` works (measured `code=0`), but **only rooms actually streaming have a stream URL** --
  in the measured run 嘉然/泠鸢/hanser were all **looping** (`live_status=2`) and the returned stream list was empty.
  Once played ourselves in `<video>`/MSE, frame count, dropped frames, bitrate and live-edge latency can all be measured for real.
- YouTube / Twitch: this needs a tool such as yt-dlp / streamlink to fetch the stream, which carries ToS and stability costs and adds a dependency.
  This project is a portable exe and does not intend to introduce such a dependency.

### 2. Real-time comment streams: bilibili danmaku **is currently blocked by risk control**

| Attempt | Result |
| --- | --- |
| `getDanmuInfo` (only buvid3/buvid4 + referer) | **-352** |
| `getDanmuInfo` (using the Opera profile's **SESSDATA** login state) | **-352** |
| WebSocket `wss://<host>/sub` (protover=3, brotli) | No token obtainable, connection cannot be established |

That is, **even with login state it does not get in**, and the judgement is that this batch of endpoints has gained a WBI signature requirement (this project has already hit
the same kind of risk control on bilibili's dynamics endpoints). Without a token from `getDanmuInfo`, the brotli unpacking that follows
(Node's built-in `zlib.brotliDecompressSync`) cannot be verified either.
**So danmaku was not wired in this round** -- a half-broken real-time stream is worse than none. The next step is to add WBI signing (`w_rid`/`wts`) for that endpoint.

Twitch's anonymous IRC (`wss://irc-ws.chat.twitch.tv` + `justinfan`) is a workable approach that needs no authentication,
but Node's built-in `WebSocket` **does not support going through an HTTP proxy**, and reaching Twitch from this machine requires a proxy --
so doing it means first implementing "CONNECT -> TLS upgrade -> WebSocket handshake" ourselves, which is a separate piece of work.

### 3. What was actually done: **network-layer** latency and failure rate per live source

This layer is what a third-party page **can honestly measure**, and it is wired up:

- Each live card has a "Measure network" button below it (UI string: `测网络`), using the project's existing prober;
- A direct measurement takes the **TCP handshake RTT**, a proxied one takes the **time to first byte through the proxy**; "failure rate" = failures ÷ attempts;
- It gives a conclusion (which exit is faster / which one does not connect), and for rooms that are live, opening the page automatically measures the first 6.

Measured sample (bilibili live room): direct **19ms / 0%**, proxy **316ms / 0%** -> "direct is faster (19ms vs 316ms)" (UI string: `直连更快（19ms vs 316ms）`).

### 4. Tor exits (measured 2026-09-12)

**Tor itself**: this machine has Tor Browser's `tor.exe` 0.4.9.11 installed, configured to use the **snowflake bridge**
(`ClientTransportPlugin snowflake exec ...\lyrebird.exe`). Launched with the parameters below, the
bootstrap log reaches `Bootstrapped 100% (done)` in about 55 seconds overall -- no extra port forwarding or similar is needed.

```
cd "<Tor Browser>\Browser"           # cwd must be here: pluggable transports use relative paths
tor.exe --defaults-torrc "TorBrowser\Data\Tor\torrc-defaults" ^
        -f "TorBrowser\Data\Tor\torrc" ^
        --SocksPort 9150 --DisableNetwork 0
```

(`<Tor Browser>` is the directory where you installed Tor Browser. The "Launch Tor" button on the page (UI string: `唤起 Tor`) assembles these
parameters from that layout automatically, with no typing needed -- it is written out here to explain what it actually does.)

Three traps (all three are recorded in `torLaunchPlan()` and BUGS #56):

1. `torrc-defaults` must be passed with **`--defaults-torrc`**: the command line allows only one `-f`, and two are rejected
   (`Duplicate -f options`), whereupon all snowflake transport plugins are lost and it reports
   `there is no configured transport called "snowflake"`;
2. When Tor Browser exits it leaves `DisableNetwork 1` in the torrc, which must be overridden explicitly, otherwise it stays at 0% forever;
3. A bare spawn uses the defaults (SocksPort **9050**, no bridge, data directory landing on the C drive) -- the
   "Launch Tor" button on the page originally was a bare spawn, so pressing it was as good as not starting Tor at all.

**Measured on the app side** (`POST /api/proxy/tor`): `{"ok":true,"socks":"127.0.0.1:9150","isTor":true,"ip":"185.220.101.23"}`.

**Three-exit comparison** (`POST /api/probe`, samples=1):

| Target | Direct | Via Tor |
| --- | --- | --- |
| `https://example.com/` | 186ms (TCP handshake) | 1800ms (first byte) |
| `https://api.bilibili.com/x/web-interface/nav` | 24ms | 1764ms |

That is, **bilibili can be reached via Tor too**, just an order of magnitude slower (snowflake's own bandwidth is small).
So the sensible usage is "send individual sources via Tor" (the dropdown on the source page sets this), not switching Tor on globally.

**Privacy reminder**: do not carry login state under a Tor exit (bilibili login, Moegirl BotPassword, etc.) --
binding a real-name account's identity to a Tor exit is connecting the two yourself. The exit IP also changes every time.


## No-traces handling

Following the project's standing privacy constraints, this batch of features achieves:

- **No upstream resource is pulled in** (images, fonts, styles, configuration), so there are no binaries or metadata of unknown origin;
- The player connects directly to bilibili's official page, **with no third-party relay in between**, and does not send back the local address (`no-referrer`);
- Stream-start queries go direct (consistent with this project's other bilibili sources), **using and storing no cookie at all**;
- The danmaku-sending part needs login state, but **opening the page does not read it** -- it reads the browser's cookie store, and the read
  synchronously decrypts DPAPI (measured 3-4 seconds, during which the whole service is stopped), so it only reads when "Check login state" is clicked (UI string: `检查登录态`),
  and the server caches a read for 60 seconds (BUGS #47);
- No uid is hardcoded in the code: monitored objects all come from configuration or existing sources; the uids that appear are only in **test scripts**,
  and all of them are public official accounts;
- Neither `docs/` nor the release package contains any machine path, account or key (enforced by `npm run verify` and `npm run sanitize-check`).

## Feature comparison with upstream

| Upstream feature | This project |
| --- | --- |
| List of currently live vtbers | The "Live" page, distinguishing live / looping / not live |
| Grouped follows | Reuses source categories and watch-target tags |
| Vtuber information database listing | Look up a uid by name in the vtbs.moe roster (an auxiliary feature) |
| Local settings | Web settings (config.json) |
| Player / automatic multi-player grid | Multi-screen grid (selectable column count, choice saved locally) |
| Electron desktop app | Folded into this project's existing local web console; no second program needed |
