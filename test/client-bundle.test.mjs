/**
 * Client-bundle contract tests (the half that actually broke the Web GUI).
 *
 * The browser kernel resolves a plugin bundle through the *package name* of the
 * nearest owning `package.json` — `WebBootEntry.id` is the package name, and the
 * Loader imports exactly that specifier (`boot-client.ts` → `assertEntriesActive`
 * reports `"<pkg>: import failed"` when no factory is registered for it). A bundle
 * that registers `__ModuleLoader__.load({ id })` under any other id therefore
 * never resolves, the boot audit fails, and the whole GUI stops at
 * "Failed to load plugins".
 *
 * These tests load the *built* `lib/client.js` into a sandbox that mimics the
 * page globals, then drive the real registration + materialization protocol:
 *
 *   1. the bundle registers itself under the package name (id drift regression);
 *   2. it registers exactly once per `load()` (no double registration);
 *   3. the exported `apply` runs against a stub Cordis context that records the
 *      slots/settings registrations, without throwing;
 *   4. every bare specifier the bundle requires resolves against the platform
 *      module table baseline (`PLATFORM_MODULES`), so no hidden runtime request
 *      can fail at materialization time.
 *
 * Runs on the compiled `lib/` output (`npm run build` first).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { createContext, runInContext } from 'node:vm'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

/** Baseline shared modules the shell seeds for every dynamic bundle (`PLATFORM_MODULES`). */
const PLATFORM_MODULES = [
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-dockkit',
]

const require_ = createRequire(import.meta.url)

/** Minimal React stand-in: enough for `createElement`/hooks used at module scope. */
function fakeReact() {
  const createElement = (type, props, ...children) => ({ type, props, children })
  return {
    createElement,
    useCallback: (fn) => fn,
    useEffect: () => undefined,
    useMemo: (fn) => fn(),
    useRef: (value) => ({ current: value }),
    useState: (value) => [typeof value === 'function' ? value() : value, () => undefined],
  }
}

/**
 * Load `lib/client.js` the way the page does and expose the recorded registrations.
 * @returns {{ registrations: Array<{id: string, factory: Function}>, window: object }}
 */
function loadClientBundle() {
  const registrations = []
  // Bare specifiers the bundle asks the module table for, in request order.
  const requested = []
  const resolve = (specifier) => {
    requested.push(specifier)
    if (specifier === 'react') return fakeReact()
    // Only platform-table keys are resolvable; anything else is a build-time
    // externals drift and would throw in the real kernel too.
    if (PLATFORM_MODULES.includes(specifier)) return {}
    throw new Error(`client-modules: "${specifier}" is not a platform module`)
  }
  const window = {
    __ModuleLoader__: {
      mode: 'queue',
      pendingQueue: registrations,
      load: (registration) => { registrations.push(registration) },
      create: () => { throw new Error('not used in this test') },
    },
    requestAnimationFrame: (fn) => { fn(); return 1 },
  }
  const sandbox = {
    window,
    globalThis: undefined,
    document: {
      querySelector: () => null,
      querySelectorAll: () => [],
      createElement: () => ({ setAttribute() {}, style: {}, appendChild() {} }),
      createElementNS: () => ({ setAttribute() {}, style: {}, appendChild() {} }),
      head: { appendChild() {} },
      body: {},
    },
    MutationObserver: class { observe() {} disconnect() {} },
    Node: class {},
    fetch: async () => { throw new Error('network disabled in tests') },
    console,
  }
  sandbox.globalThis = sandbox
  const context = createContext(sandbox)
  runInContext(readFileSync(join(root, 'lib', 'client.js'), 'utf8'), context, { filename: 'client.js' })
  return { registrations, requested, resolve, window }
}

test('client bundle registers under the package name (module-table id == WebBootEntry id)', () => {
  const { registrations } = loadClientBundle()
  assert.equal(registrations.length, 1, 'the bundle must register exactly one factory')
  assert.equal(
    registrations[0].id,
    manifest.name,
    'the registration id must equal the package name, or the Loader can never import the entry',
  )
})

test('client bundle registers no package-local chunks', () => {
  const { registrations } = loadClientBundle()
  assert.equal(registrations[0].chunk, undefined)
  assert.equal(typeof registrations[0].factory, 'function')
})

test('materializing the bundle resolves its externals from the platform table and exports apply/inject', () => {
  const { registrations, requested, resolve } = loadClientBundle()
  const exports_ = registrations[0].factory(resolve)
  assert.deepEqual([...requested], ['react'], 'the only bare external may be a platform module')
  assert.equal(typeof exports_.apply, 'function')
  assert.deepEqual([...exports_.inject], ['slots', 'settingsScope'])
})

test('apply registers the composer seat and the settings section, then disposes cleanly', () => {
  const { registrations, resolve } = loadClientBundle()
  const exports_ = registrations[0].factory(resolve)
  const disposers = []
  const injected = []
  const registered = []
  const ctx = {
    effect: (callback) => { disposers.push(callback()) },
    logger: { info() {}, warn() {} },
    slots: {
      inject: (name, callback) => { injected.push(name); return callback() },
      register: (options, component) => { registered.push({ options, component }); return () => undefined },
    },
    settingsScope: { bind: (spec) => ({ spec, getSnapshot: () => ({ status: 'ready', value: {} }), subscribe: () => () => undefined, set: async () => undefined }) },
  }
  exports_.apply(ctx)
  assert.deepEqual(injected, ['conversation.input.right', 'settings.section'])
  assert.deepEqual(registered.map(entry => entry.options.id), ['prompt-enhance-local', 'prompt-enhance-local'])
  assert.deepEqual(registered.map(entry => entry.options.name), ['conversation.input.right', 'settings.section'])
  assert.equal(typeof registered[0].component, 'function')
  assert.equal(typeof registered[1].component, 'function')
  // Every effect returned a disposer (the third effect returns one from the observer).
  for (const dispose of disposers) assert.equal(typeof dispose, 'function')
  void require_
})
