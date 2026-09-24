# dsh-prompt-enhance-local

[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

> A **hardened local fork** of [zzy6-a/dsh-prompt-enhance](https://github.com/zzy6-a/dsh-prompt-enhance) (MIT), line-audited, patched, and trimmed to a single job:
>
> **One-click prompt enhancement in the DSH composer** — type a rough sentence, click ✨, get back a structured, unambiguous prompt; one-click undo.

## What changed vs upstream (v0.2.0 onward)

**Security fixes**

1. Origin checks used `startsWith('localhost')`, so a page at `http://localhost.evil.com` could bypass the same-origin fence. Now `URL.hostname` must **exactly** match a loopback address or the request's `Host` (regression-tested).
2. Headerless requests were allowed. An `Origin` header is now **required**, and `sec-fetch-site` (when sent) must be `same-origin`.
3. Diagnostic logging wrote to `~/.dsh/super-injector/*.log`. **All file writes removed** — logging goes through the host `ctx.logger` only.

Plus a new in-memory rate limit (10 calls/min, fixed window, no dependencies) bounding header-forgery abuse. Residual risk is stated honestly: loopback HTTP has no real authentication (the DSH GUI has none either).

**Feature trim (core only)**

- ❌ "derive from recent conversation" mode → the plugin **never reads sessions**; hard deps down to three (`webServer`/`llm`/`settings`); empty drafts are always rejected
- ❌ Custom system-prompt template setting
- ❌ File logging
- ✅ Kept: ✨ enhance, ↩ undo, five rewrite styles, follow/pin model routing, master switch, chip-aware guard

## Usage

1. Write anything colloquial, e.g. `make the log page filter a dropdown`;
2. Click **✨** left of the model selector;
3. The button turns into `···`, then the draft is replaced by the rewritten prompt;
4. Click **↩** to restore the original text.

## Settings

Settings → **提示词增强**: enable switch · rewrite style (default **Structured**: goal / scope / deliverable / constraints / acceptance) · model routing (follow session or pin provider+model). Stored in the `prompt-enhance-local` settings namespace; changes apply immediately.

## Surviving harness updates

- **Minimal API surface**: three official seams only (`webServer.register` / `llm.stream` / `settings.register`) with local structural types; the build depends on `schemastery` alone.
- **Official extension points**: the official `conversation.input.right` slot and `inputActions.setDraft`; if the seat kit disappears, the plugin warns and skips rendering instead of breaking the profile.
- **Degraded routing chain**: pinned setting → session's last main-model route → host default model, each missing link returning a clear error code.
- **Upgrade canary** (run after every DSH update, under a minute, side-effect-free):

```bash
node scripts/verify.mjs          # 5 fence checks: 405 / 403 / 403 / 400 / 413
node scripts/verify.mjs --rate   # additionally exercise the rate limiter
```

Compatibility: DSH ≥ `0.1.5-rc.1` (verified locally 2026-09-24).

## Build and troubleshooting

```bash
npm run build   # host: scripts/build.sh (tsc); client: tsdown
```

Windows without bash — the two equivalent commands:

```powershell
node node_modules/typescript/bin/tsc -p tsconfig.json   # host → lib/index.js
node node_modules/tsdown/dist/run.mjs                   # client → lib/client.js
```

A host-half change needs a `dsh web` restart (the host imports it, nothing hot-reloads);
a client-half change only needs a page refresh — the host stat-polls `lib/client.js`
every 500ms and swaps the boot-graph entry revision itself.

If the whole GUI stops at `Failed to load plugins / <pkg>: import failed (see console
for the import error)`, the client bundle is registering under an id that differs from
the **package name**. The host sets every `dsh.client` boot entry's `id` to the owning
manifest's package name, and the browser Loader imports exactly that specifier, so a
factory registered under any other id can never be resolved. This repository derives the
registration id from `package.json#name` in `tsdown.config.ts`; `test/client-bundle.test.mjs`
asserts it, and `node scripts/probe-boot-graph.mjs` checks what a running host actually
serves (reads `/plugins/events`, read-only). If the host route answers `scripts/verify.mjs`
but the UI still fails, the problem is the client bundle.

## Security boundary

The only network behavior is sending your draft to your own configured model route; the fence rejects every foreign request; rate-limited; no disk writes, no session reads, no third-party endpoints, no `eval`, no dynamic loading.

## License

MIT © 2026 ecircle6 (this fork); upstream dsh-prompt-enhance © 2026 zzy6-a under MIT — see [LICENSE](LICENSE).
