# The server's route layout

`server/src/server.js` is the application factory: it builds the Express app, installs the error boundary, the
static assets and the SPA fallback, and wires the route groups. It used to hold every handler as well. This note is
about what moved, what deliberately did not, and what to know before moving anything else.

## The shape of a group

Each moved group lives in `server/src/routes/<group>.js` and exports one registrar:

```js
export function registerArchiveRoutes(app, { getConfig, patchConfig, log }) { /* the handlers, unchanged */ }
```

- **the handlers move verbatim.** The commit that adds a module carries the traversals that prove it, not a diff
  size; a refactor and a behaviour change in one commit is the thing this layout exists to avoid.
- **the context is small and named.** By default `getConfig`, `patchConfig`, `log`. A group that needs anything
  else (`busyGuard`, `persist`, `onConfigChanged`) gets it named explicitly, on the registrar call *and* in the
  module's own destructuring - never by widening the default for every group.
- **the registrar is called where the block was**, so registration order is preserved.

**The split is complete.** All 45 groups live in `server/src/routes/`, and the factory registers **no `/api/*`
route of its own** - a property `tools/project-map-test.mjs` refuses to let regress. The nine groups that used
to be the whole story (`calendar`, `vdb`, `people`, `search`, `advice`, `egress`, `proxy`, `share`, `archive`)
were the first slices; the rest followed, the last of them by hand (see the two that resisted, below).

## What stays in the factory on purpose

The error boundary, the static assets, the SPA fallback, the request guard, and the two shared helpers that the
groups are *given* rather than own: `persist` (the config-write path, together with `onConfigChanged`) and
`busyGuard`. These are the parts that make the process a server rather than a set of handlers, and the split is
not finished when they move - it is broken. The health and state endpoints were once listed here too; they are
ordinary groups now, because the shell asks for them over the same HTTP surface a user does.

## Moving a group: the three rules, learned by breaking them

1. **A block is the group's first contiguous cluster.** Registrations are not always adjacent in the file;
   `/api/proxy/*` is scattered across it. Taking "everything between the first and the last matching route"
   produced a 777-line module holding 41 routes from every other group in between.
2. **A block ends before any top-level declaration the rest of the file also references.** That is how the `RANGES`
   table stayed in the factory while the archive handlers moved.
3. **The context is checked, not assumed.** A group that needs `busyGuard` or the config-write path must be given
   it deliberately.

## Two groups that resisted, and why that is useful to know

- **`/api/config` must not be moved mechanically.** With its GET/PATCH pair in a module and `onConfigChanged` +
  `persist` passed explicitly, the module parsed, the app started and the endpoint answered - and the traversals
  went red (84/86 endpoints, 29/40 flows against 86/86 and 40/40). Those handlers touch the factory's own write
  path and are registered before code that reads configuration state, so "the same handlers, one file over" is not
  the same program. It is a manual extraction with the ordering made explicit, or it is left alone.
- **`/api/events` moved cleanly and then failed only in the packaged UI walk** (which performs a real run first),
  while answering correctly from the source server against an empty config. The difference is runtime state, and
  the reproduction has to include the run step.

Both are recorded as findings (#99, #100, #101) in [BUGS.md](BUGS.md) rather than only in commit messages, and
both are **closed**. `/api/events` left the factory once the extraction learned to see a declaration written at
column 0; `/api/config` came out by hand with the ordering made explicit, and its health and transfer routes
followed in the same shape.

## Before moving the next one

Grep the tooling for checks that read `server/src/server.js` as *the* server: three existed, and moving a group
broke two of them (`integrity-check`'s login-guard check and `login-check-test`'s affordance-route check) before
they were widened to read `server/src/routes/*.js` too. Then, for every slice: ask the source server for the moved
route, rebuild the package, and run the three traversals (86 endpoints, 40 flows, 242 UI checks) before the gates.
