// routes/share.js — the share endpoints, moved out of the factory.
//
// Same shape as routes/calendar.js: a registrar that receives the live configuration, the one place that
// persists a patch of it and the logger, and imports everything else from the module that owns it. The handlers
// are moved verbatim - the commit that added this file carries the traversals that prove it, not the diff size.
import { openArchive, queryItems } from '../archive.js';
import { todayIn } from '../day.js';
import { annotateItems } from '../people.js';
import { latestIntel } from '../reports.js';
import { IMAGE_COUNT_LABEL, IMAGE_MODES, LOGIN_KINDS, accountsForTarget, appendAudit, applyShareSettings, buildBundle, buildHandoff, bundleFilename, checkLoginState, contentDisposition, guardPost, pickAccountId, readAudit as readShareAudit, renderBundle, renderSiteText, resolveLoginProbe, resolveSiteBody, shareImageSetting, siteProfileById, stagesReport, targetById, toPlainText, truncateForSite, verificationStore } from '../share.js';
import path from 'node:path';

/**
 * @param {import('express').Express} app
 * @param {{ getConfig: () => object, patchConfig: (cfg: object, patch: object) => object, log?: object }} ctx
 */
export function registerShareRoutes(app, { getConfig, patchConfig, log, busyGuard }) {
    // ── one-click sharing ────────────────────────────────────────────
    // The target registry and the per-site profiles live in share.js: every target states honestly what it
    // needs (account / verification / send) and which of those is missing; self-tested by tools/share-test.mjs
    // (single-file HTML with zero external references / the three stages / the per-site detection / the post
    // gates / the audit).
    //
    // `stages` is the shape the share page renders: three independent steps per site instead of one status,
    // because "which account", "is what the site needs satisfied" and "can it actually send" are answered by
    // three different things and collapsing them hides exactly the missing one.
    app.get('/api/share/targets', async (_req, res) => {
      const cfg = getConfig();
      // `accounts` is empty in this build: nothing here enumerates logins, so every posting site's account
      // stage says what it needs instead of listing candidates. The shape is unchanged, which is what lets a
      // caller that *has* credentials hand them in without this route having to change.
      const accounts = [];
      res.json({
        ok: true,
        targets: stagesReport(accounts, verificationStore(cfg), cfg),
        accounts: [],
        images: shareImageSetting(cfg),
        // The wording of the attachment setting travels with the setting itself, so the page renders it
        // instead of restating what each mode means (see IMAGE_MODES in share.js).
        imageModes: IMAGE_MODES,
        imageCountLabel: IMAGE_COUNT_LABEL,
        // The login kinds the add-site form may offer, each with what this build can measure for it
        loginKinds: LOGIN_KINDS,
      });
    });

    // "Check login state" for a posting site, on demand.
    //
    // This is the measurement that remains for every posting site: the read-only cookie probe for the site's
    // own host -- a real answer to "is there a session cookie here?", which is exactly the question a person
    // about to paste a post in by hand is asking. It stores nothing, because a login state is not a
    // verification result, and it never reports a pass it did not measure. A site that declares a probe of its
    // own says so instead of being silently probed with something else (see resolveLoginProbe in share.js).
    //
    // The in-flight guard is the same discipline the other long operations use: reading a cookie store copies a
    // SQLite database and unwraps DPAPI, so a second click (or a second tab) is not a retry, it is the same
    // work done twice.
    app.get('/api/share/check-login', busyGuard('share login check'), async (req, res) => {
      const cfg = getConfig();
      const target = String(req.query.target ?? '');
      if (!targetById(target, cfg)) return res.status(400).json({ ok: false, error: `unknown target: ${target}` });
      const r = await checkLoginState(cfg, target, { accountId: String(req.query.account ?? '') || null });
      res.json(r);
    });

    /** collect items by scope: latest / day / person */
    function collectScope(cfg, scope = {}) {
      const kind = scope.kind ?? 'latest';
      if (kind === 'person') {
        const items = latestIntel(cfg, Number(scope.limit ?? 500)).items ?? [];
        const picked = annotateItems(items, cfg.people ?? []).items.filter((i) => (i.people ?? []).includes(scope.id));
        const person = (cfg.people ?? []).find((p) => p.id === scope.id);
        return {
          items: picked,
          title: `${person?.name ?? scope.id} 的情报`,
          subtitle: person?.agency ?? '',
          contentDate: todayIn(cfg),
        };
      }
      if (kind === 'day') {
        const day = String(scope.id ?? '').slice(0, 10);
        let db = null;
        try {
          db = openArchive(cfg);
          const rows = queryItems(db, { day, limit: 500 });
          // if the archive has this day, use it — even when the raw intel has since been overwritten by a later run
          if (rows.length) return { items: rows, title: `Vtuber 情报 ${day}`, subtitle: '', contentDate: day };
        } catch {
          /* the archive is unavailable, fall back to the raw intel */
        } finally {
          try {
            db?.close();
          } catch {
            /* ignore */
          }
        }
        const data = latestIntel(cfg, 500);
        return { items: data.items ?? [], title: `Vtuber 情报 ${day}`, subtitle: '', contentDate: day };
      }
      const data = latestIntel(cfg, Number(scope.limit ?? 500));
      return { items: data.items ?? [], title: 'Vtuber 情报分享', subtitle: '', contentDate: data.date ?? null };
    }

    // build the share bundle (returns a file download; format=text returns plain text to copy)
    // The image attachment is part of the request now (it used to be "whatever the items happened to carry,
    // up to four"): the setting decides the mode and the count, and the bundle reports what was attached and
    // what was left out instead of dropping images quietly.
    app.post('/api/share/bundle', (req, res) => {
      const cfg = getConfig();
      const format = String(req.body?.format ?? cfg.share?.defaultFormat ?? 'html');
      const scope = collectScope(cfg, req.body?.scope ?? {});
      const images = req.body?.images ? { ...shareImageSetting(cfg), ...req.body.images } : shareImageSetting(cfg);
      const bundle = buildBundle({
        ...scope,
        scopeKind: req.body?.scope?.kind ?? 'latest',
        note: String(req.body?.note ?? '').slice(0, 300),
        images,
      });
      // A per-site download carries the body that site would actually use -- the person's edit when there is
      // one. It is the plain-text form (that is what the hand-off downloads), so the file is exactly the text
      // on the clipboard rather than a re-rendered report of it.
      const sent = req.body?.text;
      if (format === 'text' && sent !== undefined && sent !== null) {
        const body = String(sent);
        appendAudit(cfg, { action: 'bundle', scope: bundle.scope, format, items: bundle.items.length, chars: body.length, textSource: 'edited' });
        res.setHeader('content-disposition', contentDisposition(bundleFilename(bundle, 'txt')));
        return res.type('text/plain; charset=utf-8').send(body);
      }
      const out = renderBundle(bundle, format);
      appendAudit(cfg, {
        action: 'bundle',
        scope: bundle.scope,
        format,
        items: bundle.items.length,
        images: bundle.images?.attached ?? 0,
        imageMode: bundle.images?.mode ?? 'none',
      });
      if (format === 'text') {
        return res.json({ ok: true, text: out.body, items: bundle.items.length, title: bundle.title, images: bundle.images });
      }
      // the filename may contain Chinese → it must go through RFC 5987 encoding, otherwise the HTTP header throws ERR_INVALID_CHAR
      res.setHeader('content-disposition', contentDisposition(bundleFilename(bundle, out.ext)));
      res.type(out.mime).send(out.body);
    });

    app.get('/api/share/audit', (_req, res) => res.json({ ok: true, entries: readShareAudit(getConfig(), 50) }));

    // The body a site would carry, plus the accounts that could carry it.
    //
    // Why a route of its own: the per-site body is not the page's plain-text version -- it is cut to the site's
    // own limit, and the chooser needs to see which accounts satisfy that site's declared requirements before one
    // of them is picked. Both answers come from the same profile, so they are served together.
    app.post('/api/share/prepare', busyGuard('share prepare'), async (req, res) => {
      const cfg = getConfig();
      const targetId = String(req.body?.target ?? '');
      if (!targetById(targetId, cfg)) return res.status(400).json({ ok: false, error: `unknown target: ${targetId}` });
      // No credential is looked up (nothing in this build enumerates logins), so the account list of every
      // site comes back empty and the account stage reports what the site needs. The fields stay because they
      // are the shape a caller with credentials gets.
      const accounts = [];
      const scope = collectScope(cfg, req.body?.scope ?? {});
      const bundle = buildBundle({
        ...scope,
        scopeKind: req.body?.scope?.kind ?? 'latest',
        images: shareImageSetting(cfg),
      });
      const profile = siteProfileById(targetId, cfg);
      const text = renderSiteText(bundle);
      const whole = truncateForSite(text, profile?.textLimit);
      // The body this site would carry, resolved by the one implementation that also decides what an edited
      // body does (see resolveSiteBody): the page seeds its editable box with `text`, and `bodySource` says
      // whether that text is the app's prepared starting point or the person's own edit.
      const perSite = resolveSiteBody({ text: req.body?.text ?? null, bundle, profile });
      // Reporting both lengths keeps the "prepared" body from quietly being the wrong one of the pair: the
      // site's own ceiling answers "what one post may carry", the setting answers "how much this build sends".
      res.json({
        ok: true,
        target: targetId,
        text: perSite.text,
        textSource: perSite.source,
        preparedText: perSite.prepared,
        textLength: perSite.length,
        over: perSite.over,
        fits: perSite.fits,
        truncated: perSite.truncated,
        droppedLines: perSite.droppedLines,
        textLimit: profile?.textLimit ?? null,
        wholeLength: text.length,
        wholeTruncated: whole.truncated,
        images: { mode: shareImageSetting(cfg).mode, limit: profile?.maxImages ?? 0, attached: bundle.images?.attached ?? 0 },
        accounts: accountsForTarget(targetId, accounts, cfg),
        accountId: pickAccountId(targetId, accounts, cfg),
        site: profile
          ? {
              credential: profile.credential,
              requirements: profile.requirements,
              textLimit: profile.textLimit,
              maxImages: profile.maxImages,
              probe: profile.verify,
              implemented: profile.implemented,
            }
          : null,
      });
    });

    // The hand-off for a site this app cannot post to.
    //
    // Everything here is prepared and nothing is sent: the body comes back cut to the site's limit, the compose
    // link is returned only when the whole body fits (a truncated compose box is how half a post gets published),
    // and the copy/download path is what covers the rest. The audit records a **manual** step, never a post --
    // this program did not post there, and no line of it may read as if it did.
    app.post('/api/share/handoff', busyGuard('share handoff'), async (req, res) => {
      const cfg = getConfig();
      const targetId = String(req.body?.target ?? '');
      if (!targetById(targetId, cfg)) return res.status(400).json({ ok: false, error: `unknown target: ${targetId}` });
      const accounts = [];
      const scope = collectScope(cfg, req.body?.scope ?? {});
      const bundle = buildBundle({
        ...scope,
        scopeKind: req.body?.scope?.kind ?? 'latest',
        images: shareImageSetting(cfg),
      });
      const h = buildHandoff({
        targetId,
        bundle,
        cfg,
        accountId: req.body?.accountId ?? pickAccountId(targetId, accounts, cfg),
        // The edited body, when the page sends one. It is the text the person will actually paste, so it is
        // the text the compose link is measured against and the text the copy path carries.
        text: req.body?.text ?? null,
      });
      if (!h.ok) return res.status(400).json(h);
      // record the hand-off only when the page says a person is taking it from here (pressing the compose or copy
      // button); a preview must not fill the log with clicks that never happened
      if (req.body?.handoff === true) {
        let host = null;
        try {
          host = h.composeUrl ? new URL(h.composeUrl).host : null;
        } catch {
          host = null;
        }
        appendAudit(cfg, {
          action: 'manual',
          target: targetId,
          host,
          chars: h.textLength,
          textLimit: h.textLimit,
          truncated: h.truncated,
          // Whether the hand-off carried the app's prepared text or the person's own edit. Two different
          // things happened, and an audit that cannot tell them apart cannot answer "what did I paste?".
          textSource: h.textSource,
          images: h.images?.mode ?? 'none',
          ok: true,
        });
      }
      res.json({ ...h, accounts: accountsForTarget(targetId, accounts, cfg) });
    });

    // Changing what the share page can change.
    //
    // Three things live here and all three are settings a person owns: the image attachment, which account a
    // target uses, and the sites they added by hand. The route writes the config (so the choice survives a
    // reload) and answers with the settings as they now stand, rather than with "ok" -- a partial write that
    // silently kept the old value is exactly the failure a settings form cannot show.
    app.patch('/api/share/settings', (req, res) => {
      const cfg = getConfig();
      // A hand-added site entry accepts free-form keys, so this body is one more place a secret can arrive;
      // the mask rule is applied to whatever it carries (see preserveSecretsIn).
      const body = preserveSecretsIn(req.body ?? {});
      const patch = {
        images: body.images,
        accounts: body.accounts,
        sites: body.sites,
        removeSites: body.removeSites,
      };
      const next = applyShareSettings(cfg, patch);
      const saved = patchConfig(cfg, { share: next.share });
      res.json({
        ok: true,
        images: shareImageSetting(saved),
        accounts: saved.share?.accounts ?? {},
        sites: saved.share?.sites ?? [],
        sitesError: next.sitesError ?? null,
      });
    });

    // speaking in public: confirmation + all three stages + a trail are required (see share.js guardPost).
    //
    // No site in this build publishes automatically, so every call today is refused by the guard with "there is
    // no publish code for this site yet". The route is kept because the refusal is the honest answer and the
    // gate is the shape a real implementation has to pass through: confirm -> three stages -> audit. Deleting
    // it would delete the discipline along with the feature.
    app.post('/api/share/post', async (req, res) => {
      const cfg = getConfig();
      const target = String(req.body?.target ?? '');
      const store = verificationStore(cfg);
      const accountId = String(req.body?.accountId ?? '') || null;
      // No credential is read: nothing in this build enumerates logins, and a post decided on a login state
      // this build cannot see would be a guess. The guard below is what refuses; the accounts list is empty.
      const accounts = [];

      // Autofill: with no text given, the post body comes from the bundle of the chosen scope. Plain text only,
      // and images are only attached when the setting asks for them **and** the site profile allows at least
      // one -- a planned site must not silently gain images.
      //
      // A text the page **did** send is used exactly as sent, including an emptied box: it is the text a person
      // edited and is about to publish under their own name, so replacing it with the app's prepared report (the
      // old truthiness test did exactly that for an empty body) is not this side's decision to make.
      let body = String(req.body?.text ?? '').trim();
      let bodySource = req.body?.text !== undefined && req.body?.text !== null ? 'edited' : 'prepared';
      let images = 0;
      if (!body && bodySource === 'prepared' && req.body?.scope) {
        const scope = collectScope(cfg, req.body.scope);
        const bundle = buildBundle({
          ...scope,
          scopeKind: req.body.scope.kind ?? 'latest',
          images: shareImageSetting(cfg),
        });
        body = toPlainText(bundle);
        images = bundle.images?.attached ?? 0;
      }
      const g = guardPost(cfg, { target, accounts, verified: store, text: body, confirm: req.body?.confirm === true, accountId });
      if (!g.ok) {
        appendAudit(cfg, { action: 'post-refused', target, error: g.error, status: g.status ?? null });
        return res.status(400).json({ ok: false, error: g.error, status: g.status ?? null });
      }

      // Unreachable while no site declares `implemented: true`, and deliberately not a stub that reports
      // success: a caller that ever gets here without a publish code must be told so.
      const result = { ok: false, error: '尚未实现该目标' };
      appendAudit(cfg, {
        action: 'post',
        target,
        ok: false,
        error: result.error,
        chars: g.body.length,
        textSource: bodySource,
        images,
        account: null,
      });
      res.json({ ok: false, error: result.error, account: null, images });
    });
}
