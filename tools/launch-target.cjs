// tools/launch-target.cjs - how to start one built package, whichever layout it is.
//
// ASCII only, CommonJS.
//
// Why this file exists: the traversals and two of the packaged-app tests used to build the path
// `<package>/<name>.exe` themselves and spawn it. That made every one of them a statement about
// **the SEA layout** rather than about the product, so a package that ships without the launcher
// binary (the `--no-exe` layout: `launcher/` plus a bundled `runtime/node.exe`) could not be
// traversed at all - the tool would report "exe not found" and there would be no way to tell that
// from "the package is broken".
//
// One package, two layouts:
//
//   exe layout        <pkg>/<name>.exe            + app/
//   launcher layout   <pkg>/launcher/launch.cjs   + app/ + runtime/node[.exe]
//
// Both are started the same way by the caller: take `cmd`, append `args`, then append the options
// the app itself understands (`--no-open --port <n>`). The launcher parses those too
// (see launcher/launch.cjs), so the two layouts really are one code path from here on.
//
// The launcher layout is resolved through the launcher script on purpose: that is the file a user
// double-clicks (launcher/launch.cmd), so traversing it verifies the thing that actually ships
// rather than a second, hand-written way of starting the same server.

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const EXE = process.platform === 'win32' ? '.exe' : '';

function exists(p) {
  try {
    return !!p && fs.existsSync(p);
  } catch {
    return false;
  }
}

/**
 * Resolve how to start the package in `dir`.
 *
 * Returns `{ kind, cmd, args, shown }`, or null when the directory cannot start an app at all.
 * A null answer is a real finding, so `launchCandidates` exists to name what was looked for.
 */
function resolveLaunch(dir) {
  const exe = path.join(dir, path.basename(dir) + EXE);
  if (exists(exe)) {
    return { kind: 'exe', cmd: exe, args: [], shown: exe };
  }
  const node = path.join(dir, 'runtime', 'node' + EXE);
  const launcher = path.join(dir, 'launcher', 'launch.cjs');
  const entry = path.join(dir, 'app', 'server', 'src', 'index.js');
  if (exists(node) && exists(launcher) && exists(entry)) {
    return { kind: 'launcher', cmd: node, args: [launcher], shown: node + ' ' + launcher };
  }
  return null;
}

/** The paths `resolveLaunch` looked for, in order, with which ones are present. */
function launchCandidates(dir) {
  const exe = path.join(dir, path.basename(dir) + EXE);
  const node = path.join(dir, 'runtime', 'node' + EXE);
  const launcher = path.join(dir, 'launcher', 'launch.cjs');
  const entry = path.join(dir, 'app', 'server', 'src', 'index.js');
  return [
    { what: 'launcher binary (exe layout)', path: exe, present: exists(exe) },
    { what: 'bundled runtime (launcher layout)', path: node, present: exists(node) },
    { what: 'launcher script (launcher layout)', path: launcher, present: exists(launcher) },
    { what: 'server entry (both layouts)', path: entry, present: exists(entry) },
  ];
}

module.exports = { resolveLaunch, launchCandidates };
