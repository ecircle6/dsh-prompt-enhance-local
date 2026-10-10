/**
 * Host-half unit tests: prompt composition, fence stripping, origin fence,
 * rate limiter.
 *
 * Runs on the compiled `lib/` output (`npm run build` first — CI orders build
 * before test), using only the Node built-in test runner so the package keeps a
 * single runtime dependency (schemastery).
 *
 * Includes a regression test for the upstream audit finding: the original
 * `startsWith('localhost')` Origin check accepted `http://localhost.evil.com`.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { buildSystemPrompt, createRateLimiter, originAllowed, stripFence, apply } from '../lib/index.js'

test('buildSystemPrompt: default style is structured and carries the rewrite rules', () => {
  const prompt = buildSystemPrompt('structured')
  assert.match(prompt, /提示词改写器/)
  assert.match(prompt, /保留原始意图/)
  assert.match(prompt, /目标、范围、产出、约束、验收/)
})

test('buildSystemPrompt: every style resolves to its own instruction', () => {
  const styles = ['default', 'concise', 'detailed', 'constraints', 'structured']
  const seen = new Set(styles.map((style) => buildSystemPrompt(style)))
  assert.equal(seen.size, styles.length)
})

test('buildSystemPrompt: an unknown style falls back to default', () => {
  assert.equal(buildSystemPrompt('nope'), buildSystemPrompt('default'))
})

test('stripFence: removes one wrapping code fence and keeps inner text', () => {
  assert.equal(stripFence('```\nhello\n```'), 'hello')
  assert.equal(stripFence('```markdown\nhello\n```'), 'hello')
  assert.equal(stripFence('  hello  '), 'hello')
})

test('originAllowed: an Origin header is now required (upstream allowed headerless requests)', () => {
  assert.equal(originAllowed({ headers: {} }), false)
})

test('originAllowed: exact loopback and same-host origins pass', () => {
  assert.equal(originAllowed({ headers: { origin: 'http://127.0.0.1:3080', host: '127.0.0.1:3080' } }), true)
  assert.equal(originAllowed({ headers: { origin: 'http://localhost:3080', host: '127.0.0.1:3080' } }), true)
  assert.equal(originAllowed({ headers: { origin: 'http://[::1]:3080', host: '127.0.0.1:3080' } }), true)
  // Same-host deployment (page served on a LAN address, accessed from there):
  assert.equal(originAllowed({ headers: { origin: 'http://192.168.31.8:3080', host: '192.168.31.8:3080' } }), true)
})

test('originAllowed: subdomain spoofing is rejected (audit regression)', () => {
  assert.equal(originAllowed({ headers: { origin: 'http://localhost.evil.com', host: '127.0.0.1:3080' } }), false)
  assert.equal(originAllowed({ headers: { origin: 'http://127.0.0.1.evil.com', host: '127.0.0.1:3080' } }), false)
  assert.equal(originAllowed({ headers: { origin: 'https://evil.example.com', host: '127.0.0.1:3080' } }), false)
  assert.equal(originAllowed({ headers: { origin: 'not-a-url', host: '127.0.0.1:3080' } }), false)
  assert.equal(originAllowed({ headers: { origin: 'null', host: '127.0.0.1:3080' } }), false)
  // Even a loopback Origin is rejected when the browser labels the fetch cross-site:
  assert.equal(originAllowed({ headers: { origin: 'http://127.0.0.1:3080', host: '127.0.0.1:3080', 'sec-fetch-site': 'cross-site' } }), false)
  // …while a normal same-origin browser fetch (which sends the header) passes:
  assert.equal(originAllowed({ headers: { origin: 'http://127.0.0.1:3080', host: '127.0.0.1:3080', 'sec-fetch-site': 'same-origin' } }), true)
})

test('createRateLimiter: caps bursts and resets after the window', () => {
  let clock = 0
  const limiter = createRateLimiter({ limit: 3, windowMs: 1000, now: () => clock })
  assert.equal(limiter.allow(), true)
  assert.equal(limiter.allow(), true)
  assert.equal(limiter.allow(), true)
  assert.equal(limiter.allow(), false)
  clock = 999
  assert.equal(limiter.allow(), false)
  clock = 1000
  assert.equal(limiter.allow(), true)
})

/* ------------------------------------------------------------------ apply --
 * The host settings API changed shape between harness generations: a namespace
 * `settings.register(...)` scope on older hosts, the Loader row's own config on
 * newer ones. `apply` must mount on every shape and read whichever exists —
 * mounting used to throw outright where `settings.register` was gone.
 */

/** Minimal host context: records the route, answers `get('settings')`, runs effects. */
function hostContext(settingsService) {
  const routes = []
  const ctx = {
    get: (name) => (name === 'settings' ? settingsService : undefined),
    effect: (callback) => { callback(); return () => {} },
    on: () => () => {},
    llm: { stream: () => { throw new Error('llm.stream must not be reached in these tests') } },
    webServer: {
      register: (route) => { routes.push(route); return () => {} },
    },
  }
  return { ctx, routes }
}

/** Drive the registered route with one same-origin POST and return status plus body. */
async function post(routes, body) {
  const route = routes[0]
  const chunks = [Buffer.from(JSON.stringify(body))]
  const req = {
    method: 'POST',
    headers: { origin: 'http://127.0.0.1:3080', host: '127.0.0.1:3080', 'sec-fetch-site': 'same-origin' },
    async *[Symbol.asyncIterator]() { for (const chunk of chunks) yield chunk },
  }
  let status = 0
  let payload
  const res = {
    headersSent: false,
    writeHead(code) { status = code; this.headersSent = true },
    end(text) { payload = JSON.parse(text) },
    destroy() {},
  }
  await route.handler(req, res)
  return { status, payload }
}

test('apply: mounts with no settings service at all and reads the Loader row config', async () => {
  const { ctx, routes } = hostContext(undefined)
  apply(ctx, { enabled: false })
  assert.equal(routes.length, 1)
  const { status, payload } = await post(routes, { sessionId: 's', draft: 'x' })
  assert.equal(status, 403)
  assert.match(payload.error, /设置中关闭/)
})

test('apply: a settings service without register (newer host) falls back to the row config', async () => {
  const { ctx, routes } = hostContext({ describe: () => [], mutate: async () => {} })
  apply(ctx, { enabled: false })
  const { status, payload } = await post(routes, { sessionId: 's', draft: 'x' })
  assert.equal(status, 403)
  assert.match(payload.error, /设置中关闭/)
})

test('apply: a namespace settings scope (older host) outranks the row config', async () => {
  const calls = []
  const settingsService = {
    register: (namespace, schema) => {
      calls.push({ namespace, schema })
      return { get: () => ({ enabled: false }) }
    },
  }
  const { ctx, routes } = hostContext(settingsService)
  apply(ctx, { enabled: true })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].namespace, 'prompt-enhance-local')
  const { status, payload } = await post(routes, { sessionId: 's', draft: 'x' })
  assert.equal(status, 403)
  assert.match(payload.error, /设置中关闭/)
})

test('apply: a host refusing the namespace binding still serves the row config', async () => {
  const settingsService = {
    register: () => { throw new Error('namespace binding is not supported here') },
  }
  const { ctx, routes } = hostContext(settingsService)
  apply(ctx, { enabled: false })
  const { status, payload } = await post(routes, { sessionId: 's', draft: 'x' })
  assert.equal(status, 403)
  assert.match(payload.error, /设置中关闭/)
})

test('apply: no configuration anywhere serves the shipped defaults', async () => {
  const { ctx, routes } = hostContext(undefined)
  apply(ctx)
  // Defaults enable the feature, so the request proceeds past the enable gate and
  // fails later for the missing model route — proof the defaults were read.
  const { status, payload } = await post(routes, { sessionId: 's', draft: 'x' })
  assert.equal(status, 503)
  assert.match(payload.error, /模型路由/)
})
