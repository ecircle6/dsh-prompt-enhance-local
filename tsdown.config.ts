/**
 * Client bundle build (browser half only).
 *
 * The bundle must register itself through `window.__ModuleLoader__.load({ id })`
 * under **the package name**, never a hand-written label:
 *
 *   - the host composes one `WebBootEntry` per `dsh.client` package and sets
 *     `id` to the owning manifest's package name (`dsh-client-modules`);
 *   - the browser Loader imports exactly that specifier when it creates the
 *     entry, and `assertEntriesActive` fails the whole boot with
 *     `"<pkg>: import failed (see console for the import error)"` when no
 *     factory was registered under it.
 *
 * So a bundle id that drifts from `package.json#name` stops the Web GUI at
 * "Failed to load plugins" — the ids below are derived from the manifest
 * instead of being typed twice.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { UserConfig } from 'tsdown'

/** Absolute path of this package's manifest, independent of the process cwd. */
const MANIFEST_PATH = fileURLToPath(new URL('./package.json', import.meta.url))

/** Read a non-empty string field from the package manifest. */
function manifestField(field: 'name' | 'version'): string {
  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) as Record<string, unknown>
  const value = manifest[field]
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`tsdown.config: package.json is missing a string "${field}"`)
  }
  return value
}

/** Package name — the module-table key the browser kernel resolves this bundle by. */
const PLUGIN_ID = manifestField('name')

/** Sanity fence: a module-table key is a bare package specifier, nothing else. */
if (!/^(?:@[^/]+\/)?[^/@]+$/.test(PLUGIN_ID)) {
  throw new Error(`tsdown.config: package name ${JSON.stringify(PLUGIN_ID)} is not a bare package specifier`)
}

const CLIENT_EXTERNALS = [
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client',
  'cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-runtime/client',
]

const clientBundle: UserConfig = {
  entry: { client: 'src/client/index.ts' },
  outDir: 'lib',
  format: 'cjs',
  platform: 'browser',
  dts: false,
  sourcemap: true,
  clean: false,
  define: {
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
  },
  deps: {
    neverBundle: [...CLIENT_EXTERNALS],
    alwaysBundle: (id: string) => !CLIENT_EXTERNALS.includes(id),
  },
  outputOptions: {
    entryFileNames: 'client.js',
    banner: 'window.__ModuleLoader__.load({ id: ' + JSON.stringify(PLUGIN_ID) + ', factory: (require) => {',
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
    codeSplitting: false,
  },
}

export default [clientBundle] satisfies UserConfig[]
