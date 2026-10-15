// routes/open.js — the open endpoints, moved out of the factory.
//
// Same shape as routes/calendar.js: a registrar that receives the live configuration, the one place that
// persists a patch of it and the logger, and imports everything else from the module that owns it. The handlers
// are moved verbatim - the commit that added this file carries the traversals that prove it, not the diff size.
import { openResolvedPath, openResultNote, resolveEditorCommand, resolveOpenPath } from '../openfile.js';
import path from 'node:path';

/**
 * @param {import('express').Express} app
 * @param {{ getConfig: () => object, patchConfig: (cfg: object, patch: object) => object, log?: object }} ctx
 */
export function registerOpenRoutes(app, { getConfig, patchConfig, log }) {
    // "Open this file in an editor" -- the app is local, so the person who generated a report can look at it
    // in the tool they actually use.
    //
    // This is the one endpoint in the app whose request names a file that is then handed to an external
    // program, so the request carries a **kind and an id** and the path is resolved here, from the app's own
    // output roots (see server/src/openfile.js for the three defences: a plain file name, a resolved-prefix
    // test, and a symlink test). The invocation is an argv array handed to execFile with `shell: false`, so no
    // file name can ever become command syntax. It is not a long operation and needs no in-flight guard: it
    // starts a program and returns.
    app.post('/api/open', (req, res) => {
      const cfg = getConfig();
      const kind = String(req.body?.kind ?? '');
      // A request that carries a path is refused by name rather than quietly ignored -- resolveOpenPath says so.
      const id = String(req.body?.id ?? req.body?.file ?? '');
      const r = resolveOpenPath(cfg, kind, id);
      if (!r.ok) return res.status(400).json({ ok: false, code: r.code, error: r.error });
      const editor = resolveEditorCommand(cfg.open?.editor);
      if (!editor.program) {
        return res.status(400).json({
          ok: false,
          code: 'no-editor',
          error: 'no editor found: install VS Code (the `code` command) or set an editor command in Settings',
          editor,
        });
      }
      const name = path.basename(r.path);
      openResolvedPath({ file: r.path, editor, displayName: name, platform: process.platform })
        .then((out) => {
          const note = openResultNote(out, editor);
          log?.[out.ok ? 'info' : 'warn'](`open ${kind}/${name}: ${note.en}`);
          res.status(out.ok ? 200 : 500).json({ ok: out.ok, code: out.code ?? null, error: out.error ?? null, kind, name, editor: { program: editor.program, source: editor.source }, command: out.command ?? editor.program, args: out.args ?? null, note });
        })
        .catch((e) => res.status(500).json({ ok: false, code: 'launch-failed', error: e.message }));
    });
}
