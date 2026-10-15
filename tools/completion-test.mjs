// completion-test.mjs — the one mapping between an LLM response and what this product does with it.
//
// Why it exists: VML produces **documents** (a daily report, a merch scan), and the provider's `max_tokens` is a
// hard budget. Until this mapping existed, `choices[0].message.content` was read and `finish_reason` was ignored,
// so a report that hit the cap came back as a shorter report with nothing anywhere saying it had been cut - the
// reader could not tell "the model had little to say" from "the model ran out of room". For a tool whose whole
// purpose is long output, that is the one failure mode it must not have.
import assert from 'node:assert/strict';
import { completionOf } from '../server/src/analyze.js';

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

const answer = (over = {}) => ({
  choices: [{ message: { content: 'a document' }, finish_reason: 'stop' }],
  usage: { total_tokens: 123 },
  ...over,
});

t('the content, the finish reason and the usage all come from the response', () => {
  const got = completionOf(answer());
  assert.equal(got.markdown, 'a document');
  assert.equal(got.finishReason, 'stop');
  assert.equal(got.truncated, false);
  assert.deepEqual(got.usage, { total_tokens: 123 });
});

t('hitting the token cap is reported as truncation, and the text is still returned', () => {
  const cut = completionOf(answer({ choices: [{ message: { content: 'a docum' }, finish_reason: 'length' }] }));
  assert.equal(cut.truncated, true, 'finish_reason=length must set truncated');
  assert.equal(cut.markdown, 'a docum', 'the partial document is still handed back - the caller shows it and warns');
  // control: a normal stop is not truncation, so the flag is about the reason and not about the shape of the call
  assert.equal(completionOf(answer()).truncated, false, 'the control: stop is not truncation');
});

t('a missing finish reason is unknown, not fine', () => {
  const silent = completionOf({ choices: [{ message: { content: 'text' } }] });
  assert.equal(silent.finishReason, null, 'a provider that tells us nothing must read as null');
  assert.equal(silent.truncated, false, 'and it must not be guessed either way');
  assert.equal(silent.markdown, 'text', 'the content is unaffected');
  // control: other reasons exist and none of them is truncation
  for (const reason of ['stop', 'tool_calls', 'content_filter', '']) {
    const r = completionOf(answer({ choices: [{ message: { content: 'x' }, finish_reason: reason }] }));
    assert.equal(r.truncated, false, `${JSON.stringify(reason)} must not read as truncation`);
  }
  // and a non-string reason (a provider sending a number, say) is unknown rather than a crash
  assert.equal(completionOf(answer({ choices: [{ message: { content: 'x' }, finish_reason: 7 }] })).finishReason, null);
});

t('a malformed or empty response yields empty text rather than throwing', () => {
  for (const bad of [null, undefined, {}, { choices: [] }, { choices: [{}] }, { choices: [{ message: null }] }]) {
    const got = completionOf(bad);
    assert.equal(got.markdown, '', `markdown must be empty for ${JSON.stringify(bad)}`);
    assert.equal(got.truncated, false);
  }
  // control: the same call with real content is not empty, so the loop above is not passing by accident
  assert.equal(completionOf(answer()).markdown, 'a document');
});

process.stdout.write(`\ncompletion: ${pass} ok, ${fail} failed\n`);
if (fail) process.exit(1);
