// Collapsible.jsx — a collapsible block that starts closed
//
// Why it exists: it was called out explicitly - "every proxy-node probe drags the whole list out, it takes up a lot of room".
// The information that fits on one screen is a limited resource, so "long lists / secondary options" start collapsed,
// leaving only a one-line summary that says what is inside, how many there are and the key value; open it when you want to look.
// The same idea is reused here for: proxy nodes, the LLM requirements table, source groups, the report export button group.
//
// Detail: the expanded state is remembered in localStorage (keyed by id), so "I like it expanded" only has to be said once.
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
      // In private mode localStorage may not be writable; it does not affect usability
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
