// egress-test.mjs - how an egress is judged (server/src/egress.js)
//
// The judgement decides which network path a source goes out through, so an error here is not a wrong
// number in a panel: it is every fetch of a site going the slow way, or flapping between two paths.
// These checks pin the parts a person can reason about - the score's terms, the fallbacks, and the
// hysteresis - without touching the network.
import assert from 'node:assert/strict';
import { scoreMode, decide, LOSS_COST, JITTER_COST, SWITCH_MARGIN } from '../server/src/egress.js';

let pass = 0;
let fail = 0;
const t = (name, fn) => {
  try {
    fn();
    pass++;
    process.stdout.write('  [ok]   ' + name + '\n');
  } catch (e) {
    fail++;
    process.stdout.write('  [FAIL] ' + name + '  -- ' + e.message + '\n');
  }
};

const mode = (o) => ({ ok: true, sent: 3, loss: 0, jitter: 0, avg: 100, ...o });

process.stdout.write('\negress: scoring one path\n');

t('a clean path scores its own average', () => {
  const s = scoreMode(mode({}));
  assert.equal(s.usable, true);
  assert.equal(s.effective, 100);
});

t('loss is charged as equivalent latency, exactly as before', () => {
  const s = scoreMode(mode({ loss: 0.25 }));
  assert.equal(s.effective, Math.round(100 * (1 + 0.25 * LOSS_COST)));
  assert.equal(s.effective, 200);
});

t('jitter is charged on top, and less than loss of the same size', () => {
  const jittered = scoreMode(mode({ jitter: 40 }));
  const lossy = scoreMode(mode({ loss: 0.4 }));
  assert.equal(jittered.effective, Math.round(100 + 40 * JITTER_COST));
  assert.ok(jittered.effective > 100, 'a spread must cost something');
  assert.ok(jittered.effective < lossy.effective, `jitter ${jittered.effective} should cost less than the same loss ${lossy.effective}`);
});

t('a path that was never measured jitter scores exactly as it used to', () => {
  // The regression guard: whatever the caller passes, absent jitter must not move the number.
  for (const avg of [10, 120, 380]) {
    for (const loss of [0, 0.2, 0.5]) {
      const withField = scoreMode(mode({ avg, loss, jitter: 0 }));
      const withoutField = scoreMode({ ok: true, sent: 3, avg, loss });
      assert.equal(withField.effective, Math.round(avg * (1 + loss * LOSS_COST)));
      assert.equal(withoutField.effective, withField.effective, 'absent jitter must equal zero jitter');
    }
  }
});

t('an unreachable or unmeasured path is not usable and says why', () => {
  const failed = scoreMode({ ok: false, sent: 3, error: 'timeout' });
  assert.equal(failed.usable, false);
  assert.equal(failed.effective, Infinity);
  assert.equal(failed.why, 'timeout');
  const skipped = scoreMode({ skipped: true });
  assert.equal(skipped.usable, false);
  assert.ok(skipped.why);
  assert.equal(scoreMode(undefined).usable, false);
});

process.stdout.write('\negress: choosing between paths\n');

t('with nothing reachable it falls back rather than guessing', () => {
  const d = decide({ probe: { modes: { direct: { ok: false, error: 'timeout' }, proxy: { skipped: true } } }, fallback: 'direct' });
  assert.equal(d.mode, 'direct');
  assert.equal(d.confidence, 'none');
});

t('a single usable path is taken, and the reason names it', () => {
  const d = decide({ probe: { modes: { direct: { ok: false, error: 'timeout' }, proxy: mode({ avg: 150 }) } }, fallback: 'direct' });
  assert.equal(d.mode, 'proxy');
  assert.equal(d.confidence, 'high');
  assert.match(d.reason, /proxy/);
});

t('the cheaper path wins when the difference is real', () => {
  const d = decide({ probe: { modes: { direct: mode({ avg: 400 }), proxy: mode({ avg: 120 }) } }, fallback: 'direct' });
  assert.equal(d.mode, 'proxy');
});

t('a noisy path loses to a steady one at the same average', () => {
  const d = decide({ probe: { modes: { direct: mode({ avg: 200, jitter: 0 }), proxy: mode({ avg: 200, jitter: 90 }) } }, fallback: 'direct' });
  assert.equal(d.mode, 'direct', 'the steady path should win');
});

t('hysteresis: a barely cheaper challenger does not take over', () => {
  const cheap = Math.round(200 * (1 - SWITCH_MARGIN / 2));
  const d = decide({
    probe: { modes: { direct: mode({ avg: 200 }), proxy: mode({ avg: cheap }) } },
    current: 'direct',
    fallback: 'direct',
  });
  assert.equal(d.mode, 'direct');
  assert.equal(d.changed, false);
  assert.match(d.reason, /不切换/);
});

t('hysteresis: a clearly cheaper challenger does', () => {
  const d = decide({
    probe: { modes: { direct: mode({ avg: 400 }), proxy: mode({ avg: 100 }) } },
    current: 'direct',
    fallback: 'direct',
  });
  assert.equal(d.mode, 'proxy');
  assert.equal(d.changed, true);
});

t('the outcome history can outvote a fast path that keeps failing', () => {
  // The stability signal from real fetches: 100ms but failing half the time is not better than a steady
  // 150ms, and the penalty is what expresses that.
  const failing = { modes: { direct: mode({ avg: 100 }), proxy: mode({ avg: 150 }) } };
  const d = decide({
    probe: failing,
    history: { direct: Array.from({ length: 10 }, (_, i) => ({ ok: i % 2 === 0 })) },
    fallback: 'direct',
  });
  assert.equal(d.mode, 'proxy', `history should have moved the choice, reason was: ${d.reason}`);
});

fsCheck();
function fsCheck() {
  // LOSS_COST and JITTER_COST are exported so this file can name them; a silent change of either would
  // otherwise only show up as a different egress in production.
  assert.equal(LOSS_COST, 4);
  assert.equal(JITTER_COST, 0.5);
  assert.ok(SWITCH_MARGIN > 0 && SWITCH_MARGIN < 1);
}

process.stdout.write(`\n${pass}/${pass + fail} checks passed\n`);
if (fail) {
  process.stdout.write('  ' + fail + ' FAILED\n');
  process.exit(1);
}
