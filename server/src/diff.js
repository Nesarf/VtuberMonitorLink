// diff.js — a minimal line-level diff
// It serves exactly one purpose, "watch target changes": human-readable, bounded in size, with clear add/remove markers.
// It does not chase the minimal edit distance; it chases stability and readability.

/**
 * Line-level diff (LCS dynamic programming; falls back to a block replace past the cap)
 * @param {string} a old text
 * @param {string} b new text
 * @param {{maxLines?:number}} opts
 * @returns {{op:' '|'-'|'+', text:string, aLine:number|null, bLine:number|null}[]}
 */
export function diffLines(a, b, opts = {}) {
  const maxLines = opts.maxLines ?? 4000;
  const A = String(a ?? '').split(/\r?\n/);
  const B = String(b ?? '').split(/\r?\n/);

  if (A.length > maxLines || B.length > maxLines) {
    // Too large -> fall back to "replace the whole block": you can still see that it changed, but there is no per-line alignment
    return [
      ...A.map((text, i) => ({ op: '-', text, aLine: i + 1, bLine: null })),
      ...B.map((text, i) => ({ op: '+', text, aLine: null, bLine: i + 1 })),
    ];
  }

  // Trim the common prefix and suffix first; in the common case that shrinks the DP table to something tiny
  let start = 0;
  while (start < A.length && start < B.length && A[start] === B[start]) start++;
  let endA = A.length;
  let endB = B.length;
  while (endA > start && endB > start && A[endA - 1] === B[endB - 1]) {
    endA--;
    endB--;
  }

  const midA = A.slice(start, endA);
  const midB = B.slice(start, endB);
  const n = midA.length;
  const m = midB.length;

  const out = [];
  for (let i = 0; i < start; i++) out.push({ op: ' ', text: A[i], aLine: i + 1, bLine: i + 1 });

  if (n * m > 4_000_000) {
    for (let i = 0; i < n; i++) out.push({ op: '-', text: midA[i], aLine: start + i + 1, bLine: null });
    for (let j = 0; j < m; j++) out.push({ op: '+', text: midB[j], aLine: null, bLine: start + j + 1 });
  } else {
    // LCS table
    const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        dp[i][j] = midA[i] === midB[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (midA[i] === midB[j]) {
        out.push({ op: ' ', text: midA[i], aLine: start + i + 1, bLine: start + j + 1 });
        i++;
        j++;
      } else if (dp[i + 1][j] >= dp[i][j + 1]) {
        out.push({ op: '-', text: midA[i], aLine: start + i + 1, bLine: null });
        i++;
      } else {
        out.push({ op: '+', text: midB[j], aLine: null, bLine: start + j + 1 });
        j++;
      }
    }
    while (i < n) out.push({ op: '-', text: midA[i], aLine: start + i + 1, bLine: null }), i++;
    while (j < m) out.push({ op: '+', text: midB[j], aLine: null, bLine: start + j + 1 }), j++;
  }

  for (let k = 0; k < A.length - endA; k++) {
    out.push({ op: ' ', text: A[endA + k], aLine: endA + k + 1, bLine: endB + k + 1 });
  }
  return out;
}

/** Summarize a diff */
export function diffStats(lines) {
  let added = 0;
  let removed = 0;
  for (const l of lines) {
    if (l.op === '+') added++;
    else if (l.op === '-') removed++;
  }
  return { added, removed, changed: added + removed, lines: lines.length };
}

/** Keep changed hunks only (a few lines of context on each side) */
export function diffHunks(lines, context = 3) {
  const keep = new Set();
  lines.forEach((l, i) => {
    if (l.op === ' ') return;
    for (let k = Math.max(0, i - context); k <= Math.min(lines.length - 1, i + context); k++) keep.add(k);
  });
  const out = [];
  let last = -2;
  for (let i = 0; i < lines.length; i++) {
    if (!keep.has(i)) continue;
    if (i - last > 1) out.push({ op: '@', text: `… 第 ${i + 1} 行附近 …`, aLine: null, bLine: null });
    out.push(lines[i]);
    last = i;
  }
  return out;
}
