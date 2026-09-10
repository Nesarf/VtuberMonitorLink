// markdown.jsx — 自带的极简 Markdown 渲染器
//
// 为什么自己写而不用 marked / react-markdown：
//   1) 报告内容来自「抓到的网页 + LLM 输出」，是不可信文本。先整体转义、再只
//      放行我们自己生成的标签与 http(s) 图片地址，比引入一整条依赖链要可控；
//   2) 发行包要能离线构建，少一个依赖少一份供应链风险。
//   —— 因此：**任何原始 HTML 都当纯文本**，绝不做 dangerouslySetInnerHTML。
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
  // 裸 http(s) 链接
  { re: /(^|[\s(])(https?:\/\/[^\s<>")]+)/g, render: (m, k) => [m[1], <a key={k} href={m[2]} target="_blank" rel="noreferrer noopener">{m[2]}</a>] },
  // **必须** 也当强调
  { re: /【([^】]{2,20})】/g, render: (m, k) => <strong key={k} className="badge-strong">{m[1]}</strong> },
];

/** 行内渲染：输入是纯文本，输出是 React 节点数组 */
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

  // 高亮告警关键词（前端在渲染层做，服务端不用管）
  return nodes;
}

const IMG_RE = /^!\[([^\]]*)\]\((https?:[^)\s]+)\)$/;

/**
 * 把 Markdown 渲染成 React 元素。
 * 支持：# 标题 / 列表 / 表格 / 引用 / 分隔线 / 代码块 / 图片 / 行内样式
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

    // 代码块
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

    // 表格
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

    // 标题
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      const Tag = `h${Math.min(6, h[1].length)}`;
      blocks.push(<Tag key={key++}>{hl(renderInline(h[2]))}</Tag>);
      i++;
      continue;
    }

    // 分隔线
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      blocks.push(<hr key={key++} />);
      i++;
      continue;
    }

    // 引用
    if (/^\s*>\s?/.test(line)) {
      const buf = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) buf.push(lines[i++].replace(/^\s*>\s?/, ''));
      blocks.push(<blockquote key={key++}>{hl(renderInline(buf.join('\n')))}</blockquote>);
      continue;
    }

    // 列表（含嵌套一级）
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

    // 独占一行的图片
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

    // 空行
    if (!line.trim()) {
      i++;
      continue;
    }

    // 段落
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
