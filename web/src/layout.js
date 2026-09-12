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
