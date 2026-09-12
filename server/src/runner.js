// runner.js — 一次完整运行的编排 / orchestrates one full run
// 流程：前置检查 → 抓取选中来源 → 检查监视对象 → 落 feeds/情报条目
//      → LLM 分析（带上监视告警）→ 落报告
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
import { archiveRun } from './archive.js';
import { tagItems, visionReady } from './vision.js';
import { diagnoseSource } from './diagnose.js';
import { recordOutcome } from './egress.js';
import { upcoming } from './calendar.js';

/** 日报里的纪念日区块（没有就把整块省掉，不留空标题） */
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
  if (task) log.info(`计划任务「${task.name}」${catchUp ? '（补跑 / catch-up）' : ''} 开始`);

  /** 统一收口一条推送 / one place for outbound alerts */
  const pushNotify = async (title, body, level) => {
    try {
      const r = await notify(cfg, log, { title, body, level });
      if (r.sent) log.info(`已推送 ${r.sent} 个通道 / delivered to ${r.sent} channel(s)`);
    } catch (err) {
      log.warn(`推送失败 / notify failed — ${err.message}`);
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
    itemCount: 0,
    alerts: 0,
    features: null,
    live: null,
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
      await pushNotify(`${mode === 'merch' ? '通贩扫描' : '情报收集'}失败`, `LLM 前置检查未通过：${pre.error}`, 'error');
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

    // 3.5) 开播监测 —— 最有时效性的情报：开播比任何关键词都值得立刻知道
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
        log.warn(`开播检查跳过 / live check skipped — ${err.message}`);
        runState.live = { live: 0, round: 0, wentLive: [], error: err.message };
      }
    }

    // 4) 情报条目（网页卡片流与报告都用它）
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
    const alerts = watchResults.reduce((n, r) => n + (r.events ?? []).filter((e) => e.reasons?.length).length, 0);
    runState.itemCount = items.length;
    runState.alerts = alerts;

    // 4.5) 用 LLM 抽结构化特征 —— 让「只记得特征」也能检索到。
    //      有缓存、有上限，失败不影响主流程。
    let enriched = items;
    if (cfg?.run?.extractFeatures !== false && items.length) {
      runState.step = 'features';
      try {
        const { extractFeatures, applyFeatures } = await import('./features.js');
        const r = await extractFeatures(cfg, items, log);
        enriched = applyFeatures(items, r.cache);
        runState.features = { extracted: r.extracted, cached: r.skipped, error: r.error ?? null };
      } catch (err) {
        log.warn(`特征抽取跳过 / features skipped — ${err.message}`);
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
    log.info(`feeds 已落盘 / feeds saved: ${saved.index.filter((i) => i.ok).length}/${saved.index.length}；情报条目 ${items.length} 条`);

    // 5) 分析
    runState.step = 'analyzing';
    log.info('LLM 分析中 / analyzing…');
    const a = await analyze({ cfg, results, watchResults, mode, log });
    if (!a.ok) {
      runState.lastError = a.error;
      await pushNotify(`${mode === 'merch' ? '通贩扫描' : '情报收集'}分析失败`, a.error, 'error');
      return { ok: false, error: a.error, results };
    }

    // 6) 落报告
    runState.step = 'saving-report';
    // 纪念日倒计时直接写进日报：这东西的价值就在于「你翻报告时正好看见」，
    // 而不是要专门去点一个页面。放在报告最前面 —— 倒计时越近越该先看到。
    let markdown = a.markdown;
    let calendarBlock = '';
    try {
      const cal = upcoming(cfg, { days: Number(cfg?.calendar?.reportDays ?? 30) });
      calendarBlock = calendarSection(cal);
      if (calendarBlock) markdown = calendarBlock + '\n\n' + markdown;
      if (cal.reminders.length) {
        runState.calendarDue = cal.reminders;
      }
    } catch (e) {
      log.warn(`纪念日计算失败（不影响报告）/ calendar failed: ${e.message}`);
    }

    // 按「人」关注：把命中关注对象的条目单独成块。使用者心里盯的是人，
    // 所以「这 20 个人今天有什么动静」要比「33 个来源抓到了什么」有用得多。
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
      log.warn(`关注对象匹配失败（不影响报告）/ people match failed: ${e.message}`);
    }

    // 多源同事件合并：同一件事被几个来源各报一遍时，报告里只留一条，
    // 并标出「几个来源确认」—— 这既省地方，也是可信度的直接证据。
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
      log.warn(`事件合并失败（不影响报告）/ clustering failed: ${e.message}`);
    }

    const file = saveReport(cfg, { markdown, mode, date });
    log.info(`报告已保存 / report saved: ${file}`);

    // 归档：增量写入 SQLite（按条目 id 幂等，重跑/补跑不会让图表数字变大）。
    // 失败绝不影响本次运行 —— 归档是「后来想看趋势」用的，不是运行的必要条件。
    try {
      const ar = archiveRun(cfg, {
        date,
        items,
        runId: runState.lastResult?.runId ?? null,
        summary: runState.lastResult ?? {},
        health: results.map((r) => ({ sourceId: r.source?.id, ok: !!r.ok, ms: r.ms ?? null, error: r.error ?? null })),
      });
      runState.archive = ar;
      if (ar?.ok) log.info(`归档 / archived: +${ar.inserted} 条（跳过重复 ${ar.skipped}）`);
      else if (ar?.error) log.warn(`归档失败（不影响运行）/ archive failed: ${ar.error}`);
    } catch (e) {
      log.warn(`归档异常（不影响运行）/ archive error: ${e.message}`);
    }

    // 图片打标（只在使用者明确启用时）：跑在归档之后、报告之前，
    // 这样本次报告里的图片标签也是最新的。失败绝不影响运行。
    try {
      const ready = visionReady(cfg);
      if (ready.ok) {
        const vr = await tagItems(cfg, { items, limit: Number(cfg?.vision?.runLimit ?? 40), log });
        runState.vision = vr;
        if (vr.tagged) log.info(`图片打标 / image tags: +${vr.tagged}（缓存命中 ${vr.cached}）`);
      }
    } catch (e) {
      log.warn(`图片打标失败（不影响运行）/ vision failed: ${e.message}`);
    }

    const okCount = results.filter((r) => r.ok).length;
    const failedSources = results.filter((r) => !r.ok).map((r) => r.source?.id);
    // 真实抓取结果反馈给「自动出口」：这是判断稳不稳的第一手证据，
    // 比几次 ping 可靠得多 —— 连续失败的站点会被自动换出口。
    try {
      for (const r of results) {
        recordOutcome(cfg, r.source, { ok: !!r.ok, ms: r.ms ?? null, mode: r.egress ?? null });
      }
    } catch {
      // 记录失败不影响本次运行
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
    };

    // 7) 自检放在**最后**：先抓完、先出报告，最后才只对出异常的来源做诊断
    //    （连通正常的完全不打扰）。诊断链接会随推送一起发出去。
    const adviceFiles = [];
    runState.step = 'diagnosing';
    if (cfg?.run?.diagnoseFailed !== false) {
      const bad = results.filter((r) => !r.ok && r.source?.url).map((r) => r.source);
      if (bad.length) {
        log.info(`运行结束后自检 ${bad.length} 个异常来源 / diagnosing ${bad.length} failed source(s)`);
        for (const s of bad) {
          try {
            const d = await diagnoseSource(s, cfg, log);
            if (d.advice) adviceFiles.push({ id: s.id, url: d.advice.url, file: d.advice.file });
          } catch (err) {
            log.warn(`${s.id}: 自检失败 / diagnose failed — ${err.message}`);
          }
        }
      }
    }
    runState.advice = adviceFiles;
    runState.lastResult.advice = adviceFiles;
    runState.step = 'done';

    // 8) 推送：有告警就报告警，否则按通道策略报摘要
    const alertLines = [];
    for (const r of watchResults) {
      for (const e of r.events ?? []) {
        if (e.reasons?.length) alertLines.push(`· ${e.title || e.text || ''}（${e.reasons.join('、')}）`.slice(0, 160));
      }
    }
    const kwHits = items.filter((i) => i.keywords?.length);
    const dueCal = runState.calendarDue ?? [];
    const follow = runState.followMatched ?? [];
    // 关注对象的通知级别可以到 urgent（豁免静默时段）：既然专门盯这个人，
    // 他的消息就不该被压到早上。
    const followLevel = follow.some((f) => f.level === 'urgent') ? 'urgent' : null;
    const headline =
      follow.length && followLevel
        ? `👤 ${follow[0].name} 等 ${follow.length} 位关注对象有新动态`
        : dueCal.length && dueCal.some((c) => c.days <= 1)
          ? `🎂 ${dueCal[0].days === 0 ? '今天' : dueCal[0].days === 1 ? '明天' : `${dueCal[0].days} 天后`}：${dueCal[0].name}`
          : alerts || kwHits.length
            ? `⚠ 命中 ${alerts + kwHits.length} 条告警`
            : '运行完成';
    const body = [
      `来源 ${okCount}/${results.length}，情报 ${items.length} 条，监视 ${watchResults.length} 个`,
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
    await pushNotify(headline, body, followLevel ?? (dueCal.length || alerts || kwHits.length ? 'alert' : 'info'));
    // 静默时段积压的通知：每次运行结束补发一次（明确的时间点，不在投递路径里做竞态）
    try {
      const flushed = await flushQueue(cfg, log);
      if (flushed.flushed) log.info(`补发积压通知 / flushed ${flushed.flushed} queued notification(s)`);
    } catch (e) {
      log.warn(`补发队列失败 / flush failed: ${e.message}`);
    }

    return { ok: true, file, results, watchResults, items, summary: runState.lastResult };
  } catch (err) {
    runState.lastError = err.message;
    log.error(`运行异常 / run crashed — ${err.message}`);
    await pushNotify('运行异常', err.message, 'error');
    return { ok: false, error: err.message };
  } finally {
    runState.running = false;
    runState.finishedAt = new Date().toISOString();
    if (!['done'].includes(runState.step)) runState.step = runState.lastError ? 'failed' : runState.step;
  }
}
