// layout.js — 排版配置 → CSS 变量 / class
// 用户可 DIY：呈现方式、列数、密度、字号缩放、主题色、显示哪些字段。
// 单独放一个模块，避免 App 与各页面互相 import 造成循环依赖。

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

/** 把配置写成 CSS 变量，整站立刻生效 */
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
