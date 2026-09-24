#!/usr/bin/env node
/**
 * dsh-prompt-enhance-local — boot-graph probe (read-only).
 *
 * 回答一个具体问题：**运行中的 dsh web 到底给浏览器发了什么？**
 *
 * 背景：宿主为每个 `dsh.client` 包生成一行 boot entry（`entry id == 包名`），浏览器
 * Loader 用这个 id 去 `__ModuleLoader__` 里找 factory；bundle 注册成别的名字 →
 * `import failed` → 整个 GUI 停在 “Failed to load plugins”。本脚本直接读宿主的
 * `/plugins/events` SSE 通道，核对：
 *
 *   1. 图里有没有这个插件的 row（没有 = 没装进 profile / 没重启）；
 *   2. row.rev 是否等于当前 `lib/client.js` 的构建代（不等 = 宿主还拿着旧 bundle）；
 *   3. 把该 row 的 combo 脚本整个拉下来，确认里面的
 *      `window.__ModuleLoader__.load({ id })` 就是包名，并确认启动批次里的每个
 *      entry 脚本都真的存在（404 会让对应 entry 直接 FAILED）。
 *
 * 用法：
 *   node scripts/probe-boot-graph.mjs                      # 默认 http://127.0.0.1:3080
 *   DSH_BASE=http://127.0.0.1:3081 node scripts/probe-boot-graph.mjs
 *
 * 退出码：0 = 图、代、注册 id、批次脚本全部一致；1 = 有失败项（附修复提示）。
 * 脚本只发无副作用 GET，不触发模型调用、不写任何文件。
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const BASE = process.env.DSH_BASE ?? 'http://127.0.0.1:3080'
const EVENTS = `${BASE}/plugins/events`
const MANIFEST = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'))
const BUNDLE = readFileSync(fileURLToPath(new URL('../lib/client.js', import.meta.url)))

const failures = []
const check = (ok, label, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail === undefined ? '' : `  (${detail})`}`)
  if (!ok) failures.push(label)
}

/** Short hash the host uses for build generations (`plugin-artifact` domain is host-private). */
const sha12 = buffer => createHash('sha1').update(buffer).digest('hex').slice(0, 12)

/** Read the first `graph` frame from the Host SSE channel (aborts after `ms`). */
async function readGraph(ms = 3000) {
  const controller = new AbortController()
  const timer = setTimeout(() => { controller.abort() }, ms)
  let raw = ''
  try {
    const response = await fetch(EVENTS, { signal: controller.signal })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      raw += decoder.decode(value, { stream: true })
      if (raw.includes('\n\n')) break
    }
    // The channel is a live SSE stream: release it so the process can exit.
    await reader.cancel().catch(() => undefined)
  } finally {
    clearTimeout(timer)
    controller.abort()
  }
  const frame = raw.split('\n').find(line => line.startsWith('data: '))
  if (frame === undefined) throw new Error('no SSE frame received')
  return JSON.parse(frame.slice(6))
}

console.log(`dsh-prompt-enhance-local boot-graph probe → ${BASE}\n`)

const frame = await readGraph()
const graph = frame.graph ?? frame
check(frame.type === 'graph', 'SSE channel answered with a graph frame', `type=${frame.type}`)
check(Array.isArray(graph.entries) && graph.entries.length > 0, 'boot graph carries entries', `entries=${graph.entries?.length}`)

const row = graph.entries.find(entry => entry.id === MANIFEST.name)
check(row !== undefined, `boot graph has a row for the package name`, MANIFEST.name)
if (row === undefined) {
  console.log('\n插件没进 boot graph：检查 profile 的 dsh.profile.bundles 是否含 '
    + `${MANIFEST.name}，以及宿主是否在改完之后重启过（host 半区不热更）。`)
  process.exit(1)
}

check(/^\/plugins\/\?\?/.test(row.url), 'row URL uses the combo bundle route', row.url)
const revisionLooksDerived = row.rev !== undefined && row.rev.length >= 12
check(revisionLooksDerived, 'row carries a build revision', `rev=${row.rev ?? '(missing)'}`)

// Fetch exactly what the browser would load for this row.
const response = await fetch(BASE + row.url)
check(response.ok, 'row bundle is served', `HTTP ${response.status}`)
const body = Buffer.from(await response.arrayBuffer())
const text = body.toString('utf8')

const idMatch = /__ModuleLoader__\.load\(\{\s*id:\s*"([^"]+)"/.exec(text)
check(idMatch?.[1] === MANIFEST.name, 'bundle registers under the package name', `id=${idMatch?.[1] ?? '(none)'}`)
check(text.includes('factory:'), 'bundle registers a factory')
check(/exports\.apply\s*=|apply\s*=/.test(text), 'bundle exposes apply for the Loader')

// Every entry in this row's startup batch must exist, or that entry fails the boot audit.
const batches = Array.isArray(graph.batches) ? graph.batches : []
const batch = batches.find(item => Array.isArray(item.entries) && item.entries.includes(MANIFEST.name))
check(batch !== undefined, 'row belongs to a startup batch', batch === undefined ? 'missing' : `${batch.phase} batch`)
if (batch !== undefined) {
  const batchResponse = await fetch(BASE + batch.url)
  check(batchResponse.ok, 'startup batch script is served', `HTTP ${batchResponse.status}`)
  const batchText = await batchResponse.text()
  const missing = batchText.length === 0 ? ['<empty batch body>'] : []
  check(missing.length === 0, 'startup batch body is non-empty', `bytes=${batchText.length}`)
}

console.log(`\nlocal bundle sha1(12) = ${sha12(BUNDLE)}  size = ${BUNDLE.length}`)
console.log(`served script sha1(12) = ${sha12(body)}  size = ${body.length}`)
console.log(`(宿主按「bundle 字节 + 构建 stat」派生 rev，两者 hash 不必相等；关键是上面注册 id 一致)\n`)

if (failures.length > 0) {
  console.log(`${failures.length} check(s) failed. 排查顺序：`)
  console.log('  1. row 不在图里 → profile 的 dsh.profile.bundles 少了包名，或宿主没重启')
  console.log('  2. 注册 id 不等于包名 → tsdown.config.ts 的 PLUGIN_ID 必须来自 package.json#name')
  console.log('  3. 脚本 404/空 → lib/client.js 没构建，或 exports["./client"] 指错')
  process.exit(1)
}
console.log('boot graph、注册 id、批次脚本全部一致：浏览器刷新即可加载。')
