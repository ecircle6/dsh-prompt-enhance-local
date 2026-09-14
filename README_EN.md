# dsh-prompt-enhance

[![Download](https://img.shields.io/badge/Download-latest-2e7d32?style=flat&logo=github&logoColor=white)](https://github.com/zzy6-a/dsh-prompt-enhance/releases/latest)
[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![dsh-plugin](https://img.shields.io/badge/topic-dsh--plugin-2f6fed)](https://github.com/topics/dsh-plugin)

**One-click prompt enhancement for the DSH composer.** Type a rough sentence, hit ✨ next to the model selector, and your wording comes back as a task brief with a clear goal and the missing details filled in — with one-click undo.

Prompts for coding agents usually fail on what was *not* said: what to change, what to leave alone, what the deliverable is, how "done" is judged. This plugin turns that into a single click, using **the model you are already talking to** and nothing else.

## Features

| | |
|---|---|
| ✨ **Enhance** | Reads the draft → fills in goal / scope / deliverable / constraints / acceptance → replaces the draft |
| ↩ **Undo** | The undo button stays available until you edit the draft yourself |
| 🎛 **Five styles** | Fill in details (default) · Concise · Detailed · Add constraints · Structured |
| 🧭 **Model routing** | Follow the session model (default) or pin a cheap model for rewriting |
| 🧩 **Chip aware** | With `@file` references, `/commands` or skill chips in the draft the button greys out and explains why |
| 🪄 **Empty draft** | Grey out, or "derive a prompt from the recent conversation" |
| 🌏 **Bilingual** | UI copy follows the DSH language (zh / en) |

## Usage

1. Write whatever you have, e.g. `make the log page filter a dropdown`;
2. Click **✨** left of the model selector;
3. The button turns into `···`, then the draft is replaced by the rewritten prompt;
4. Not happy? Click **↩** to restore the original text.

> If the draft contains `@` file references, `/` commands or skill chips, ✨ stays disabled — on purpose: a whole-draft replace would downgrade those structured references to plain text.

## Settings

Settings → **Prompt enhance** (its own section in the sidebar, it does not take over another plugin's card).

| Setting | Options | Default |
|---|---|---|
| Enable the enhance button | on / off | on |
| Rewrite style | Fill in details / Concise / Detailed / Add constraints / Structured | Fill in details |
| Model | Follow the session / Fixed provider + model | Follow the session |
| Empty draft | Disable the button / Derive a prompt from the recent conversation | Disable the button |
| Custom system template | Empty = built-in style template; filled = overrides it completely | empty |

Values live in the host settings namespace `prompt-enhance` and apply immediately.

## How it works

```
composer draft ──POST /api/dsh-prompt-enhance/enhance──▶ host half
                                                            │
                      system = built-in style / custom template ◀┘
                                                            │
                                            ctx.llm.stream (one-shot call)
                                                            │
      rewritten prompt ◀──────── JSON ───────────────────────┘
                │
   inputActions.setDraft(text)  ← whole-draft replace (undoable)
```

- **One-shot model call**: a hand-built request that never enters the session log or the agent context — no conversation pollution, no prompt-prefix cache churn;
- **Route priority**: the fixed pair from settings → the session's most recent main-model call (captured off the `llm/stream` waterfall, auxiliary calls excluded) → the host default model;
- **The host half does three things**: compose the system prompt, call the model, strip a stray code fence. It stores no drafts.

### HTTP API

`POST /api/dsh-prompt-enhance/enhance`

```jsonc
// request
{ "sessionId": "session-…", "draft": "make the log page filter a dropdown" }

// success
{ "ok": true, "text": "…", "route": { "provider": "opencode-go", "model": "deepseek-flash" },
  "style": "default", "fromContext": false }

// failure
{ "ok": false, "error": "草稿为空" }
```

| Status | Meaning |
|---|---|
| 200 | Rewritten |
| 400 | Empty draft (and context mode off) |
| 403 | Disabled in settings, or an untrusted origin |
| 413 | Draft longer than 12000 characters |
| 422 | Empty draft + context mode, but no usable conversation context |
| 502 | Model call failed / returned nothing |
| 503 | No usable model route |

## Known limits

- **References are not preserved**: drafts with chips can only be greyed out. The current plugin-facing input surface exposes `setDraft` only (plain text, reference placeholders stripped); preserving references needs an upstream chip-aware write action on `InputActions`.
- **No button in a brand-new session**: `conversation.input.right` is a session-scoped seat and does not render without a session id.
- **It rewrites, it does not append**: the whole draft is replaced.
- A model may ignore the "no code fence" rule; the host strips one wrapping fence as a fallback.

## Install

### GitHub Release (current channel)

Grab `dsh-prompt-enhance-<version>.tgz` from the [latest release](https://github.com/zzy6-a/dsh-prompt-enhance/releases/latest):

```bash
cd ~/.dsh/profiles/web
npm i /path/to/dsh-prompt-enhance-0.1.0.tgz
# then add "dsh-prompt-enhance" to dsh.profile.bundles
```

### dshmarket

Search and install from the market once listed (see [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)).

### From source

```bash
git clone https://github.com/zzy6-a/dsh-prompt-enhance.git
cd dsh-prompt-enhance
npm install
npm run build
# mount it in your profile your own way (bundle patch: cordis.patch.yml)
```

## Requirements

- Node.js ≥ 22.19
- DSH ≥ `0.1.5-rc.1` (needs the `settings`, `sessions`, `llm` and `webServer` host services)
- A usable model route (session model or pinned in settings)

## Development

```bash
npm install        # four dev dependencies only (schemastery / @types/node / tsdown / typescript)
npm run build      # host: tsc → lib/; client: tsdown → lib/client.js
npm run typecheck
npm test           # node:test, six host-side unit tests
npm pack           # produces dsh-prompt-enhance-<version>.tgz
```

## Security & boundaries

- The route only serves same-origin / loopback callers (everything else: 403);
- 64 KB request cap, 12000-character draft cap, 90 s end-to-end deadline;
- No draft ever touches disk, nothing is written to the session log;
- The only network activity is sending your draft to the model route you configured.

## License

[MIT](LICENSE) © 2026 zzy6-a
