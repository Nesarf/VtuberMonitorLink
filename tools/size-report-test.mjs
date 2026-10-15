// size-report-test.mjs — the size band is a standing constraint, so the edges of it get a test.
//
// The rule it enforces (owner, round 14): the whole thing stays **under 1 GB and not below ~400 MB**, and slimming
// never removes functionality. The floor is the half that protects behaviour - a checkout that shrank far below it
// did so by losing something - and both edges are inclusive, which is exactly the kind of statement that quietly
// becomes a `<` the next time somebody touches it.
//
// What is tested here is the decision, not the byte count: making a 1 GB fixture to trip the ceiling would be a
// worse test than asserting the boundary arithmetic directly. The measuring half is exercised by the tool itself,
// which runs against the real tree in the same session.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CEILING_MB, FLOOR_MB, bandVerdict, report, sizeOf, walk } from './size-report.mjs';

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

t('both edges of the band are inclusive, and inside is inside', () => {
  assert.equal(bandVerdict(FLOOR_MB).within, true, 'exactly the floor is inside: "at least 400 MB"');
  assert.equal(bandVerdict(CEILING_MB).within, true, 'exactly the ceiling is inside: "at most 1 GB"');
  assert.equal(bandVerdict((FLOOR_MB + CEILING_MB) / 2).within, true);
  assert.equal(bandVerdict(FLOOR_MB - 0.1).under, true, 'just under the floor is under');
  assert.equal(bandVerdict(CEILING_MB + 0.1).over, true, 'just over the ceiling is over');
  // controls: the two failures are distinguishable, not one "not inside" flag
  assert.equal(bandVerdict(10).within, false);
  assert.equal(bandVerdict(10).over, false, 'being under the floor is not being over the ceiling');
  assert.equal(bandVerdict(5000).under, false, 'and being over the ceiling is not being under the floor');
});

t('a nonsense measurement is not silently called healthy', () => {
  for (const bad of [NaN, undefined, null, 'many']) {
    const v = bandVerdict(bad);
    assert.equal(v.within, false, `${String(bad)} must not read as inside the band`);
    assert.equal(v.over, false);
    assert.equal(v.under, false);
  }
  // control: a real number is inside, so the loop above is not passing because everything fails
  assert.equal(bandVerdict(700).within, true);
});

t('measuring a tree counts its files and leaves junctions alone', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vml-size-'));
  try {
    fs.writeFileSync(path.join(dir, 'a.bin'), Buffer.alloc(1024));
    fs.mkdirSync(path.join(dir, 'nested'));
    fs.writeFileSync(path.join(dir, 'nested', 'b.bin'), Buffer.alloc(2048));
    const walked = walk(dir);
    assert.equal(walked.files.length, 2, 'two files, one level down included');
    assert.equal(walked.links.length, 0);
    assert.equal(sizeOf(dir), 3072, 'and their bytes are summed exactly');
    // the report on a small tree is honestly under the floor rather than pretending to be fine
    const r = report(dir);
    assert.equal(r.withinBand, false, 'a three-kilobyte tree is not a 400 MB product');
    assert.equal(r.attributedMB < 1, true, 'and the number is small, not rounded into the band');
    assert.equal(r.floorMB, FLOOR_MB);
    assert.equal(r.ceilingMB, CEILING_MB);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

process.stdout.write(`\nsize report: ${pass} ok, ${fail} failed\n`);
if (fail) process.exit(1);
