/**
 * Host-half unit tests: prompt composition, fence stripping, origin fence.
 *
 * Runs on the compiled `lib/` output (`npm run build` first — CI orders build
 * before test), using only the Node built-in test runner so the package keeps a
 * single runtime dependency (schemastery).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { buildSystemPrompt, sameOriginAllowed, stripFence } from '../lib/index.js'

test('buildSystemPrompt: built-in default carries the rewrite rules', () => {
  const prompt = buildSystemPrompt('default', '')
  assert.match(prompt, /提示词改写器/)
  assert.match(prompt, /保留原始意图/)
})

test('buildSystemPrompt: every style resolves to its own instruction', () => {
  const styles = ['default', 'concise', 'detailed', 'constraints', 'structured']
  const seen = new Set(styles.map((style) => buildSystemPrompt(style, '')))
  assert.equal(seen.size, styles.length)
})

test('buildSystemPrompt: an unknown style falls back to default', () => {
  assert.equal(buildSystemPrompt('nope', ''), buildSystemPrompt('default', ''))
})

test('buildSystemPrompt: a custom template overrides the built-in prompt', () => {
  assert.equal(buildSystemPrompt('structured', '  只做这一件事  '), '  只做这一件事  ')
})

test('stripFence: removes one wrapping code fence and keeps inner text', () => {
  assert.equal(stripFence('```\nhello\n```'), 'hello')
  assert.equal(stripFence('```markdown\nhello\n```'), 'hello')
  assert.equal(stripFence('  hello  '), 'hello')
})

test('sameOriginAllowed: same host or loopback passes, other origins do not', () => {
  assert.equal(sameOriginAllowed({ headers: {} }), true)
  assert.equal(sameOriginAllowed({ headers: { origin: 'http://127.0.0.1:3080', host: '127.0.0.1:3080' } }), true)
  assert.equal(sameOriginAllowed({ headers: { origin: 'http://localhost:9999' } }), true)
  assert.equal(sameOriginAllowed({ headers: { origin: 'https://evil.example.com' } }), false)
  assert.equal(sameOriginAllowed({ headers: { origin: 'not-a-url' } }), false)
})
