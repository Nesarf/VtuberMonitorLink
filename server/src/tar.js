// tar.js — 极简 tar 读取（只为解 GitHub 的 tarball，零依赖）
//
// 为什么不用依赖：我们要的是「一条请求拿全库」（VDB 整库 tarball 只有 0.54MB），
// 而为了解一个 tar 引入 npm 包不值得 —— 这个项目一贯只有 express/undici 两个运行时依赖。
// 也不 shell 出去调 tar.exe：那会把「能在哪些平台跑」交给系统工具。
//
// 支持的形态（GitHub codeload / git archive 会用到）：
//   · ustar 普通条目（type 0 / NUL / 7）
//   · 目录条目（type 5）
//   · GNU 长名（type L）：下一个条目的名字
//   · pax 扩展头（type x）：里面的 `path=` 覆盖下一个条目的名字
//     —— git archive 遇到长路径会发 pax，而不是 GNU L（中文名 + 长目录很容易触发）
const BLOCK = 512;

function cstr(buf) {
  const end = buf.indexOf(0);
  return buf.subarray(0, end === -1 ? buf.length : end).toString('utf8');
}

function octal(buf) {
  const s = cstr(buf).trim().replace(/\0/g, '');
  return parseInt(s, 8) || 0;
}

/** 解析 pax 扩展头（形如 `路径长度 key=value\n`） */
export function parsePax(buf) {
  const out = {};
  let off = 0;
  while (off < buf.length) {
    const sp = buf.indexOf(0x20, off);
    if (sp === -1) break;
    const len = parseInt(buf.subarray(off, sp).toString('utf8'), 10);
    if (!Number.isFinite(len) || len <= 0) break;
    const rec = buf.subarray(sp + 1, off + len - 1).toString('utf8'); // 末尾是 \n
    const eq = rec.indexOf('=');
    if (eq > 0) out[rec.slice(0, eq)] = rec.slice(eq + 1);
    off += len;
  }
  return out;
}

/**
 * 读一个未压缩的 tar。
 * @returns {Map<string, Buffer>} 路径 → 内容（目录不入表）
 */
export function readTar(buf) {
  const files = new Map();
  let off = 0;
  let pendingName = null;
  let pendingPax = null;

  while (off + BLOCK <= buf.length) {
    const header = buf.subarray(off, off + BLOCK);
    if (header.every((b) => b === 0)) break; // 结束块

    const name = cstr(header.subarray(0, 100));
    const size = octal(header.subarray(124, 136));
    const type = String.fromCharCode(header[156] || 0x30);
    const prefix = cstr(header.subarray(345, 500));
    const dataStart = off + BLOCK;
    const data = buf.subarray(dataStart, dataStart + size);
    const next = dataStart + Math.ceil(size / BLOCK) * BLOCK;

    if (type === 'L') {
      pendingName = cstr(data); // GNU 长名：下一个条目的名字
    } else if (type === 'x' || type === 'g') {
      pendingPax = parsePax(data); // pax：path= 覆盖下一个条目的名字
    } else if (type === '5') {
      // 目录：跳过
      pendingName = null;
      pendingPax = null;
    } else {
      let full = pendingPax?.path ?? pendingName ?? (prefix ? `${prefix}/${name}` : name);
      full = full.replace(/^\.\//, '');
      if (full) files.set(full, data);
      pendingName = null;
      pendingPax = null;
    }
    off = next;
  }
  return files;
}
