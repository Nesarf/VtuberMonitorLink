// ---------------------------------------------------------------------------------------------------
// mutant-register.mjs — installs the mutation resolver hook.
//
// Why this is a separate file from the hook. Node's own documentation offers two ways to install a module
// hook: `module.register()` from inside the process, or a `--import`-ed module that exports `resolve`/`load`.
// The second one is the one that looks simpler, and it does not work here — measured on Node 24: a `--import`
// hook whose `resolve` logs every call stayed completely silent while the target module imported
// `server/src/remote-url.js` successfully, so the hook was never invoked and the mutants were never loaded.
// (The first attempt at this harness used it, and every mutant "passed".)
//
// So the hook is registered through `module.register()` from this entry point instead, which does work. This
// file is only ever started by the mutation harness in tools/remote-url-test.mjs; nothing in the product
// imports it, and with VML_MUTANT_ROOT unset it registers a hook that rewrites nothing.
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';

if (String(process.env.VML_MUTANT_ROOT ?? '').trim()) {
  register('./mutant-resolve.mjs', pathToFileURL(import.meta.filename));
}
