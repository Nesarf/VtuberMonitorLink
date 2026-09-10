// diff.js — 极简行级 diff
// 只服务于「监视对象变更」这一件事：给人看的、有界大小的、增删标记清楚。
// 不追求最小编辑距离，追求稳定与可读。

/**
 * 行级 diff（LCS 动态规划，超过上限时退化成整块替换）
 * @param {string} a 旧文本
 * @param {string} b 新文本
 * @param {{maxLines?:number}} opts
 * @returns {{op:' '|'-'|'+', text:string, aLine:number|null, bLine:number|null}[]}
 */
export function diffLines(a, b, opts = {}) {
  const maxLines = opts.maxLines ?? 4000;
  const A = String(a ?? '').split(/\r?\n/);
  const B = String(b ?? '').split(/\r?\n/);

  if (A.length > maxLines || B.length > maxLines) {
    // 太大就退化成「整块替换」，仍然能看出变了，但不做逐行对齐
    return [
      ...A.map((text, i) => ({ op: '-', text, aLine: i + 1, bLine: null })),
      ...B.map((text, i) => ({ op: '+', text, aLine: null, bLine: i + 1 })),
    ];
  }

  // 先做公共前后缀裁剪，常见情形下能把 DP 规模压到很小
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
    // LCS 表
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

/** 汇总统计 / summarize a diff */
export function diffStats(lines) {
  let added = 0;
  let removed = 0;
  for (const l of lines) {
    if (l.op === '+') added++;
    else if (l.op === '-') removed++;
  }
  return { added, removed, changed: added + removed, lines: lines.length };
}

/** 只保留有变化的片段（前后各留几行上下文）/ keep changed hunks with context */
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
