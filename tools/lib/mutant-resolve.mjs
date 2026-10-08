// ---------------------------------------------------------------------------------------------------
// mutant-resolve.mjs — makes a whole copied tree of modules hang together, and rewrites the imports that
// reach a mutated module back to the copy.
//
// Why this exists. The mutation controls in tools/remote-url-test.mjs run this project's real code against a
// copy of `server/src` with exactly one line changed, and the copy only means something if the modules that
// *import the mutated one* load the copy. Without this hook they do not: `server/src/server.js` imports
// `./probe.js`, so a run that replaced only probe.js would still have the app calling the original through
// server.js, and the mutant would "fail to fail" for a reason that has nothing to do with the mutation — a
// control that proves nothing while looking green. (Measured while writing this: the probe mutant passed the
// very check it was supposed to break.)
//
// Two mechanisms, because there are two shapes of import:
//   · a module **inside** the copy is loaded through its sibling in the copy (the normal case: the whole app
//     graph came from the copy);
//   · a module **outside** it — the harness in tools/ — imports an app module by relative path, and that
//     import is pointed at the copy.
// Anything already inside the copy is then rewritten so its own relative imports to a *mutated sibling* read
// the copy rather than the original.
//
// The hook inlines the rewritten source with a `sourceURL` annotation, which is why `module.register()` can be
// used at all: the alternative, editing the copy's files, would leave several copies of `server/src` on disk
// and would make "which file did this run load" unanswerable. The lib form (a `resolve`/`load` module passed to
// `--import`) was tried first and does not work here: measured on Node 24, a `resolve` hook registered through
// `--import` is never called (a hook that logged every resolution stayed silent while the target imported
// server/src/remote-url.js successfully), while `module.register()` from the entry point works.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = String(process.env.VML_MUTANT_ROOT ?? '').trim();
const MIRROR = String(process.env.VML_MUTANT_MIRROR ?? '').trim();
// The mutated module's path inside the copy, e.g. `probe.js` or `fetchers/browser.js`.
const MUTANT_REL = String(process.env.VML_MUTANT_REL ?? '').trim();

const dirUrl = (p) => {
  const href = pathToFileURL(path.resolve(p)).href;
  return href.endsWith('/') ? href : href + '/';
};
const ROOT_URL = ROOT ? dirUrl(ROOT) : '';
const MIRROR_URL = MIRROR ? dirUrl(MIRROR) : '';

const isIn = (url, dir) => !!dir && String(url).startsWith(dir);

export async function resolve(specifier, context, nextResolve) {
  const resolved = await nextResolve(specifier, context);
  if (!ROOT_URL || !MIRROR_URL) return resolved;
  if (isIn(resolved.url, ROOT_URL)) return { ...resolved, url: MIRROR_URL + resolved.url.slice(ROOT_URL.length) };
  return resolved;
}

/** Read a module out of the copy (never out of the real tree — that is the point of the copy). */
function mirrorSource(url) {
  return fs.readFileSync(new URL(url).pathname.replace(/^\/([A-Za-z]:)/, '$1'), 'utf8');
}

export async function load(url, context, nextLoad) {
  if (!ROOT_URL || !MIRROR_URL || !MUTANT_REL || !isIn(url, MIRROR_URL)) return nextLoad(url, context);
  const mutantUrl = MIRROR_URL + MUTANT_REL.replace(/\\/g, '/');
  // Only a module that actually imports the mutated one needs rewriting; everything else loads as it is.
  let source = mirrorSource(url);
  const escaped = MUTANT_REL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const isMutant = url === mutantUrl;
  const importRe = new RegExp(`(from\\s*['"])(\\.{1,2}/[^'"]*${escaped.split('/').pop()})(['"])`, 'g');
  if (!isMutant && !importRe.test(source)) return nextLoad(url, context);
  importRe.lastIndex = 0;
  source = source.replace(importRe, (_m, a, _spec, c) => `${a}${mutantUrl}${c}`);
  return {
    format: 'module',
    source: `${source}\n//# sourceURL=${url}`,
    shortCircuit: true,
  };
}
