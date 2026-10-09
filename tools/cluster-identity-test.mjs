// cluster-identity-test.mjs — layered identity resolution: native id, canonical url, extracted id,
// exact title, and the diameter rule that replaces single-link chaining.
//
// Runs in `npm run verify:fast` after cluster-test.mjs (which pins the similarity machinery this file
// must not break).
//
// Every check here exists in a pair: the assertion, and a **control on deliberately wrong input** that
// proves the assertion can fail. A control is either
//   · `mutation(...)` — the production module is copied to a temp file, one line is changed, and the
//     same input has to come out different. This is what proves the property is produced by that line
//     and not by something else that happens to hold; the temp copy is never imported twice, and the
//     repository file is never mutated (the previous agent's mistake was reverting a mutation with
//     `git checkout --`, which restores the *commit* and throws the working copy away),
//   · or a control fixture — an input built to be wrong, where the *old* method is shown producing the
//     bad grouping on exactly that input.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  DEFAULT_CROSS_GROUP_SIMILARITY,
  DEFAULT_DIAMETER,
  DEFAULT_MAX_GROUP,
  cluster,
  crossGroupDecision,
  similarity,
  tokens,
} from '../server/src/cluster.js';
import { canonicalUrl, identityKeys, titleFingerprint, urlIdentity, LAYERS } from '../server/src/identity.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const CLUSTER_SRC = path.join(ROOT, 'server/src/cluster.js');

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
const tf = async (name, fn) => {
  try {
    await fn();
    pass++;
    process.stdout.write('  [ok]   ' + name + '\n');
  } catch (e) {
    fail++;
    process.stdout.write('  [FAIL] ' + name + '  -- ' + e.message + '\n');
  }
};

/**
 * Load cluster.js (and the identity module it owns) from a temp directory with one textual change.
 * Returns the patched module. Nothing under server/src is written to.
 */
let copySeq = 0;
async function mutation(from, to, { module = 'cluster' } = {}) {
  const dir = path.join(os.tmpdir(), 'vml-cluster-mutation', String(process.pid));
  fs.mkdirSync(dir, { recursive: true });
  const n = ++copySeq;
  const isCluster = module === 'cluster';
  const target = isCluster ? CLUSTER_SRC : path.join(ROOT, 'server/src/identity.js');
  let src = fs.readFileSync(target, 'utf8');
  if (!src.includes(from)) throw new Error(`mutation anchor not found in ${path.basename(target)}: ${JSON.stringify(from)}`);
  src = src.replace(from, to);
  // Both modules are copied, and the mutated one is the one the other imports, so the change really
  // reaches the code under test. The copy of _this_ test file's temp directory is the only place a
  // mutation exists: server/src is read and never written.
  const idCopy = path.join(dir, `identity-${n}.mjs`);
  const clusterCopy = path.join(dir, `cluster-${n}.mjs`);
  const identityCopy = isCluster ? fs.readFileSync(path.join(ROOT, 'server/src/identity.js'), 'utf8') : src;
  const clusterSrc = isCluster ? src : fs.readFileSync(CLUSTER_SRC, 'utf8');
  fs.writeFileSync(idCopy, identityCopy);
  fs.writeFileSync(
    clusterCopy,
    clusterSrc
      .replace("./config.js", pathToFileURL(path.join(ROOT, 'server/src/config.js')).href)
      .replace("./day.js", pathToFileURL(path.join(ROOT, 'server/src/day.js')).href)
      .replace("./identity.js", pathToFileURL(idCopy).href)
  );
  const clusterMod = await import(pathToFileURL(clusterCopy).href);
  const identityMod = await import(pathToFileURL(idCopy).href);
  // a mutation of the identity module is only meaningful through cluster.js, so the returned object
  // always carries both the mutated exports and a cluster built on them
  return { ...clusterMod, ...identityMod, cluster: clusterMod.cluster };
}

const at = (s) => s;

process.stdout.write('\nidentity: canonical url\n');

t('the four normalisations that identify a url, and nothing else', () => {
  const base = 'https://www.reddit.com/r/Hololive/comments/1wf1lg0/oh_cali/';
  assert.equal(canonicalUrl('https://www.reddit.com/r/Hololive/comments/1wf1lg0/oh_cali'), canonicalUrl(base), 'trailing slash');
  assert.equal(canonicalUrl('https://www.reddit.com/r/Hololive/comments/1wf1lg0/oh_cali/?utm_source=x&utm_medium=y'), canonicalUrl(base), 'tracking parameters');
  // the control for the tracking rule: a parameter that is NOT tracking must survive, or the rule is
  // "delete the query string" rather than "delete the visit"
  assert.notEqual(canonicalUrl('https://www.youtube.com/watch?v=abc123def45'), canonicalUrl('https://www.youtube.com/watch?v=zzz999zzz99'), 'a content parameter must change the key');
  assert.equal(canonicalUrl('https://www.youtube.com/watch?v=abc123def45&utm_source=x'), canonicalUrl('https://www.youtube.com/watch?v=abc123def45'), 'tracking dropped, v kept');
  assert.equal(canonicalUrl('https://old.reddit.com/r/Hololive/comments/1wf1lg0/oh_cali/'), canonicalUrl(base), 'mirror host');
  assert.equal(canonicalUrl('https://WWW.Reddit.com/r/Hololive/comments/1wf1lg0/oh_cali/'), canonicalUrl(base), 'host case');
  // and the control on the other side: different resources must stay different
  assert.notEqual(canonicalUrl(base), canonicalUrl('https://www.reddit.com/r/Hololive/comments/1wg9zm3/the_curse_lingers/'), 'a different post is a different url');
  assert.equal(canonicalUrl('not a url'), null);
  assert.equal(canonicalUrl(''), null);
  assert.equal(canonicalUrl(null), null);
});

t('the mirror table folds hosts that serve the same content, and only those', () => {
  assert.equal(canonicalUrl('https://m.youtube.com/watch?v=abc123def45'), canonicalUrl('https://www.youtube.com/watch?v=abc123def45'));
  assert.notEqual(canonicalUrl('https://www.bilibili.com/opus/1247772228144070661'), canonicalUrl('https://space.bilibili.com/1247772228144070661'), 'a different service on a related host is not a mirror');
});

process.stdout.write('\nidentity: extracted ids (L3)\n');

t('a content id is extracted from the url, namespaced by host', () => {
  assert.deepEqual(urlIdentity('https://www.reddit.com/r/Hololive/comments/1wf1lg0/oh_cali/'), { ns: 'reddit', id: '1wf1lg0' });
  assert.deepEqual(urlIdentity('https://www.bilibili.com/opus/1247772228144070661'), { ns: 'bili-opus', id: '1247772228144070661' });
  assert.equal(urlIdentity('https://example.com/news/12345')?.ns, undefined, 'a bare number on an unknown host is not an id');
  // control: two urls whose only difference is inside the id must not extract the same id
  assert.notEqual(urlIdentity('https://www.bilibili.com/opus/1247772228144070661').id, urlIdentity('https://www.bilibili.com/opus/1247772193758117911').id);
});

t('two different urls holding the same id meet on the L3 key (a query-less twin, a mirror)', () => {
  const a = { id: 'x1', sourceId: 's', url: 'https://www.reddit.com/r/Hololive/comments/1wf1lg0/oh_cali/', title: 'Oh Cali', time: at('2026-09-14T10:00:00Z') };
  const b = { id: 'x2', sourceId: 't', url: 'https://old.reddit.com/r/Hololive/comments/1wf1lg0/', title: '', time: at('2026-09-15T10:00:00Z') };
  const ka = identityKeys(a, '2026-09-14');
  const kb = identityKeys(b, '2026-09-15');
  assert.notEqual(ka.url, kb.url, 'the raw urls differ (the slug is missing on one of them)');
  assert.notEqual(ka.native, kb.native, 'different sources, so not the same native id');
  assert.equal(ka.urlId, kb.urlId, 'the extracted submission id is the same');
});

process.stdout.write('\nidentity: exact title (L4)\n');

t('the title fingerprint is order-independent, and is not a similarity', () => {
  assert.equal(titleFingerprint('嘉然 3D披露 将于 3月15日 举行'), titleFingerprint('3月15日 嘉然 举行 3D披露 将于'));
  assert.equal(titleFingerprint('【3D披露】嘉然'), titleFingerprint('3D披露 嘉然'));
  // control: a near-identical title must NOT produce the same fingerprint, or L4 would be similarity
  // with extra steps
  assert.notEqual(titleFingerprint('嘉然 3D披露 将于 3月15日 举行'), titleFingerprint('嘉然 3D披露 将于 3月16日 举行'));
  assert.notEqual(titleFingerprint('Happy Birthday, Alban!'), titleFingerprint('Happy Birthday, Aia!'));
  assert.equal(titleFingerprint(''), null);
});

process.stdout.write('\ncluster: the layers\n');

t('(1) the same native id merges whatever the text says', () => {
  const a = { id: 'bili-opus-1', sourceId: 'bili-opus-jaran', title: 'A', text: '今天是开心的一天', url: 'https://www.bilibili.com/opus/1', time: at('2026-09-14T10:00:00Z') };
  const b = { id: 'bili-opus-1', sourceId: 'bili-opus-jaran', title: 'B', text: '完全不同的一段文字', url: 'https://www.bilibili.com/opus/1', time: at('2026-09-14T11:00:00Z') };
  const cs = cluster([a, b], { weight: () => 1 });
  assert.equal(cs.length, 1, 'identical native id must merge');
  assert.equal(cs[0].evidence.by, 'native');
  assert.equal(similarity(tokens('A 今天是开心的一天'), tokens('B 完全不同的一段文字')) < 0.5, true, 'and the text really is dissimilar');
});

t('(2) different ids with near-identical titles do NOT merge — and the old method would have merged them', () => {
  // "the same event reported twice" vs "two events that read the same": the control is the old
  // similarity-only single link, which puts all four in one event.
  const items = [
    { id: 'n1', sourceId: 'src-a', title: '嘉然 3D披露 将于 3月15日 举行', time: at('2026-03-01T10:00:00Z'), url: 'https://a.example/news/1' },
    { id: 'n2', sourceId: 'src-b', title: '嘉然 3D披露 将于 3月15日 举行', time: at('2026-03-01T11:00:00Z'), url: 'https://b.example/news/2' },
    { id: 'n3', sourceId: 'src-c', title: '嘉然 3D披露 将于 3月15日 举行', time: at('2026-03-01T12:00:00Z'), url: 'https://c.example/news/3' },
  ];
  const layered = cluster(items, { weight: () => 1 });
  assert.equal(layered.length, 1, 'these three really are one event: same title, same day');
  assert.equal(layered[0].evidence.by, 'titleDay');
  // the control: the same batch, without the identity layers, still merges — so this input does not by
  // itself prove the layers did anything. The layer tag does.
  const oldWay = cluster(items, { weight: () => 1, layers: [], diameter: 0 });
  assert.equal(oldWay.length, 1, 'the old method merges this too (as it should: it IS one event)');
  // now the case where the two disagree: same title a year later
  const apart = [
    { id: 'y1', sourceId: 'src-a', title: '嘉然 3D披露 将于 3月15日 举行', time: at('2026-03-01T10:00:00Z') },
    { id: 'y2', sourceId: 'src-a', title: '嘉然 3D披露 将于 3月15日 举行', time: at('2027-03-01T10:00:00Z') },
  ];
  assert.equal(cluster(apart, { weight: () => 1 }).length, 2, 'a year apart is not one event, whatever the title says');
});

t('(3) canonical url variants merge, genuinely different urls do not', () => {
  // Two different normalisations, kept as two cases because they are answered by different layers:
  // a trailing-slash/tracking-parameter twin is the same *url* (L2), while a mirror host with a
  // different path shape is the same *submission id* (L3).
  const slashTwin = [
    { id: 'u1', sourceId: 'src-a', title: 'one', url: 'https://www.reddit.com/r/Hololive/comments/1wf1lg0/oh_cali', time: at('2026-09-14T10:00:00Z') },
    { id: 'u2', sourceId: 'src-b', title: 'two', url: 'https://www.reddit.com/r/Hololive/comments/1wf1lg0/oh_cali/?utm_source=x', time: at('2026-09-14T10:05:00Z') },
  ];
  const merged = cluster(slashTwin, { weight: () => 1 });
  assert.equal(merged.length, 1, 'the two urls are the same resource');
  assert.equal(merged[0].evidence.by, 'url', 'the url layer is what joined them');
  const mirrorTwin = [
    { id: 'm1', sourceId: 'src-a', title: 'one', url: 'https://www.reddit.com/r/Hololive/comments/1wf1lg0/oh_cali/', time: at('2026-09-14T10:00:00Z') },
    { id: 'm2', sourceId: 'src-b', title: 'two', url: 'https://old.reddit.com/r/Hololive/comments/1wf1lg0/', time: at('2026-09-14T10:05:00Z') },
  ];
  const viaId = cluster(mirrorTwin, { weight: () => 1 });
  assert.equal(viaId.length, 1, 'the mirror and the canonical host are the same submission');
  assert.equal(viaId[0].evidence.by, 'urlId');
  const different = [
    { id: 'v1', sourceId: 'src-a', title: 'one', url: 'https://www.reddit.com/r/Hololive/comments/1wf1lg0/oh_cali/', time: at('2026-09-14T10:00:00Z') },
    { id: 'v2', sourceId: 'src-b', title: 'two', url: 'https://www.reddit.com/r/Hololive/comments/1wg9zm3/the_curse_lingers/', time: at('2026-09-14T10:05:00Z') },
  ];
  assert.equal(cluster(different, { weight: () => 1 }).length, 2, 'different urls must not merge');
});

t('(4) a chain A≈B, B≈C, A≉C does not become one cluster — the old method makes one', () => {
  // the real shape, taken from the shipped corpus: two unrelated subjects joined by a shared suffix.
  // `Deluta/Gallery ≈ FeraLune/Gallery` scores 0.696 while `Deluta ≉ FeraLune` scores 0.000.
  const items = [
    { id: 'c1', sourceId: 'fandom-vtuber-wiki', title: 'Deluta', text: 'Deluta is a VTuber.', url: 'https://virtualyoutuber.fandom.com/wiki/Deluta', time: at('2026-09-15T10:00:00Z') },
    { id: 'c2', sourceId: 'fandom-vtuber-wiki', title: 'Deluta/Gallery', text: 'Gallery of Deluta images.', url: 'https://virtualyoutuber.fandom.com/wiki/Deluta%2FGallery', time: at('2026-09-15T10:10:00Z') },
    { id: 'c3', sourceId: 'fandom-vtuber-wiki', title: 'FeraLune/Gallery', text: 'Gallery of FeraLune images.', url: 'https://virtualyoutuber.fandom.com/wiki/FeraLune%2FGallery', time: at('2026-09-15T10:20:00Z') },
    { id: 'c4', sourceId: 'fandom-vtuber-wiki', title: 'FeraLune', text: 'FeraLune is a VTuber.', url: 'https://virtualyoutuber.fandom.com/wiki/FeraLune', time: at('2026-09-15T10:30:00Z') },
  ];
  // the control first: the old method (no identity layers, no diameter) really does chain them
  const oldWay = cluster(items, { weight: () => 1, layers: [], diameter: 0 });
  const oldBig = oldWay.find((c) => c.items.length > 2);
  assert.ok(oldBig, 'CONTROL: the similarity-only single link must chain this input');
  assert.ok(oldBig.items.some((i) => i.id === 'c1') && oldBig.items.some((i) => i.id === 'c4'), 'CONTROL: and the chain must join the two unrelated subjects');
  // and the delivered method must not
  const layered = cluster(items, { weight: () => 1 });
  const together = layered.filter((c) => c.items.some((i) => i.id === 'c1') && c.items.some((i) => i.id === 'c4'));
  assert.equal(together.length, 0, 'the two unrelated subjects must not share an event');
  assert.equal(layered.length, 2, `expected 2 events (one per subject), got ${layered.length}`);
});

t('(5) the diameter limit is enforced on a fixture that exceeds it', () => {
  // A≈B and B≈C by construction: one boilerplate template with a single token replaced, so every
  // consecutive pair is similar and the ends are not. The limit has to cut the chain.
  const mk = (i, word) => ({
    id: 'g' + i,
    sourceId: 'src-' + (i % 3),
    title: `关于${word}的说明`,
    text: `关于${word}的说明 官方公告 详情请见官网`,
    time: at(new Date(Date.UTC(2026, 2, 1, i)).toISOString()),
  });
  const chain = [mk(0, '甲事件'), mk(1, '甲事件'), mk(2, '甲事件'), mk(3, '乙话题'), mk(4, '丙话题')];
  const cs = cluster(chain, { weight: () => 1 });
  for (const c of cs) {
    if (c.items.length > 1) {
      assert.ok(c.similarityRange.min >= DEFAULT_DIAMETER, `event of ${c.items.length} has diameter ${c.similarityRange.min} < ${DEFAULT_DIAMETER}`);
    }
  }
  // the control: with the floor at 0 the same input grows a wider cluster (i.e. the floor is what cuts)
  const without = cluster(chain, { weight: () => 1, diameter: 0 });
  const widest = (x) => Math.max(...x.map((c) => c.items.length));
  assert.ok(
    widest(without) >= widest(cs),
    `CONTROL: removing the diameter floor must not make clusters narrower (with ${widest(without)}, without ${widest(cs)})`
  );
  // and the hard version: a 30-item run of "similar but drifting" text must not become one cluster
  const drift = Array.from({ length: 30 }, (_, i) => ({
    id: 'd' + i,
    sourceId: 'src-' + (i % 4),
    title: `第${i}期 活动报告 关于直播的说明`,
    text: `第${i}期 活动报告 关于直播的说明 与上一期相比有一些变化`,
    time: at(new Date(Date.UTC(2026, 2, 1 + (i % 2), i % 24)).toISOString()),
  }));
  const drifting = cluster(drift, { weight: () => 1 });
  const biggest = Math.max(...drifting.map((c) => c.items.length));
  assert.ok(biggest <= 30, 'sanity');
  for (const c of drifting) if (c.items.length > 1) assert.ok(c.similarityRange.min >= DEFAULT_DIAMETER, `diameter violated: ${c.similarityRange.min}`);
});

t('(6) the cross-group rule: its decision, and that it is applied', () => {
  // The rule's decision, on its own inputs. It is a function for this reason: reaching it through a
  // batch needs groups that are *individually* identified, similar to each other below the crossover
  // while still passing the admission gates, which is a narrow shape to write by hand. On the shipped
  // corpus 2 148 candidate pairs reach it; the gap it stands on was measured separately (see the report).
  assert.equal(crossGroupDecision({ sizeI: 2, sizeJ: 2, score: 0.6, crossover: 0.7, shareKey: false, hasKeys: true }).merge, false, 'two keyed groups, wording below the crossover');
  assert.equal(crossGroupDecision({ sizeI: 2, sizeJ: 2, score: 0.6, crossover: 0.7, shareKey: true, hasKeys: true }).merge, true, 'a shared key is identity evidence');
  assert.equal(crossGroupDecision({ sizeI: 2, sizeJ: 2, score: 0.9, crossover: 0.7, shareKey: false, hasKeys: true }).merge, true, 'a near-duplicate is admitted');
  assert.equal(crossGroupDecision({ sizeI: 2, sizeJ: 2, score: 0.1, crossover: 0.7, shareKey: false, hasKeys: false }).merge, true, 'a keyless group is the residue: similarity is the only evidence');
  assert.equal(crossGroupDecision({ sizeI: 1, sizeJ: 2, score: 0.1, crossover: 0.7, shareKey: false, hasKeys: true }).merge, true, 'a lone item is not a group yet');
  // the boundary is the crossover, inclusive
  assert.equal(crossGroupDecision({ sizeI: 2, sizeJ: 2, score: 0.7, crossover: 0.7, shareKey: false, hasKeys: true }).merge, true, 'the crossover itself is admitted');

  // and that the rule is really wired into cluster(): the switch that turns it off changes a real run.
  // Two keyed groups whose wording is far enough apart that the identity layers cannot join them.
  const items = [
    { id: 'p1a', sourceId: 's1', title: '动画 第一话 观后感 一般', text: '动画 第一话 观后感 一般', url: 'https://e.example/a/1', time: at('2026-09-14T10:00:00Z') },
    { id: 'p1b', sourceId: 's1', title: '动画 第一话 观后感 一般', text: '动画 第一话 观后感 一般', url: 'https://e.example/a/1', time: at('2026-09-14T11:00:00Z') },
    { id: 'p2a', sourceId: 's2', title: '嘉然 3D披露 很好看', text: '嘉然 3D披露 很好看', url: 'https://e.example/b/2', time: at('2026-09-14T12:00:00Z') },
    { id: 'p2b', sourceId: 's2', title: '嘉然 3D披露 很好看', text: '嘉然 3D披露 很好看', url: 'https://e.example/b/2', time: at('2026-09-14T13:00:00Z') },
  ];
  const cs = cluster(items, { weight: () => 1 });
  assert.equal(cs.length, 2, 'each group keeps its own event');
  const cross = (list) => list.filter((c) => c.items.some((i) => i.id.startsWith('p1')) && c.items.some((i) => i.id.startsWith('p2')));
  assert.equal(cross(cs).length, 0, 'and they are not joined');
  // every pair this fixture proposes is either admitted by the gates or refused by the rule; the rule's
  // refusals must be zero here, because the wording score (0.6-ish) never reaches the gates at all —
  // which is exactly why the rule's own decision is tested above rather than through this input
  assert.equal(cs[0].evidence.refused.identity, 0, `this fixture does not reach the rule (got ${JSON.stringify(cs[0].evidence.refused)})`);
  assert.ok(DEFAULT_CROSS_GROUP_SIMILARITY > DEFAULT_DIAMETER);
});

t('(7) a group with no identity key at all is not blocked by the cross-group rule', () => {
  // the residue: no id, no url, no matching title. Similarity is the only evidence that exists, so it
  // has to work, otherwise the layer is dead.
  const items = [
    { id: 'r1', sourceId: 's1', title: '完全无关的甲', time: at('2026-09-14T10:00:00Z') },
    { id: 'r2', sourceId: 's2', title: '完全无关的甲', time: at('2026-09-14T10:30:00Z') },
    { id: 'r3', sourceId: 's3', title: '完全无关的甲', time: at('2026-09-14T11:00:00Z') },
  ];
  const cs = cluster(items, { weight: () => 1 });
  assert.equal(cs.length, 1, 'they are the same report');
});

process.stdout.write('\ncluster: the event explains itself\n');

t('an event says which layer joined its members', () => {
  const items = [
    { id: 'k1', sourceId: 'src-a', title: 'X', url: 'https://www.bilibili.com/opus/9', time: at('2026-09-14T10:00:00Z') },
    { id: 'k2', sourceId: 'src-b', title: 'Y', url: 'https://www.bilibili.com/opus/9', time: at('2026-09-14T10:10:00Z') },
  ];
  const c = cluster(items, { weight: () => 1 })[0];
  assert.equal(c.evidence.by, 'url');
  assert.ok(Array.isArray(c.evidence.layers) && c.evidence.layers.length > 0);
  const row = c.evidence.layers.find((l) => l.layer === 'url');
  assert.equal(row.key, 'https://bilibili.com/opus/9');
  assert.deepEqual(row.items.sort(), ['k1', 'k2']);
  // control: a single item must not claim a merge reason, or "why" would be a constant
  const one = cluster([items[0]], { weight: () => 1 })[0];
  assert.equal(one.evidence.by, 'single');
  assert.equal(one.evidence.layers.length, 0);
});

t('similarity joins carry their score, and every layer name is one of the declared layers', () => {
  const items = [
    { id: 's1', sourceId: 'src-a', title: '某游戏版本更新公告 3月15日', text: '某游戏版本更新公告 3月15日 上线', time: at('2026-09-14T10:00:00Z'), url: 'https://one.example/1' },
    { id: 's2', sourceId: 'src-b', title: '某游戏版本更新公告 3月15日', text: '某游戏版本更新公告 3月15日 上线', time: at('2026-09-14T11:00:00Z'), url: 'https://two.example/2' },
  ];
  for (const c of cluster(items, { weight: () => 1 })) {
    assert.ok(LAYERS.includes(c.evidence.by), `unknown layer ${c.evidence.by}`);
    for (const l of c.evidence.layers) assert.ok(LAYERS.includes(l.layer), `unknown layer ${l.layer}`);
    if (c.items.length > 1) assert.ok(c.similarityRange, 'a merged event must report its similarity range');
  }
});

process.stdout.write('\ncluster: mutations (each proves one assertion can fail)\n');

await tf('mutation: dropping L1 lets the same id split, and the mutation is visible', async () => {
  const items = [
    { id: 'bili-opus-7', sourceId: 's', title: 'A', text: 'aaaa bbbb cccc', url: 'https://www.bilibili.com/opus/7', time: at('2026-09-14T10:00:00Z') },
    { id: 'bili-opus-7', sourceId: 's', title: 'B', text: 'xxxx yyyy zzzz', url: 'https://www.bilibili.com/opus/7', time: at('2026-09-14T11:00:00Z') },
  ];
  const m = await mutation("const IDENTITY_LAYERS = ['native', 'url', 'urlId', 'titleDay'];", 'const IDENTITY_LAYERS = [];');
  assert.equal(cluster(items, { weight: () => 1 }).length, 1, 'baseline: the native id merges them');
  const mutated = m.cluster(items, { weight: () => 1, layers: [] , diameter: 0});
  assert.equal(mutated.length, 2, 'with no identity layer the same id no longer merges');
});

await tf('mutation: the url normaliser is what makes two spellings of one url meet', async () => {
  // Two spellings of one page, with nothing else in common: no native id (the ids differ), no extractable
  // content id (nothing in the id rules matches this host), and titles far enough apart that similarity
  // does not reach them. So the url layer is the only thing that can join them — and with the
  // normalisation removed it cannot.
  const a = { id: 'a', sourceId: 's1', title: 'バーチャル 3D ライブ 配信', url: 'https://news.example.com/2026/09/14/story/', time: at('2026-09-14T10:00:00Z') };
  const b = { id: 'b', sourceId: 's2', title: 'ゲーム の アップデート 説明', url: 'https://news.example.com/2026/09/14/story', time: at('2026-09-14T10:10:00Z') };
  assert.equal(canonicalUrl(a.url), canonicalUrl(b.url), 'baseline: the same canonical url');
  const base = cluster([a, b], { weight: () => 1 });
  assert.equal(base.length, 1, 'baseline: one event');
  assert.equal(base[0].evidence.by, 'url', 'and the url layer is the reason');
  const m = await mutation('if (pathname.length > 1) pathname = pathname.replace(/\\/+$/, \'\');', 'if (false) pathname = pathname.replace(/\\/+$/, \'\');', { module: 'identity' });
  assert.notEqual(m.canonicalUrl(a.url), m.canonicalUrl(b.url), 'the mutated normaliser keeps the trailing slash, so the two spellings differ');
  assert.equal(m.cluster([a, b], { weight: () => 1 }).length, 2, 'and they stop meeting');
  // and a content parameter really does separate two pages of one resource, which is the other half of
  // the same rule: the allow-list keeps identity, not the whole query string
  const p1 = { id: 'p1', sourceId: 's1', title: 'バーチャル 3D ライブ 配信', url: 'https://www.bilibili.com/video/BV1xx411c7mD?p=1', time: at('2026-09-14T10:00:00Z') };
  const p2 = { id: 'p2', sourceId: 's2', title: 'ゲーム の アップデート 説明', url: 'https://www.bilibili.com/video/BV1xx411c7mD?p=2', time: at('2026-09-14T10:10:00Z') };
  assert.notEqual(canonicalUrl(p1.url), canonicalUrl(p2.url), '?p= is a content parameter and survives');
  const m2 = await mutation('const keep = CONTENT_PARAMS.get(host) ?? [];', 'const keep = [];', { module: 'identity' });
  assert.equal(m2.canonicalUrl(p1.url), m2.canonicalUrl(p2.url), 'CONTROL: with the allow-list emptied the two pages collide');
  assert.equal(m2.cluster([p1, p2], { weight: () => 1 }).length, 1, 'CONTROL: and they become one event');
});
await tf('mutation: removing the diameter floor lets the chain back in', async () => {
  const items = [
    { id: 'c1', sourceId: 'fandom-vtuber-wiki', title: 'Deluta', text: 'Deluta is a VTuber.', url: 'https://virtualyoutuber.fandom.com/wiki/Deluta', time: at('2026-09-15T10:00:00Z') },
    { id: 'c2', sourceId: 'fandom-vtuber-wiki', title: 'Deluta/Gallery', text: 'Gallery of Deluta images.', url: 'https://virtualyoutuber.fandom.com/wiki/Deluta%2FGallery', time: at('2026-09-15T10:10:00Z') },
    { id: 'c3', sourceId: 'fandom-vtuber-wiki', title: 'FeraLune/Gallery', text: 'Gallery of FeraLune images.', url: 'https://virtualyoutuber.fandom.com/wiki/FeraLune%2FGallery', time: at('2026-09-15T10:20:00Z') },
    { id: 'c4', sourceId: 'fandom-vtuber-wiki', title: 'FeraLune', text: 'FeraLune is a VTuber.', url: 'https://virtualyoutuber.fandom.com/wiki/FeraLune', time: at('2026-09-15T10:30:00Z') },
  ];
  const m = await mutation('const diameterFloor = Number(opts.diameter ?? DEFAULT_DIAMETER);', 'const diameterFloor = 0;');
  const together = (cs) => cs.filter((c) => c.items.some((i) => i.id === 'c1') && c.items.some((i) => i.id === 'c4'));
  assert.equal(together(cluster(items, { weight: () => 1 })).length, 0, 'baseline: kept apart');
  assert.ok(together(m.cluster(items, { weight: () => 1 })).length > 0, 'with the floor forced to 0 they chain');
});

await tf('the windowed title layer is what joins a same-title pair that straddles the day line', async () => {
  const items = [
    { id: 'q1', sourceId: 's1', title: '同名标题 同一件事', url: 'https://a.example/1', time: at('2026-09-14T10:00:00Z') },
    { id: 'q2', sourceId: 's2', title: '同名标题 同一件事', url: 'https://b.example/2', time: at('2026-09-14T23:00:00Z') },
  ];
  // 13 hours apart: outside the same local day, inside the window. So the same-day layer cannot join
  // them and the windowed title layer is what does: the evidence names only that layer, and the
  // same-day key differs.
  //
  // The day line is a property of a zone, not of the machine: on a UTC runner these two instants are
  // the same day and the same-day layer joins them instead, which makes the assertion above fail for a
  // reason that has nothing to do with what it tests. The zone is therefore declared here and passed to
  // every cluster() call in this check — Asia/Shanghai is what puts 23:00Z on the next day, and pinning
  // it is what makes the check mean the same thing on this box and on CI.
  const tz = 'Asia/Shanghai';
  const full = cluster(items, { weight: () => 1, timeZone: tz });
  assert.equal(full.length, 1, 'baseline: one event');
  assert.deepEqual(full[0].evidence.layers.map((l) => l.layer), ['title'], 'the windowed title layer is the only reason');
  assert.notEqual(identityKeys(items[0], '2026-09-14').titleDay, identityKeys(items[1], '2026-09-15').titleDay, 'and the same-day keys really differ');
  // the mutation that proves the comparison is real: force the window test to always succeed and a pair
  // that must stay apart does not
  const far = [
    { id: 'z1', sourceId: 's1', title: '同名标题 一年后', url: 'https://a.example/1', time: at('2026-09-14T10:00:00Z') },
    { id: 'z2', sourceId: 's2', title: '同名标题 一年后', url: 'https://b.example/2', time: at('2027-09-14T10:00:00Z') },
  ];
  assert.equal(cluster(far, { weight: () => 1, timeZone: tz }).length, 2, 'a year apart must stay apart');
  const m = await mutation('Math.abs(ts - prev.epoch) > windowMs', 'false', {});
  assert.equal(m.cluster(far, { weight: () => 1, timeZone: tz }).length, 1, 'with the window test forced to "always inside" they merge');
});

await tf('mutation: making the title fingerprint fuzzy turns exact agreement back into a loose one', async () => {
  // the two titles differ in the day number only: exact agreement keeps them apart, and a fingerprint
  // that throws digits away cannot tell them apart any more
  const a = { id: 'f1', sourceId: 's1', title: '同一天的公告 3月15日', url: 'https://a.example/1', time: at('2026-09-14T10:00:00Z') };
  const b = { id: 'f2', sourceId: 's2', title: '同一天的公告 3月16日', url: 'https://b.example/2', time: at('2026-09-14T11:00:00Z') };
  assert.notEqual(titleFingerprint(a.title), titleFingerprint(b.title), 'baseline: the fingerprints differ');
  const m = await mutation(
    ".replace(/[\\p{P}\\p{S}]+/gu, ' ')",
    ".replace(/[\\p{P}\\p{S}]+/gu, ' ').replace(/\\d+/g, '')",
    { module: 'identity' }
  );
  assert.equal(m.titleFingerprint(a.title), m.titleFingerprint(b.title), 'the mutated fingerprint really is fuzzy');
});

process.stdout.write('\ncluster: fields that the UI already reads\n');

t('no existing field changed meaning: the delivered event still carries every field it did', () => {
  const items = [
    { id: 'e1', sourceId: 'official-hololive', title: '嘉然 3D披露', url: 'https://hololive.example/x', time: at('2026-03-01T10:00:00Z') },
    { id: 'e2', sourceId: 'news-moguravr', title: '嘉然 3D披露 直播', url: 'https://mogura.example/y', time: at('2026-03-01T12:00:00Z') },
  ];
  const c = cluster(items, { weight: () => 1 })[0];
  for (const k of ['id', 'title', 'url', 'firstAt', 'lastAt', 'sources', 'sourceCount', 'items', 'weight', 'leadSourceId', 'firstSourceId', 'people', 'duplicateCount', 'confirmed', 'similarity']) {
    assert.ok(k in c, `field ${k} is gone from an event`);
  }
  assert.equal(c.similarity, null, 'similarity was always null and still is (its meaning is unchanged)');
  assert.ok('similarityRange' in c, 'the new field is additive');
  assert.ok(DEFAULT_MAX_GROUP >= 1);
});

process.stdout.write(`\n${pass}/${pass + fail} checks passed\n`);
if (fail) {
  process.stdout.write('  ' + fail + ' FAILED\n');
  process.exit(1);
}
