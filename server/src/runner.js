// runner.js — 一次完整运行的编排 / orchestrates one full run
// 流程：前置检查 → 抓取选中来源 → 检查监视对象 → 落 feeds/情报条目
//      → LLM 分析（带上监视告警）→ 落报告
import { effectiveSources } from './sources.js';
import { fetchAll } from './fetchers/index.js';
import { analyze, preflight } from './analyze.js';
import { collectItems, matchedKeywords } from './items.js';
import { checkAll } from './watch.js';
import { ensureDirs, runLogPath, saveFeedFiles, saveItems, saveReport } from './reports.js';
import { createLogger } from './logger.js';
import { applyProxy } from './net.js';

/** 供 UI 轮询的实时状态 / in-memory state the UI can poll */
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
  itemCount: 0,
  alerts: 0,
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
 * @param {{cfg:object, mode?:'daily'|'merch'|'watch'}} args
 */
export async function runOnce({ cfg, mode = 'daily' }) {
  if (runState.running) return { ok: false, error: '已有一个运行在进行中 / a run is already in progress' };

  ensureDirs(cfg);
  const log = createLogger(runLogPath(cfg, mode));
  const origInfo = log.info;
  const origWarn = log.warn;
  const origErr = log.error;
  log.info = (m) => (push(`[INFO] ${m}`), origInfo(m));
  log.warn = (m) => (push(`[WARN] ${m}`), origWarn(m));
  log.error = (m) => (push(`[ERR ] ${m}`), origErr(m));

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
    itemCount: 0,
    alerts: 0,
    lastError: null,
    tail: [],
  });

  try {
    // 0) 应用代理配置（Node 的 fetch 默认不读系统代理，必须显式设置）
    runState.step = 'proxy';
    const px = await applyProxy(cfg);
    log.info(`代理 / proxy: ${px.applied ?? '（直连 / direct）'}`);

    // 1) 前置检查：LLM 连通性/余额（避免白跑一场）
    runState.step = 'preflight';
    log.info('前置检查 / preflight: LLM 连通性');
    const pre = await preflight(cfg);
    if (!pre.ok) {
      log.error(`前置检查失败 / preflight failed — ${pre.error}`);
      runState.lastError = `LLM 前置检查失败：${pre.error}`;
      return { ok: false, error: runState.lastError };
    }
    log.info(`LLM 就绪 / ready: ${pre.provider?.name ?? '?'} · ${pre.provider?.model ?? '?'}`);

    // 2) 抓取
    runState.step = 'fetching';
    const sources = mode === 'watch' ? [] : selectSources(cfg, mode);
    runState.sourcesTotal = sources.length;
    log.info(`抓取 ${sources.length} 条来源 / fetching ${sources.length} sources`);
    const results = await fetchAll(sources, { cfg, log });
    runState.sourcesDone = results.length;

    // 3) 监视对象
    let watchResults = [];
    if (cfg?.watch?.enabled !== false && (cfg?.run?.watchWithRun !== false || mode === 'watch')) {
      const targets = (cfg.watch?.targets ?? []).filter((t) => t.enabled !== false);
      runState.watchTotal = targets.length;
      runState.step = 'watching';
      if (targets.length) log.info(`检查 ${targets.length} 个监视对象 / checking ${targets.length} watch targets`);
      watchResults = await checkAll(cfg, log);
      runState.watchDone = watchResults.length;
    }

    // 4) 情报条目（网页卡片流与报告都用它）
    runState.step = 'saving-feeds';
    const date = new Date().toISOString().slice(0, 10);
    const items = collectItems(results, cfg?.ui?.intelPerSource ?? 24);
    const keywords = cfg?.watch?.rules?.keywords ?? [];
    for (const it of items) {
      const hit = matchedKeywords(it, keywords);
      if (hit.length) it.keywords = hit;
      if (it.extra?.user && keywords.length) {
        const h2 = matchedKeywords({ text: it.text }, keywords);
        if (h2.length) it.keywords = [...new Set([...(it.keywords ?? []), ...h2])];
      }
    }
    const alerts = watchResults.reduce((n, r) => n + (r.events ?? []).filter((e) => e.reasons?.length).length, 0);
    runState.itemCount = items.length;
    runState.alerts = alerts;

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
    log.info(`feeds 已落盘 / feeds saved: ${saved.index.filter((i) => i.ok).length}/${saved.index.length}；情报条目 ${items.length} 条`);

    // 5) 分析
    runState.step = 'analyzing';
    log.info('LLM 分析中 / analyzing…');
    const a = await analyze({ cfg, results, watchResults, mode, log });
    if (!a.ok) {
      runState.lastError = a.error;
      return { ok: false, error: a.error, results };
    }

    // 6) 落报告
    runState.step = 'saving-report';
    const file = saveReport(cfg, { markdown: a.markdown, mode, date });
    log.info(`报告已保存 / report saved: ${file}`);

    const okCount = results.filter((r) => r.ok).length;
    runState.lastResult = {
      ok: true,
      file,
      mode,
      date,
      sourcesOk: okCount,
      sourcesTotal: results.length,
      watchTotal: watchResults.length,
      alerts,
      items: items.length,
      provider: a.provider ?? null,
      chars: a.markdown.length,
    };
    runState.step = 'done';
    return { ok: true, file, results, watchResults, items, summary: runState.lastResult };
  } catch (err) {
    runState.lastError = err.message;
    log.error(`运行异常 / run crashed — ${err.message}`);
    return { ok: false, error: err.message };
  } finally {
    runState.running = false;
    runState.finishedAt = new Date().toISOString();
    if (!['done'].includes(runState.step)) runState.step = runState.lastError ? 'failed' : runState.step;
  }
}
