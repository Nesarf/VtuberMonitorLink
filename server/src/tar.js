// tar.js — a minimal tar reader (only to unpack GitHub tarballs, zero dependencies)
//
// Why no dependency: the goal is to "fetch the whole roster in one request" (the full VDB
// tarball is only 0.54MB), and pulling in an npm package just to unpack a tar is not worth it —
// this project has always had exactly two runtime dependencies, express and undici.
// We do not shell out to tar.exe either: that would hand "which platforms this runs on" to a
// system tool.
//
// Shapes we support (GitHub codeload / git archive use these):
//   * ustar regular entries (type 0 / NUL / 7)
//   * directory entries (type 5)
//   * GNU long names (type L): the name of the next entry
//   * pax extended headers (type x): the `path=` inside overrides the next entry's name
//     — git archive emits pax rather than GNU L for long paths (a Chinese name plus long
//       directories easily triggers it)
const BLOCK = 512;

function cstr(buf) {
  const end = buf.indexOf(0);
  return buf.subarray(0, end === -1 ? buf.length : end).toString('utf8');
}

function octal(buf) {
  const s = cstr(buf).trim().replace(/\0/g, '');
  return parseInt(s, 8) || 0;
}

/** Parse a pax extended header (a repeating `<length> key=value\n`, where `<length>` counts itself) */
export function parsePax(buf) {
  const out = {};
  let off = 0;
  while (off < buf.length) {
    const sp = buf.indexOf(0x20, off);
    if (sp === -1) break;
    const len = parseInt(buf.subarray(off, sp).toString('utf8'), 10);
    if (!Number.isFinite(len) || len <= 0) break;
    const rec = buf.subarray(sp + 1, off + len - 1).toString('utf8'); // the trailing byte is \n
    const eq = rec.indexOf('=');
    if (eq > 0) out[rec.slice(0, eq)] = rec.slice(eq + 1);
    off += len;
  }
  return out;
}

/**
 * Read an uncompressed tar.
 * @returns {Map<string, Buffer>} path -> content (directories are not put in the map)
 */
export function readTar(buf) {
  const files = new Map();
  let off = 0;
  let pendingName = null;
  let pendingPax = null;

  while (off + BLOCK <= buf.length) {
    const header = buf.subarray(off, off + BLOCK);
    if (header.every((b) => b === 0)) break; // end-of-archive block

    const name = cstr(header.subarray(0, 100));
    const size = octal(header.subarray(124, 136));
    const type = String.fromCharCode(header[156] || 0x30);
    const prefix = cstr(header.subarray(345, 500));
    const dataStart = off + BLOCK;
    const data = buf.subarray(dataStart, dataStart + size);
    const next = dataStart + Math.ceil(size / BLOCK) * BLOCK;

    if (type === 'L') {
      pendingName = cstr(data); // GNU long name: the next entry's name
    } else if (type === 'x' || type === 'g') {
      pendingPax = parsePax(data); // pax: path= overrides the next entry's name
    } else if (type === '5') {
      // directory: skip
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
