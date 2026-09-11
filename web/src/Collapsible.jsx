// Collapsible.jsx — 默认收起的折叠区块
//
// 为什么有它：被明确点出来过 ——「代理节点每次探测都把列表全部拉出来，很占地方」。
// 一屏能放的信息是有限的资源，把「长列表 / 次要选项」默认收起来，
// 只留一行摘要让人知道里面有什么、有多少、关键值是多少，想看再点开。
// 同一套思路在这里被复用到：代理节点、LLM 需求表、来源分组、报告的导出按钮组。
//
// 细节：展开状态记在 localStorage（按 id），所以「我习惯展开」这件事只需说一次。
import { useEffect, useState } from 'react';

const KEY = 'vml.collapsed.v1';

function readAll() {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '{}');
  } catch {
    return {};
  }
}

export function Collapsible({ id, title, summary, children, defaultOpen = false, count = null, right = null }) {
  const [open, setOpen] = useState(() => {
    const saved = readAll();
    return typeof saved[id] === 'boolean' ? saved[id] : defaultOpen;
  });

  useEffect(() => {
    const saved = readAll();
    saved[id] = open;
    try {
      localStorage.setItem(KEY, JSON.stringify(saved));
    } catch {
      // 隐私模式下 localStorage 可能不可写，不影响使用
    }
  }, [id, open]);

  return (
    <div className={'collapsible' + (open ? ' open' : '')}>
      <button className="collapsible-head" onClick={() => setOpen((v) => !v)} aria-expanded={open} aria-controls={`c-${id}`}>
        <span className="caret" aria-hidden="true">
          {open ? '▾' : '▸'}
        </span>
        <span className="ct">{title}</span>
        {count != null && <span className="badge none">{count}</span>}
        {summary && <span className="cs muted small">{summary}</span>}
        <span className="grow" />
        {right}
      </button>
      {open && (
        <div className="collapsible-body" id={`c-${id}`}>
          {children}
        </div>
      )}
    </div>
  );
}

export default Collapsible;
