// markdown.jsx — the built-in minimal Markdown renderer
//
// Why write our own instead of using marked / react-markdown:
//   1) Report content comes from "scraped web pages + LLM output"; it is untrusted text.
//      Escaping everything first and then allowing only the tags we generate ourselves plus
//      http(s) image addresses is more controllable than pulling in a whole dependency chain;
//   2) The release has to build offline, and one fewer dependency is one less supply-chain risk.
//   — Therefore: **any raw HTML is treated as plain text**, never dangerouslySetInnerHTML.
import React from 'react';

const INLINE = [
  // `code`
  { re: /`([^`]+)`/g, render: (m, k) => <code key={k}>{m[1]}</code> },
  // **bold**
  { re: /\*\*([^*]+)\*\*/g, render: (m, k) => <strong key={k}>{m[1]}</strong> },
  // *italic* / _italic_
  { re: /(^|[^*\w])\*([^*\n]+)\*/g, render: (m, k) => [m[1], <em key={k}>{m[2]}</em>] },
  // [text](url)
  {
    re: /\[([^\]]+)\]\((https?:[^)\s]+)\)/g,
    render: (m, k) => (
      <a key={k} href={m[2]} target="_blank" rel="noreferrer noopener">
        {m[1]}
      </a>
    ),
  },
  // bare http(s) link
  { re: /(^|[\s(])(https?:\/\/[^\s<>")]+)/g, render: (m, k) => [m[1], <a key={k} href={m[2]} target="_blank" rel="noreferrer noopener">{m[2]}</a>] },
  // 【...】 counts as emphasis too — english-logic:allow (the CJK brackets ARE the subject here)
  { re: /【([^】]{2,20})】/g, render: (m, k) => <strong key={k} className="badge-strong">{m[1]}</strong> },
];

/** Inline rendering: the input is plain text, the output is an array of React nodes */
function renderInline(text, keyPrefix = 'i') {
  let nodes = [text];
  let step = 0;

  for (const { re, render } of INLINE) {
    const next = [];
    nodes.forEach((node, ni) => {
      if (typeof node !== 'string') {
        next.push(node);
        return;
      }
      let last = 0;
      const src = node;
      src.replace(re, (...args) => {
        const m = args.slice(0, -2);
        const idx = args[args.length - 2];
        if (idx > last) next.push(src.slice(last, idx));
        const rendered = render(m, `${keyPrefix}-${step++}-${ni}`);
        if (Array.isArray(rendered)) next.push(...rendered);
        else next.push(rendered);
        last = idx + m[0].length;
        return '';
      });
      if (last < src.length) next.push(src.slice(last));
    });
    nodes = next;
  }

  // Alarm keywords are highlighted in the front end at the rendering layer; the server does not care
  return nodes;
}

const IMG_RE = /^!\[([^\]]*)\]\((https?:[^)\s]+)\)$/;

/**
 * Inline Markdown (**bold** / `code` / links / 【emphasis】), producing **no block-level elements**.
 * english-logic:allow — the CJK emphasis brackets are the thing being described.
 *
 * Use case: hint sentences in the UI (`.hint`) contain emphasis written as `**browser**`, but they
 * used to be rendered as plain text — so the user saw a row of asterisks (measured: 0 <strong> in
 * `.hint`, 3 literal `**`). A hint is a single sentence and needs no <p> wrapper, so only inline
 * styles are allowed through.
 */
export function Inline({ text }) {
  return <>{renderInline(String(text ?? ''))}</>;
}

/**
 * Render Markdown into React elements.
 * Supports: # headings / lists / tables / quotes / horizontal rules / code blocks / images / inline styles
 */
export function Markdown({ text, className, highlight = [] }) {
  const src = String(text ?? '');
  const lines = src.split(/\r?\n/);
  const blocks = [];
  let i = 0;
  let key = 0;

  const hl = (nodes) => {
    if (!highlight.length) return nodes;
    const out = [];
    const walk = (n) => {
      if (typeof n === 'string') {
        let parts = [n];
        for (const kw of highlight) {
          const nextParts = [];
          for (const p of parts) {
            if (typeof p !== 'string') {
              nextParts.push(p);
              continue;
            }
            const idx = p.toLowerCase().indexOf(String(kw).toLowerCase());
            if (idx === -1) {
              nextParts.push(p);
              continue;
            }
            nextParts.push(p.slice(0, idx), <mark key={`hl-${key++}`}>{p.slice(idx, idx + String(kw).length)}</mark>, p.slice(idx + String(kw).length));
          }
          parts = nextParts;
        }
        out.push(...parts);
      } else if (Array.isArray(n)) n.forEach(walk);
      else if (React.isValidElement(n)) out.push(n);
      else if (n !== null && n !== undefined && n !== false) out.push(String(n));
    };
    nodes.forEach(walk);
    return out;
  };

  while (i < lines.length) {
    const line = lines[i];

    // code block
    if (/^\s*```/.test(line)) {
      const buf = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) buf.push(lines[i++]);
      i++;
      blocks.push(
        <pre className="md-code" key={key++}>
          <code>{buf.join('\n')}</code>
        </pre>
      );
      continue;
    }

    // table
    if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1])) {
      const head = line.trim().slice(1, -1).split('|').map((c) => c.trim());
      i += 2;
      const rows = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) {
        rows.push(lines[i].trim().slice(1, -1).split('|').map((c) => c.trim()));
        i++;
      }
      blocks.push(
        <table className="md-table" key={key++}>
          <thead>
            <tr>{head.map((h, x) => <th key={x}>{hl(renderInline(h))}</th>)}</tr>
          </thead>
          <tbody>
            {rows.map((r, y) => (
              <tr key={y}>{r.map((c, x) => <td key={x}>{hl(renderInline(c))}</td>)}</tr>
            ))}
          </tbody>
        </table>
      );
      continue;
    }

    // heading
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      const Tag = `h${Math.min(6, h[1].length)}`;
      blocks.push(<Tag key={key++}>{hl(renderInline(h[2]))}</Tag>);
      i++;
      continue;
    }

    // horizontal rule
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      blocks.push(<hr key={key++} />);
      i++;
      continue;
    }

    // blockquote
    if (/^\s*>\s?/.test(line)) {
      const buf = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) buf.push(lines[i++].replace(/^\s*>\s?/, ''));
      blocks.push(<blockquote key={key++}>{hl(renderInline(buf.join('\n')))}</blockquote>);
      continue;
    }

    // list (one level of nesting included)
    if (/^\s*([-*+]|\d+\.)\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*([-*+]|\d+\.)\s+/.test(lines[i])) {
        const indent = /^\s*/.exec(lines[i])[0].length;
        items.push({ text: lines[i].replace(/^\s*([-*+]|\d+\.)\s+/, ''), indent });
        i++;
      }
      blocks.push(
        <ul className="md-list" key={key++}>
          {items.map((it, x) => (
            <li key={x} style={it.indent >= 2 ? { marginLeft: 18 } : undefined}>
              {hl(renderInline(it.text))}
            </li>
          ))}
        </ul>
      );
      continue;
    }

    // an image on its own line
    const img = IMG_RE.exec(line.trim());
    if (img) {
      blocks.push(
        <figure className="md-figure" key={key++}>
          <img src={img[2]} alt={img[1]} referrerPolicy="no-referrer" loading="lazy" />
          {img[1] ? <figcaption>{img[1]}</figcaption> : null}
        </figure>
      );
      i++;
      continue;
    }

    // blank line
    if (!line.trim()) {
      i++;
      continue;
    }

    // paragraph
    const buf = [line];
    i++;
    while (i < lines.length && lines[i].trim() && !/^(#{1,6}\s|\s*[-*+]\s|\s*\d+\.\s|>\s?|\||\s*```)/.test(lines[i])) {
      buf.push(lines[i++]);
    }
    blocks.push(<p key={key++}>{hl(renderInline(buf.join('\n')))}</p>);
  }

  return <div className={className ? `md ${className}` : 'md'}>{blocks}</div>;
}

export default Markdown;
