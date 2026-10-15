// vision-model-test.mjs — only models that can see may be pulled, and they keep the provider's own name.
//
// The instruction this implements: the model list a user is offered contains vision-capable models only, and each
// one is shown under the id the provider uses (this product does not rename a model - the name is what the user
// types into the provider's own console). The interesting part is honesty about *how* a model was judged capable:
// metadata when the provider states it, a documented id pattern when it does not, and "unknown" - never "text
// only" - when neither says anything.
import assert from 'node:assert/strict';
import { entryVision, visionFilter } from '../server/src/llm.js';

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

t('stated modalities decide, and nothing else is consulted', () => {
  const openrouter = { id: 'vendor/anything', architecture: { input_modalities: ['text', 'image'] } };
  assert.equal(entryVision(openrouter).vision, true);
  assert.equal(entryVision(openrouter).why, 'metadata');
  const textOnly = { id: 'gpt-4o', architecture: { input_modalities: ['text'] } };
  // the control that matters: an id the *name* rule would call vision is denied by metadata that says otherwise
  assert.equal(entryVision(textOnly).vision, false, 'metadata outranks the name pattern');
  assert.equal(entryVision(textOnly).why, 'metadata');
  for (const shape of [
    { id: 'x', capabilities: ['vision'] },
    { id: 'x', modalities: 'image' },
    { id: 'x', input_modalities: ['text', 'image'] },
    { id: 'x', architecture: { modality: 'multimodal' } },
  ]) {
    assert.equal(entryVision(shape).vision, true, JSON.stringify(shape));
  }
});

t('with no metadata the id decides, and an unmatched id is unknown rather than denied', () => {
  for (const id of ['qwen2.5-vl-7b-instruct', 'gpt-4o', 'gpt-4.1-mini', 'gemini-2.0-flash', 'glm-4v', 'llava-1.6', 'claude-3.7-sonnet', 'pixtral-12b']) {
    assert.equal(entryVision(id).vision, true, id);
    assert.equal(entryVision(id).why, 'name', id);
  }
  for (const id of ['deepseek-chat', 'deepseek-reasoner', 'some-model-nobody-has-seen']) {
    assert.equal(entryVision(id).vision, null, `${id} must be unknown, not text-only`);
    assert.equal(entryVision(id).why, 'unknown');
  }
  // control: the two buckets above are not the same bucket
  assert.notEqual(entryVision('deepseek-chat').why, entryVision('gpt-4o').why);
});

t('the filter offers only vision models, under their own names, and reports what it hid', () => {
  const got = visionFilter([
    'gpt-4o',
    'deepseek-chat',
    { id: 'Qwen/Qwen2.5-VL-72B-Instruct' },
    { id: 'text-embedding-3-large' },
    'gpt-4o', // a duplicate id, as providers do return
  ]);
  assert.equal(got.models.length, 2, 'five entries, two vision models, and the duplicate id collapsed');
  assert.ok(got.models.includes('gpt-4o'), 'a bare id is returned as written');
  assert.ok(got.models.includes('Qwen/Qwen2.5-VL-72B-Instruct'), 'a namespaced id keeps its namespace');
  assert.ok(!got.models.some((m) => m.toLowerCase().includes('embedding')), 'an embedding model is not offered');
  assert.ok(got.unknown.includes('deepseek-chat'), 'a text-only id nobody described is not offered');
  // controls: nothing is invented, and an empty response stays empty rather than throwing
  assert.deepEqual(visionFilter([]).models, []);
  assert.deepEqual(visionFilter(undefined).models, []);
  assert.equal(visionFilter(['gpt-4o']).models.length, 1, 'the control: a vision model does come through');
  // the three buckets are exclusive, which is what makes the counts add up in the UI
  const total = got.models.length + got.dropped.length + got.unknown.length;
  assert.equal(total, 4, 'four distinct ids in, four ids accounted for');
});

t('only stated capabilities can deny a model; a pattern that matches nothing says unknown', () => {
  const denied = visionFilter([{ id: 'gpt-4o', capabilities: ['text'] }, 'mystery-model', 'gpt-4o-mini']);
  assert.deepEqual(denied.dropped, ['gpt-4o'], 'metadata said text-only, so it is a denial');
  assert.deepEqual(denied.unknown, ['mystery-model'], 'no pattern matched, so it is unknown rather than denied');
  assert.deepEqual(denied.models, ['gpt-4o-mini'], 'and the third one is offered');
  // the design rule, asserted: the name tier never produces a denial, because a pattern list is a guess
  const byNameOnly = visionFilter(['deepseek-chat']);
  assert.deepEqual(byNameOnly.dropped, [], 'an id the patterns do not know is not called text-only');
  assert.deepEqual(byNameOnly.unknown, ['deepseek-chat']);
});

process.stdout.write(`\nvision models: ${pass} ok, ${fail} failed\n`);
if (fail) process.exit(1);
