// layout.js — layout config → CSS variables / class
// User DIY-able: presentation mode, column count, density, font scaling, accent colour,
// which fields are shown.
// Kept in its own module so App and the individual pages don't import each other
// and create a circular dependency.

export const LAYOUT_MODES = ['cards', 'list', 'compact', 'timeline', 'table'];

export const DEFAULT_LAYOUT = {
  mode: 'cards',
  columns: 'auto',
  density: 'comfortable',
  fontScale: 1,
  showThumbs: true,
  showStats: true,
  showTime: true,
  showSource: true,
  accent: '',
};

export function normalizeLayout(layout) {
  return { ...DEFAULT_LAYOUT, ...(layout ?? {}) };
}

/** Write the config out as CSS variables — the whole site picks it up immediately */
export function applyLayout(layout) {
  const L = normalizeLayout(layout);
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  root.style.setProperty('--vml-cols', L.columns === 'auto' ? 'auto' : String(L.columns));
  root.style.setProperty('--vml-gap', L.density === 'compact' ? '8px' : '12px');
  root.style.setProperty('--vml-pad', L.density === 'compact' ? '10px' : '14px');
  root.style.setProperty('--vml-fs', String(L.fontScale));
  if (L.accent) root.style.setProperty('--vml-accent', L.accent);
  else root.style.removeProperty('--vml-accent');
  if (typeof document.body !== 'undefined') {
    document.body.style.fontSize = `${Number(L.fontScale ?? 1) * 14}px`;
  }
}

export function layoutClass(layout) {
  const mode = normalizeLayout(layout).mode;
  return mode === 'cards' ? 'cards' : `cards layout-${mode}`;
}

/**
 * Cross-tab navigation, as a DOM event.
 *
 * Why an event rather than a prop: switching tabs is the shell's state (App.jsx owns `tab`), and there is
 * exactly one reason to reach across pages right now — a login check that says "no profile dir is
 * configured" has to be able to offer the page that fills it in, whichever page the check was pressed on
 * (the share page is where the owner hit it). Threading a callback through five page components would put
 * navigation state into pages that otherwise have none, and the shell would still be the only place that can
 * really change it. This is the same shape the shell already uses to follow a layout change (`vml-layout`).
 */
export const GOTO_EVENT = 'vml-goto';

/** Ask the shell to show a tab. Returns false when there is nothing listening (a test render, an old shell). */
export function requestTab(id) {
  if (typeof window === 'undefined' || !id) return false;
  try {
    window.dispatchEvent(new CustomEvent(GOTO_EVENT, { detail: id }));
    return true;
  } catch {
    return false;
  }
}
