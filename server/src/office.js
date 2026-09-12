// office.js — generate Office-readable/writable files (.docx / .xlsx) in pure Node
//
// Why hand-rolled instead of a library: the release is a **portable exe**, so we cannot assume
// the target machine has Office installed, nor that it has Python. And .docx/.xlsx are
// essentially a bunch of XML inside a ZIP container — Node ships zlib, so all that is missing
// is a ZIP packer and CRC32, which together come to under 150 lines.
//
// What it generates is **standard OOXML**: Word / Excel / WPS / LibreOffice can all open it and
// keep editing it, not the kind of fake you get by renaming a CSV.
import zlib from 'node:zlib';

// ───────────────────────────────────────── ZIP container

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0 ^ -1;
  for (let i = 0; i < buf.length; i++) c = (c >>> 8) ^ CRC_TABLE[(c ^ buf[i]) & 0xff];
  return (c ^ -1) >>> 0;
}

/** DOS time: any fixed legal value will do, a real timestamp is not needed */
function dosDateTime(d = new Date()) {
  const time = ((d.getHours() & 0x1f) << 11) | ((d.getMinutes() & 0x3f) << 5) | ((d.getSeconds() / 2) & 0x1f);
  const date = (((d.getFullYear() - 1980) & 0x7f) << 9) | (((d.getMonth() + 1) & 0x0f) << 5) | (d.getDate() & 0x1f);
  return { time, date };
}

/**
 * Build one ZIP archive (deflate compressed).
 * @param {{name:string, data:Buffer|string}[]} files
 * @returns {Buffer}
 */
export function makeZip(files) {
  const { time, date } = dosDateTime();
  const chunks = [];
  const central = [];
  let offset = 0;

  for (const f of files) {
    const nameBuf = Buffer.from(f.name, 'utf8');
    const raw = Buffer.isBuffer(f.data) ? f.data : Buffer.from(String(f.data), 'utf8');
    const deflated = zlib.deflateRawSync(raw, { level: 9 });
    const useDeflate = deflated.length < raw.length;
    const body = useDeflate ? deflated : raw;
    const method = useDeflate ? 8 : 0;
    const crc = crc32(raw);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 filename flag
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);

    chunks.push(local, nameBuf, body);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0x0800, 8);
    cd.writeUInt16LE(method, 10);
    cd.writeUInt16LE(time, 12);
    cd.writeUInt16LE(date, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(body.length, 20);
    cd.writeUInt32LE(raw.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(0, 30); // extra len
    cd.writeUInt16LE(0, 32); // comment len
    cd.writeUInt16LE(0, 34); // disk
    cd.writeUInt16LE(0, 36); // internal attrs
    cd.writeUInt32LE(0, 38); // external attrs
    cd.writeUInt32LE(offset, 42);
    central.push(cd, nameBuf);

    offset += local.length + nameBuf.length + body.length;
  }

  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...chunks, centralBuf, eocd]);
}

// ───────────────────────────────────────── XML helpers

export function xmlEscape(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
    // Control characters XML 1.0 does not allow: strip them outright, or Word refuses to open the file
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
}

/** Decide whether a character belongs in Excel's column-width math (CJK counts as two widths) */
function displayWidth(s) {
  let w = 0;
  for (const ch of String(s ?? '')) w += /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe6f\uff00-\uff60\uffe0-\uffe6]/.test(ch) ? 2 : 1;
  return w;
}

// ───────────────────────────────────────── .xlsx

/**
 * Generate .xlsx (inline strings, no sharedStrings needed).
 * @param {{name:string, rows:(string|number)[][]}[]} sheets
 */
export function buildXlsx(sheets) {
  const sheetParts = sheets.map((sheet) => {
      const colCount = sheet.rows.reduce((m, r) => Math.max(m, r.length), 0);
      // Estimate a column width from the content, so CJK does not get squeezed into a lump
      const cols = [];
      for (let c = 0; c < colCount; c++) {
        let w = 8;
        for (const r of sheet.rows.slice(0, 200)) w = Math.max(w, displayWidth(r[c] ?? '') + 2);
        cols.push(`<col min="${c + 1}" max="${c + 1}" width="${Math.min(80, w)}" customWidth="1"/>`);
      }
      const rows = sheet.rows
        .map((row, ri) => {
          const cells = row
            .map((v, ci) => {
              const ref = `${colName(ci)}${ri + 1}`;
              if (typeof v === 'number' && Number.isFinite(v)) return `<c r="${ref}"><v>${v}</v></c>`;
              if (v === null || v === undefined || v === '') return `<c r="${ref}"/>`;
              return `<c r="${ref}" t="inlineStr"${ri === 0 ? ' s="1"' : ''}><is><t xml:space="preserve">${xmlEscape(v)}</t></is></c>`;
            })
            .join('');
          return `<row r="${ri + 1}">${cells}</row>`;
        })
        .join('');
      return (
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
        (cols.length ? `<cols>${cols.join('')}</cols>` : '') +
        `<sheetData>${rows}</sheetData></worksheet>`
      );
    });

  const files = [
    {
      name: '[Content_Types].xml',
      data:
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
        `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
        `<Default Extension="xml" ContentType="application/xml"/>` +
        `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
        sheets
          .map(
            (_, i) =>
              `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`
          )
          .join('') +
        `<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>` +
        `</Types>`,
    },
    {
      name: '_rels/.rels',
      data:
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>` +
        `</Relationships>`,
    },
    {
      name: 'xl/workbook.xml',
      data:
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ` +
        `xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>` +
        sheets
          .map((s, i) => `<sheet name="${xmlEscape(String(s.name).slice(0, 31))}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`)
          .join('') +
        `</sheets></workbook>`,
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      data:
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('') +
        `<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
        `</Relationships>`,
    },
    {
      name: 'xl/styles.xml',
      data:
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
        `<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>` +
        `<fills count="1"><fill><patternFill patternType="none"/></fill></fills>` +
        `<borders count="1"><border/></borders>` +
        `<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>` +
        `<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>` +
        `<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs>` +
        `</styleSheet>`,
    },
  ];
  // One file per sheet
  sheetParts.forEach((part, i) => files.push({ name: `xl/worksheets/sheet${i + 1}.xml`, data: part }));

  return makeZip(files);
}

function colName(i) {
  let s = '';
  let n = i;
  do {
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return s;
}

// ───────────────────────────────────────── .docx

const W_NS =
  'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ' +
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';

function para(text, { style, bold, bullet } = {}) {
  const props = [];
  if (style) props.push(`<w:pStyle w:val="${style}"/>`);
  if (bullet) props.push('<w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr>');
  const runs = inlineRuns(text, bold);
  return `<w:p>${props.length ? `<w:pPr>${props.join('')}</w:pPr>` : ''}${runs}</w:p>`;
}

/** Inline: `code` and **bold** are supported in a simple way, everything else is plain text */
function inlineRuns(text, forceBold) {
  const s = String(text ?? '');
  const parts = [];
  let rest = s;
  const re = /(`[^`]+`|\*\*[^*]+\*\*)/;
  let m;
  while ((m = re.exec(rest))) {
    if (m.index > 0) parts.push({ text: rest.slice(0, m.index) });
    const tok = m[0];
    if (tok.startsWith('`')) parts.push({ text: tok.slice(1, -1), mono: true });
    else parts.push({ text: tok.slice(2, -2), bold: true });
    rest = rest.slice(m.index + tok.length);
  }
  if (rest) parts.push({ text: rest });
  return parts
    .map((p) => {
      const rpr = [];
      if (p.bold || forceBold) rpr.push('<w:b/>');
      if (p.mono) rpr.push('<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/>');
      return `<w:r>${rpr.length ? `<w:rPr>${rpr.join('')}</w:rPr>` : ''}<w:t xml:space="preserve">${xmlEscape(p.text)}</w:t></w:r>`;
    })
    .join('');
}

function table(rows) {
  const trs = rows
    .map((cells, ri) => {
      const tcs = cells
        .map(
          (c) =>
            `<w:tc><w:tcPr><w:tcW w:w="0" w:type="auto"/></w:tcPr>${para(c, { bold: ri === 0 })}</w:tc>`
        )
        .join('');
      return `<w:tr>${tcs}</w:tr>`;
    })
    .join('');
  return `<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/><w:tblW w:w="0" w:type="auto"/><w:tblBorders>` +
    ['top', 'left', 'bottom', 'right', 'insideH', 'insideV']
      .map((s) => `<w:${s} w:val="single" w:sz="4" w:space="0" w:color="999999"/>`)
      .join('') +
    `</w:tblBorders></w:tblPr>${trs}</w:tbl>`;
}

/**
 * Generate .docx.
 * @param {{title?:string, markdown:string}} doc
 */
export function buildDocx({ title, markdown }) {
  const lines = String(markdown ?? '').split(/\r?\n/);
  const body = [];
  if (title) body.push(para(title, { style: 'Title' }));

  let i = 0;
  let inList = false;
  while (i < lines.length) {
    const line = lines[i];

    // table
    if (/^\s*\|.*\|\s*$/.test(line) && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1] ?? '')) {
      const rows = [line.trim().slice(1, -1).split('|').map((c) => c.trim())];
      i += 2;
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) {
        rows.push(lines[i].trim().slice(1, -1).split('|').map((c) => c.trim()));
        i++;
      }
      body.push(table(rows));
      inList = false;
      continue;
    }

    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      const lvl = h[1].length;
      body.push(para(h[2], { style: lvl === 1 ? 'Heading1' : lvl === 2 ? 'Heading2' : 'Heading3' }));
      inList = false;
      i++;
      continue;
    }
    if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) {
      body.push('<w:p><w:pPr><w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="CCCCCC"/></w:pBdr></w:pPr></w:p>');
      inList = false;
      i++;
      continue;
    }
    if (/^\s*[-*+]\s+/.test(line)) {
      body.push(para(line.replace(/^\s*[-*+]\s+/, ''), { bullet: true }));
      inList = true;
      i++;
      continue;
    }
    if (/^\s*>\s?/.test(line)) {
      body.push(para(line.replace(/^\s*>\s?/, ''), { style: 'Quote' }));
      inList = false;
      i++;
      continue;
    }
    if (!line.trim()) {
      inList = false;
      i++;
      continue;
    }
    const buf = [line];
    i++;
    while (i < lines.length && lines[i].trim() && !/^(#{1,6}\s|\s*[-*+]\s|\s*\d+\.\s|>\s?|\|)/.test(lines[i])) buf.push(lines[i++]);
    body.push(para(buf.join(' ')));
  }

  const document =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<w:document ${W_NS}><w:body>${body.join('')}` +
    `<w:sectPr><w:pgSz w:w="11906" w:h="16838"/>` +
    `<w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134" w:header="851" w:footer="992" w:gutter="0"/>` +
    `</w:sectPr></w:body></w:document>`;

  const styles =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<w:styles ${W_NS}>` +
    `<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="Microsoft YaHei"/><w:sz w:val="21"/></w:rPr></w:rPrDefault></w:docDefaults>` +
    `<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>` +
    // Note: Chinese Word does not recognise English style names, so every style has to carry
    // w:name as well -- giving only styleId is not enough
    `<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:after="240"/></w:pPr><w:rPr><w:b/><w:sz w:val="40"/></w:rPr></w:style>` +
    `<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:pPr><w:outlineLvl w:val="0"/><w:spacing w:before="240" w:after="120"/></w:pPr><w:rPr><w:b/><w:sz w:val="32"/></w:rPr></w:style>` +
    `<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:pPr><w:outlineLvl w:val="1"/><w:spacing w:before="200" w:after="100"/></w:pPr><w:rPr><w:b/><w:sz w:val="26"/></w:rPr></w:style>` +
    `<w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="heading 3"/><w:basedOn w:val="Normal"/><w:pPr><w:outlineLvl w:val="2"/><w:spacing w:before="160" w:after="80"/></w:pPr><w:rPr><w:b/><w:sz w:val="23"/></w:rPr></w:style>` +
    `<w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/><w:basedOn w:val="Normal"/><w:rPr><w:i/><w:color w:val="666666"/></w:rPr></w:style>` +
    `<w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/></w:style>` +
    `</w:styles>`;

  return makeZip([
    {
      name: '[Content_Types].xml',
      data:
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
        `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
        `<Default Extension="xml" ContentType="application/xml"/>` +
        `<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>` +
        `<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>` +
        `</Types>`,
    },
    {
      name: '_rels/.rels',
      data:
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>` +
        `</Relationships>`,
    },
    {
      name: 'word/_rels/document.xml.rels',
      data:
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
        `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
        `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
        `</Relationships>`,
    },
    { name: 'word/styles.xml', data: styles },
    { name: 'word/document.xml', data: document },
  ]);
}

/** intel items -> xlsx rows / intel items to spreadsheet rows */
export function itemsToSheet(items, lang = 'zh') {
  const header = ['来源', '类型', '时间', '标题', '正文', '链接', '图片数', '互动', '标签'];
  const rows = [header];
  for (const it of items) {
    rows.push([
      it.sourceName?.[lang] ?? it.sourceId ?? '',
      it.kind ?? '',
      it.time ?? it.runDate ?? '',
      it.title ?? '',
      String(it.text ?? '').replace(/\s+/g, ' ').slice(0, 2000),
      it.url ?? '',
      (it.images ?? []).length,
      [it.stats?.like ? `赞${it.stats.like}` : '', it.stats?.comment ? `评${it.stats.comment}` : ''].filter(Boolean).join(' '),
      (it.tags ?? []).join(' '),
    ]);
  }
  return rows;
}

/** intel items -> Word-friendly markdown / intel items as readable markdown */
export function itemsToMarkdown(items, { title, lang = 'zh' } = {}) {
  const out = [`# ${title ?? '情报集'}`, '', `生成时间：${new Date().toLocaleString()}　共 ${items.length} 条`, ''];
  for (const it of items) {
    const head = `## ${it.title || String(it.text ?? '').replace(/\s+/g, ' ').slice(0, 40) || it.id}`;
    out.push(head, '');
    out.push(`- 来源：${it.sourceName?.[lang] ?? it.sourceId}`);
    if (it.time) out.push(`- 时间：${it.time}`);
    if (it.url) out.push(`- 链接：${it.url}`);
    if ((it.tags ?? []).length) out.push(`- 标签：${it.tags.join(' ')}`);
    out.push('');
    if (it.text) out.push(String(it.text).replace(/\r/g, ''), '');
    if ((it.images ?? []).length) out.push(`（配图 ${it.images.length} 张）`, '');
    out.push('---', '');
  }
  return out.join('\n');
}
