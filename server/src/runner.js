// runner.js — orchestrates one full run
// Flow: preflight -> fetch the selected sources -> check watch targets -> write feeds/intel items
//       -> LLM analysis (carrying the watch alerts) -> write the report
import { effectiveSources } from './sources.js';
import { fetchAll } from './fetchers/index.js';
import { analyze, preflight } from './analyze.js';
import { collectItems, matchedKeywords } from './items.js';
import { checkAll } from './watch.js';
import { ensureDirs, runLogPath, saveFeedFiles, saveItems, saveReport } from './reports.js';
import path from 'node:path';
import { createLogger } from './logger.js';
import { applyProxy } from './net.js';
import { notify } from './notify.js';
import { flushQueue } from './notify.js';
import { feedByPerson } from './people.js';
import { runClustering } from './cluster.js';
import { archiveRun, latestItemsByPerson, openArchive, peopleSeries } from './archive.js';
import { detectSilence, silenceSummary } from './silence.js';
import { DORMANT_DEFAULTS, dormantBlock } from './dormant.js';
import { torPortOpen } from './socks.js';
import { budgetStatus, costSummary, loadUsage, recordUsage, summarizeUsage } from './cost.js';
import { tagItems, visionReady } from './vision.js';
import { diagnoseSource } from './diagnose.js';
import { recordOutcome } from './egress.js';
import { upcoming } from './calendar.js';
import { loadObservationState, observationPlan, recordPicked, saveObservationState } from './observe.js';

/** The anniversary section of the daily report (when there is none the whole block is dropped, rather than leaving an empty heading) */
function calendarSection(cal) {
  const rows = (cal.due ?? []).filter((r) => !r.past);
  if (!rows.length) return '';
  const when = (d) => (d === 0 ? '**今天**' : d === 1 ? '明天' : `${d} 天后`);
  const kindIcon = { birthday: '🎂', debut: '🎉', '3d': '🧊', anniversary: '🎊', event: '📌', other: '·' };
  const lines = rows.slice(0, 20).map((r) => {
    const icon = kindIcon[r.kind] ?? '·';
    const turns = r.turns ? `（第 ${r.turns} 年）` : '';
    const leap = r.leapAdjusted ? ' ⚠ 闰日顺延到 3/1' : '';
    const note = r.note ? ` — ${r.note}` : '';
    return `- ${icon} ${when(r.days)}（${r.day}）**${r.name}**${turns}${leap}${note}`;
  });
  return `## ⏳ 纪念日倒计时（未来 ${cal.days} 天）\n\n${lines.join('\n')}\n\n> 按 ${cal.timeZone} 的「今天」（${cal.today}）计算。`;
}

/** In-memory state that the UI polls (and that the report/notification steps read back) */
export const runState = {
  running: false,
  mode: null,
  startedAt: null,
  finishedAt: null,
  step: 'idle',
  sourcesTotal: 0,
  sourcesDone: 0,
  watchTotal: 0,
  watchDone: 0,
  sampling: null,
  silence: null,
  cost: null,
  dormant: null,
  itemCount: 0,
  alerts: 0,
  advice: [],
  features: null,
  live: null,
  lastResult: null,
  lastError: null,
  tail: [],
};

function push(line) {
  runState.tail.push(line);
  if (runState.tail.length > 400) runState.tail.splice(0, runState.tail.length - 400);
}

export function selectSources(cfg, mode) {
  return effectiveSources(cfg).filter((s) => {
    if (!s.enabled) return false;
    const isMerch = s.cadence === 'merch';
    return mode === 'merch' ? isMerch : !isMerch;
  });
}

/**
 * @param {{cfg:object, mode?:'daily'|'merch'|'watch', task?:object, catchUp?:boolean}} args
 */
export async function runOnce({ cfg, mode = 'daily', task = null, catchUp = false }) {
  if (runState.running) return { ok: false, error: '已有一个运行在进行中 / a run is already in progress' };

  ensureDirs(cfg);
  const log = createLogger(runLogPath(cfg, mode));
  const origInfo = log.info;
  const origWarn = log.warn;
  const origErr = log.error;
  log.info = (m) => (push(`[INFO] ${m}`), origInfo(m));
  log.warn = (m) => (push(`[WARN] ${m}`), origWarn(m));
  log.error = (m) => (push(`[ERR ] ${m}`), origErr(m));
  if (task) log.info(`scheduled task "${task.name}"${catchUp ? ' (catch-up)' : ''} starting`);

  /** The single place outbound alerts go through */
  const pushNotify = async (title, body, level) => {
    try {
      const r = await notify(cfg, log, { title, body, level });
      if (r.sent) log.info(`delivered to ${r.sent} channel(s)`);
    } catch (err) {
      log.warn(`notify failed — ${err.message}`);
    }
  };

  Object.assign(runState, {
    running: true,
    mode,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    step: 'starting',
    sourcesTotal: 0,
    sourcesDone: 0,
    watchTotal: 0,
    watchDone: 0,
    sampling: null,
    silence: null,
    cost: null,
    dormant: null,
    itemCount: 0,
    alerts: 0,
    features: null,
    live: null,
    lastError: null,
    tail: [],
  });

  try {
    // 0) Apply the proxy config (Node's fetch does not read the system proxy by default, it has to be set explicitly)
    runState.step = 'proxy';
    const px = await applyProxy(cfg);
    log.info(`proxy: ${px.applied ?? 'direct'}`);

    // 1) Preflight: LLM connectivity/balance (so that a whole run is not wasted)
    runState.step = 'preflight';
    log.info('preflight: LLM connectivity');
    // Budget gate: warn by default (this is a tool the user runs themselves, and blocking it without
    // a word would be overreach); setting llm.budget.onExceed to 'stop' is what really blocks it.
    try {
      const budget = budgetStatus(cfg, summarizeUsage(loadUsage(cfg).rows));
      runState.cost = { ...summarizeUsage(loadUsage(cfg).rows, { days: 14 }), budget };
      if (budget.exceeded && budget.action === 'stop') {
        runState.lastError = `今日 LLM 用量已超过预算（${budget.used}/${budget.limit} tokens）`;
        log.error(runState.lastError);
        await pushNotify('情报收集未执行', runState.lastError, 'error');
        return { ok: false, error: runState.lastError };
      }
      if (budget.exceeded || budget.nearLimit) {
        log.warn(`⚠ ${costSummary(runState.cost, budget)} — today's usage has ${budget.exceeded ? 'exceeded' : 'nearly reached'} the budget`);
      } else {
        log.info(costSummary(runState.cost, budget));
      }
    } catch (e) {
      log.warn(`cost summary failed (does not affect the run): ${e.message}`);
    }
    const pre = await preflight(cfg);
    if (!pre.ok) {
      log.error(`preflight failed — ${pre.error}`);
      runState.lastError = `LLM 前置检查失败：${pre.error}`;
      await pushNotify(`${mode === 'merch' ? '通贩扫描' : '情报收集'}失败`, `LLM 前置检查未通过：${pre.error}`, 'error');
      return { ok: false, error: runState.lastError };
    }
    log.info(`LLM ready: ${pre.provider?.name ?? '?'} · ${pre.provider?.model ?? '?'}`);

    // 2) Fetching — in observation mode, work out first "who is picked this round, which egress, what interval"
    runState.step = 'fetching';
    const obsState = loadObservationState(cfg);
    const allSources = mode === 'watch' ? [] : selectSources(cfg, mode);
    const allWatch = (cfg?.watch?.targets ?? []).filter((t) => t.enabled !== false);
    // Probe the Tor port once before starting: if it is down, skip the sources that would go
    // through Tor this round instead of letting them fail individually (such a failure is recorded
    // as a fault on the source's side and triggers the self-check — but it is a false fault; the
    // snowflake bridge has been measured dropping the link instantly)
    const torReachable =
      cfg?.observation?.enabled === true && cfg?.proxy?.torSocks ? await torPortOpen(cfg.proxy.torSocks) : null;
    if (torReachable === false) log.warn('local Tor port is unreachable: skipping sources that would route through Tor this round (retried next time, not counted as a failure)');
    const plan = observationPlan({ cfg, sources: allSources, watchTargets: allWatch, history: obsState, torReachable });
    if (plan.enabled) {
      log.info(
        `observation mode: source sampling ${plan.sampling.sources.k}/${plan.sampling.sources.n}` +
          `, watch-target sampling ${plan.sampling.watch.k}/${plan.sampling.watch.n}` +
          ` (the ones not picked come up in a later round)`,
      );
      if (plan.sampling.tor.length) log.info(`sources routed through Tor (the log is on their side): ${plan.sampling.tor.join(', ')}`);
      const skipIds = plan.skippedLogin.map((x) => x.id);
      if (skipIds.length) log.info(`observation mode skips sources that need a login: ${skipIds.join(', ')} (so identity is not tied to the observation)`);
    }
    const sources = plan.enabled ? plan.sources : allSources;
    runState.sourcesTotal = sources.length;
    runState.sampling = plan.enabled
      ? {
          ...plan.sampling,
          at: new Date().toISOString(),
          note: '本轮是取样：未取到的对象会在后续轮次轮到（本地是增量归档，画像仍会补齐）',
        }
      : null;
    log.info(`fetching ${sources.length} sources`);
    const results = await fetchAll(sources, { cfg, log });
    runState.sourcesDone = results.length;
    if (plan.enabled) saveObservationState(cfg, recordPicked(obsState, [...plan.sampling.sources.picked, ...plan.sampling.watch.picked]));

    // 3) Watch targets (in observation mode only the ones picked this round are checked)
    let watchResults = [];
    if (cfg?.watch?.enabled !== false && (cfg?.run?.watchWithRun !== false || mode === 'watch')) {
      const targets = allWatch;
      runState.watchTotal = plan.enabled ? plan.watchTargets.length : targets.length;
      runState.step = 'watching';
      if (runState.watchTotal) log.info(`checking ${runState.watchTotal} watch targets`);
      watchResults = await checkAll(cfg, log, plan.enabled ? { targets: plan.watchTargets } : {});
      runState.watchDone = watchResults.length;
    }

    // 3.5) Live monitoring — the most time-sensitive intel there is: a stream going live is worth knowing about at once, more than any keyword hit
    if (cfg?.live?.enabled !== false && cfg?.live?.checkWithRun !== false) {
      runState.step = 'live';
      try {
        const { checkLive } = await import('./live.js');
        const lr = await checkLive(cfg, sources, log);
        runState.live = {
          live: lr.live?.length ?? 0,
          round: lr.round?.length ?? 0,
          wentLive: (lr.wentLive ?? []).map((x) => x.name || x.uname || x.uid),
          error: lr.error ?? null,
        };
        if (lr.wentLive?.length && cfg?.live?.notifyOnLive !== false) {
          await pushNotify(
            `${lr.wentLive.length} 个开播了`,
            lr.wentLive
              .slice(0, 8)
              .map((x) => `${x.name || x.uname}${x.title ? `：${x.title}` : ''} ${x.url ?? ''}`)
              .join('\n'),
            'alert'
          );
        }
      } catch (err) {
        log.warn(`live check skipped — ${err.message}`);
        runState.live = { live: 0, round: 0, wentLive: [], error: err.message };
      }
    }

    // 4) Intel items (used by both the web card stream and the report)
    runState.step = 'saving-feeds';
    const date = new Date().toISOString().slice(0, 10);
    let items = collectItems(results, cfg?.ui?.intelPerSource ?? 24);
    const keywords = cfg?.watch?.rules?.keywords ?? [];
    for (const it of items) {
      const hit = matchedKeywords(it, keywords);
      if (hit.length) it.keywords = hit;
      if (it.extra?.user && keywords.length) {
        const h2 = matchedKeywords({ text: it.text }, keywords);
        if (h2.length) it.keywords = [...new Set([...(it.keywords ?? []), ...h2])];
      }
    }
    let alerts = watchResults.reduce((n, r) => n + (r.events ?? []).filter((e) => e.reasons?.length).length, 0);
    let silenceAlerts = [];
    runState.itemCount = items.length;
    runState.alerts = alerts;

    // 4.5) Extract structured features with the LLM — so that "I only remember one feature" is still searchable.
    //      Cached and capped, and a failure does not affect the main flow.
    let enriched = items;
    if (cfg?.run?.extractFeatures !== false && items.length) {
      runState.step = 'features';
      try {
        const { extractFeatures, applyFeatures } = await import('./features.js');
        const r = await extractFeatures(cfg, items, log);
        enriched = applyFeatures(items, r.cache);
        runState.features = { extracted: r.extracted, cached: r.skipped, error: r.error ?? null };
      } catch (err) {
        log.warn(`features skipped — ${err.message}`);
        runState.features = { extracted: 0, cached: 0, error: err.message };
      }
    }
    items = enriched;

    const saved = saveFeedFiles(cfg, date, results);
    saveItems(cfg, date, items, {
      mode,
      sources: results.map((r) => ({ id: r.source?.id, ok: !!r.ok, bytes: r.content?.length ?? 0 })),
      watch: watchResults.map((r) => ({
        id: r.target?.id,
        label: r.target?.label ?? r.target?.id,
        kind: r.target?.kind,
        ok: !!r.ok,
        changed: !!r.changed,
        summary: r.summary ?? r.error ?? '',
        growth: r.growth ?? null,
        events: (r.events ?? []).slice(0, 100),
      })),
    });
    log.info(`feeds saved: ${saved.index.filter((i) => i.ok).length}/${saved.index.length}; ${items.length} intel items`);

    // 5) Analysis
    runState.step = 'analyzing';
    log.info('analyzing with the LLM…');
    const a = await analyze({ cfg, results, watchResults, mode, log });
    // Accounting: how many tokens this analysis cost (when usage is unavailable record known=false, never guess a number)
    if (a.ok) {
      try {
        recordUsage(cfg, {
          provider: a.provider?.name ?? a.provider?.id ?? null,
          model: a.provider?.model ?? null,
          mode,
          task: task?.id ?? null,
          usage: a.usage ?? null,
          totalTokens: a.usage?.total_tokens ?? 0,
        });
      } catch {
        /* failing to record does not affect the run */
      }
    }
    if (!a.ok) {
      runState.lastError = a.error;
      await pushNotify(`${mode === 'merch' ? '通贩扫描' : '情报收集'}分析失败`, a.error, 'error');
      return { ok: false, error: a.error, results };
    }

    // 6) Write the report
    runState.step = 'saving-report';
    // The anniversary countdown goes straight into the daily report: its whole value is that "you see it
    // right there while flipping through the report", not that you have to go and click a page.
    // It sits at the very top of the report — the closer the countdown, the earlier it should be seen.
    let markdown = a.markdown;
    // In observation mode the report has to say up front that "this round was a sample" — otherwise the
    // user reads "some target did not show up this round" as "that person has gone quiet"
    // (two completely different things).
    if (runState.sampling) {
      const sp = runState.sampling;
      const lines = [
        '> **本轮是取样（观测模式）**',
        `> 来源 ${sp.sources.k}/${sp.sources.n}、监视对象 ${sp.watch.k}/${sp.watch.n}；未取到的会在后续轮次轮到`,
        `> 本地归档是增量的，覆盖会补齐；「本轮没出现」不等于「没有动静」`,
      ];
      if (sp.tor?.length) lines.push(`> 走 Tor（日志在对方手上）：${sp.tor.join(', ')}`);
      if (sp.skippedLogin?.length) lines.push(`> 本轮跳过需要登录态的来源：${sp.skippedLogin.join(', ')}（避免身份与观测绑定）`);
      markdown = lines.join('\n') + '\n\n' + markdown;
    }
    let calendarBlock = '';
    try {
      const cal = upcoming(cfg, { days: Number(cfg?.calendar?.reportDays ?? 30) });
      calendarBlock = calendarSection(cal);
      if (calendarBlock) markdown = calendarBlock + '\n\n' + markdown;
      if (cal.reminders.length) {
        runState.calendarDue = cal.reminders;
      }
    } catch (e) {
      log.warn(`calendar failed (report unaffected): ${e.message}`);
    }

    // Silence detection: **"no activity" is intel too**. Content alerts cannot see absence —
    // a daily poster going quiet, several people going quiet at once, a whole agency dead for
    // days on end: none of that is visible in the old logic.
    // Every criterion is relative to each person's own cadence (see silence.js), never a fixed day count.
    try {
      if (cfg?.silence?.enabled !== false && (cfg.people ?? []).length) {
        const db = openArchive(cfg);
        const series = peopleSeries(db, { days: Number(cfg?.silence?.basisDays ?? 60) });
        const sil = detectSilence({ byDay: series.byDay, people: cfg.people, rules: cfg.silence ?? {}, now: new Date() });
        runState.silence = sil;
        if (sil.person.length || sil.group.length) {
          const lines = [];
          for (const g of sil.group) lines.push(`- ⚠️ **${g.reason}**`);
          for (const p of sil.person) lines.push(`- ${p.level === 'high' ? '🔴' : '🟡'} ${p.reason}`);
          markdown = `## 🔇 静默检测（没动静也是情报）\n\n${lines.join('\n')}\n\n${markdown}`;
          log.warn(silenceSummary(sil));
          alerts += sil.person.length + sil.group.length;
          runState.alerts = alerts;
          silenceAlerts = [...sil.group, ...sil.person];
        } else {
          log.info(silenceSummary(sil));
        }
      }
    } catch (e) {
      log.warn(`silence check failed (report unaffected): ${e.message}`);
    }

    // Dormant / graduated: the daily report answers "what is new today", so **anyone who stopped never
    // appears** — even if they posted just yesterday (the only post in half a year, and precisely the one
    // that most deserves to be seen). So, as the user asked, everyone inactive for **more than the configured
    // threshold (6 months by default)** is listed together at the **end of the daily report**, each with their
    // latest content.
    try {
      if (cfg?.report?.dormant?.enabled !== false && (cfg.people ?? []).length) {
        const drows = { ...DORMANT_DEFAULTS, ...(cfg.report?.dormant ?? {}) };
        // "People with activity today": needed for the comeback decision (they posted just yesterday, which is exactly the signal most worth seeing)
        const todayPeople = [...new Set((items ?? []).flatMap((i) => i.people ?? []).map(String))];
        const db2 = openArchive(cfg);
        // It has to cover >= 6 months of history, so the window is derived from months (rather than taking only 30 days)
        const lookback = Math.max(120, Math.ceil((Number(drows.months) || 6) * 30.44) + 45);
        const dSeries = peopleSeries(db2, { days: lookback });
        // Two passes: first work out who is dormant (this pass needs no content), then fetch the latest content only for those people
        const draft = dormantBlock({ people: cfg.people, byDay: dSeries.byDay, latestItems: {}, todayPeople, rules: drows });
        const ids = draft.dormant.map((d) => d.id);
        const items2 = ids.length ? latestItemsByPerson(db2, { personIds: ids, limit: drows.maxItems ?? 2 }) : {};
        const block2 = dormantBlock({ people: cfg.people, byDay: dSeries.byDay, latestItems: items2, todayPeople, rules: drows });
        runState.dormant = { dormant: block2.dormant.length, returnees: block2.returnees.length, skipped: block2.skipped };
        if (block2.markdown) {
          markdown = `${markdown}\n\n${block2.markdown}`;
          log.info(
            `dormant >= ${drows.months} months: ${block2.dormant.length} people (${block2.returnees.length} possibly returning) — listed at the end of the daily report`,
          );
        }
      }
    } catch (e) {
      log.warn(`dormant section failed (report unaffected): ${e.message}`);
    }

    // Follow-by-person: items that match a followed person get their own block. What the user cares about
    // is people, so "what did these 20 people do today" is far more useful than "what did 33 sources fetch".
    const followMatched = [];
    try {
      if (cfg?.peopleOptions?.reportMatches !== false && (cfg.people ?? []).length) {
        const feed = feedByPerson(items, cfg.people, { limit: 200 }).filter((f) => f.count > 0);
        if (feed.length) {
          const lines = [];
          for (const f of feed) {
            lines.push(`- **${f.person.name}**${f.person.agency ? `（${f.person.agency}）` : ''} — ${f.count} 条`);
            for (const it of f.items.slice(0, 3)) {
              const title = String(it.title ?? it.text ?? '').slice(0, 90);
              lines.push(`    - ${title}${it.url ? ` — ${it.url}` : ''}`);
            }
          }
          markdown = `## 👤 关注对象动态\n\n${lines.join('\n')}\n\n${markdown}`;
          followMatched.push(...feed.map((f) => ({ id: f.person.id, name: f.person.name, count: f.count, level: f.person.notifyLevel })));
          runState.followMatched = followMatched;
        }
      }
    } catch (e) {
      log.warn(`people match failed (report unaffected): ${e.message}`);
    }

    // Multi-source event merging: when the same thing is reported by several sources, the report keeps
    // only one entry and marks "confirmed by N sources" — that saves space and is direct evidence of credibility.
    try {
      if (cfg?.cluster?.enabled !== false && items.length > 1) {
        const { stats, clusters } = runClustering(cfg, items);
        runState.clusterStats = stats;
        const confirmed = clusters.filter((c) => c.confirmed).slice(0, 12);
        if (stats.duplicatesRemoved > 0) {
          const lines = confirmed.map((c) => {
            const n = c.items.length;
            return `- **${String(c.title).slice(0, 90)}** — ${c.sourceCount} 个来源${n > 1 ? `，合并 ${n - 1} 条重复` : ''}${c.leadSourceId ? `（首发/主源：${c.leadSourceId}）` : ''}`;
          });
          markdown = `## 🧩 多源确认事件（${confirmed.length}）\n\n${lines.join('\n')}\n\n> 共去掉 ${stats.duplicatesRemoved} 条重复报道。/ ${stats.events} events, ${stats.duplicatesRemoved} duplicates merged.\n\n${markdown}`;
        }
      }
    } catch (e) {
      log.warn(`clustering failed (report unaffected): ${e.message}`);
    }

    const file = saveReport(cfg, { markdown, mode, date });
    log.info(`report saved: ${file}`);

    // Archive: incremental writes into SQLite (idempotent on item id, so a rerun or backfill never inflates
    // the chart numbers).
    // A failure must never affect this run — the archive exists for "wanting to look at trends later";
    // it is not a precondition for running.
    try {
      const ar = archiveRun(cfg, {
        date,
        items,
        runId: runState.lastResult?.runId ?? null,
        summary: runState.lastResult ?? {},
        health: results.map((r) => ({ sourceId: r.source?.id, ok: !!r.ok, ms: r.ms ?? null, error: r.error ?? null })),
      });
      runState.archive = ar;
      if (ar?.ok) log.info(`archived: +${ar.inserted} rows (${ar.skipped} duplicates skipped)`);
      else if (ar?.error) log.warn(`archive failed (does not affect the run): ${ar.error}`);
    } catch (e) {
      log.warn(`archive error (does not affect the run): ${e.message}`);
    }

    // Image tagging (only when the user explicitly enables it): runs after the archive and before the
    // report, so that the image tags in this report are the freshest too. A failure must never affect the run.
    try {
      const ready = visionReady(cfg);
      if (ready.ok) {
        const vr = await tagItems(cfg, { items, limit: Number(cfg?.vision?.runLimit ?? 40), log });
        runState.vision = vr;
        if (vr.tagged) log.info(`image tags: +${vr.tagged} (${vr.cached} cache hits)`);
      }
    } catch (e) {
      log.warn(`vision failed (does not affect the run): ${e.message}`);
    }

    const okCount = results.filter((r) => r.ok).length;
    const failedSources = results.filter((r) => !r.ok).map((r) => r.source?.id);
    // Real fetch outcomes are fed back into "automatic egress": this is first-hand evidence of whether
    // things are stable, far more reliable than a few pings — sites that keep failing get moved to
    // another egress automatically.
    try {
      for (const r of results) {
        recordOutcome(cfg, r.source, { ok: !!r.ok, ms: r.ms ?? null, mode: r.egress ?? null });
      }
    } catch {
      // a failure to record does not affect this run
    }
    runState.lastResult = {
      ok: true,
      file,
      mode,
      date,
      sourcesOk: okCount,
      sourcesTotal: results.length,
      failedSources,
      watchTotal: watchResults.length,
      alerts,
      items: items.length,
      provider: a.provider ?? null,
      chars: a.markdown.length,
      task: task?.id ?? null,
      catchUp,
      // Sampling coverage: both the UI and the report have to say honestly "this round only looked at
      // these", otherwise the user misreads "no sample this round" as "that person has gone quiet"
      // (two completely different things)
      sampling: runState.sampling ?? null,
      silence: runState.silence ?? null,
      cost: runState.cost ?? null,
      dormant: runState.dormant ?? null,
    };

    // 7) The self-check goes **last**: fetch everything first, produce the report first, and only then
    //    diagnose only the sources that came back abnormal (the healthy ones are not touched at all).
    //    The diagnostic links go out together with the notification.
    const adviceFiles = [];
    runState.step = 'diagnosing';
    if (cfg?.run?.diagnoseFailed !== false) {
      const bad = results.filter((r) => !r.ok && r.source?.url).map((r) => r.source);
      if (bad.length) {
        log.info(`diagnosing ${bad.length} failed source(s) after the run`);
        for (const s of bad) {
          try {
            const d = await diagnoseSource(s, cfg, log);
            if (d.advice) adviceFiles.push({ id: s.id, url: d.advice.url, file: d.advice.file });
          } catch (err) {
            log.warn(`${s.id}: diagnose failed — ${err.message}`);
          }
        }
      }
    }
    runState.advice = adviceFiles;
    runState.lastResult.advice = adviceFiles;
    runState.step = 'done';

    // 8) Notify: with alerts, report the alerts; otherwise send a summary per the channel policy
    const alertLines = [];
    for (const r of watchResults) {
      for (const e of r.events ?? []) {
        if (e.reasons?.length) alertLines.push(`· ${e.title || e.text || ''}（${e.reasons.join('、')}）`.slice(0, 160));
      }
    }
    const kwHits = items.filter((i) => i.keywords?.length);
    const dueCal = runState.calendarDue ?? [];
    const follow = runState.followMatched ?? [];
    // A watch target's notification level can reach urgent (exempt from quiet hours): if this person is
    // being watched on purpose, their news should not be held back until the morning.
    const followLevel = follow.some((f) => f.level === 'urgent') ? 'urgent' : null;
    const headline =
      silenceAlerts.length && silenceAlerts.some((s) => s.kind === 'silence-group' || s.level === 'high')
        ? `🔇 ${silenceAlerts[0].kind === 'silence-group' ? silenceAlerts[0].agency : silenceAlerts[0].name} 那边安静得反常`
        : follow.length && followLevel
          ? `👤 ${follow[0].name} 等 ${follow.length} 位关注对象有新动态`
          : dueCal.length && dueCal.some((c) => c.days <= 1)
            ? `🎂 ${dueCal[0].days === 0 ? '今天' : dueCal[0].days === 1 ? '明天' : `${dueCal[0].days} 天后`}：${dueCal[0].name}`
            : alerts || kwHits.length
              ? `⚠ 命中 ${alerts + kwHits.length} 条告警`
              : '运行完成';
    const body = [
      `来源 ${okCount}/${results.length}，情报 ${items.length} 条，监视 ${watchResults.length} 个`,
      silenceAlerts.length
        ? `\n【静默检测】\n${silenceAlerts
            .slice(0, 8)
            .map((s) => `· ${s.level === 'high' ? '🔴' : '🟡'} ${s.reason}`)
            .join('\n')}`
        : '',
      follow.length
        ? `\n【关注对象】\n${follow
            .slice(0, 10)
            .map((f) => `· ${f.name} — ${f.count} 条`)
            .join('\n')}`
        : '',
      dueCal.length
        ? `\n【纪念日提醒】\n${dueCal
            .slice(0, 8)
            .map((c) => `· ${c.days === 0 ? '今天' : c.days === 1 ? '明天' : `${c.days} 天后`} ${c.name}${c.turns ? `（第 ${c.turns} 年）` : ''}`)
            .join('\n')}`
        : '',
      alerts ? `\n【监视告警】\n${alertLines.slice(0, 8).join('\n')}` : '',
      kwHits.length ? `\n【关键词命中】\n${kwHits.slice(0, 8).map((i) => `· ${String(i.text || i.title).slice(0, 90)}`).join('\n')}` : '',
      adviceFiles.length ? `\n【诊断文件】\n${adviceFiles.map((a) => `· ${a.id}：${a.url}`).join('\n')}` : '',
      `\n报告：${path.basename(file)}`,
    ]
      .filter(Boolean)
      .join('\n');
    await pushNotify(headline, body, followLevel ?? (dueCal.length || alerts || kwHits.length || silenceAlerts.length ? 'alert' : 'info'));
    // Notifications backlogged during quiet hours: flushed once at the end of every run (a definite point
    // in time, so no race is introduced into the delivery path)
    try {
      const flushed = await flushQueue(cfg, log);
      if (flushed.flushed) log.info(`flushed ${flushed.flushed} queued notification(s)`);
    } catch (e) {
      log.warn(`flush failed: ${e.message}`);
    }

    return { ok: true, file, results, watchResults, items, summary: runState.lastResult };
  } catch (err) {
    runState.lastError = err.message;
    log.error(`run crashed — ${err.message}`);
    await pushNotify('运行异常', err.message, 'error');
    return { ok: false, error: err.message };
  } finally {
    runState.running = false;
    runState.finishedAt = new Date().toISOString();
    if (!['done'].includes(runState.step)) runState.step = runState.lastError ? 'failed' : runState.step;
  }
}
