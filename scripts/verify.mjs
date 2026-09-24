#!/usr/bin/env node
/**
 * dsh-prompt-enhance-local — upgrade canary.
 *
 * 每次升级 DeepSeek Harness 之后跑一次：
 *
 *     node scripts/verify.mjs
 *
 * 它只发无副作用的请求（不会真的调用模型——最后一个检查会以 400/413 结束，
 * 永远走不到 llm.stream），在 1 分钟内回答一个问题：
 * **harness 更新后，这个插件的路由还活着吗？**
 *
 * 检查项：
 *   1. GET  → 405（路由已注册，方法护栏在）
 *   2. 无 Origin 的 POST → 403（Origin 强制生效）
 *   3. 伪造 Origin（localhost.evil.com）→ 403（审计修复仍生效）
 *   4. 合法 Origin + 空草稿 → 400（请求管线通到草稿校验）
 *   5. 合法 Origin + 超长草稿 → 413（长度上限生效）
 *   6. （可选 --rate）连续打满限流 → 出现 429
 *
 * 退出码：0 = 全部通过；1 = 有失败项（附原因与修复提示）。
 */
const BASE = process.env.DSH_BASE ?? 'http://127.0.0.1:3080'
const ROUTE = '/api/dsh-prompt-enhance-local/enhance'
const ORIGIN = process.env.DSH_ORIGIN ?? BASE

const results = []

async function probe(label, expectStatus, request) {
  try {
    const response = await request()
    const status = response.status
    const pass = status === expectStatus
    results.push({ label, pass, got: status, expect: expectStatus })
    console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}  (got ${status}, expect ${expectStatus})`)
  } catch (error) {
    results.push({ label, pass: false, got: 'ERR', expect: expectStatus, error: String(error) })
    console.log(`FAIL  ${label}  (error: ${error})`)
  }
}

const post = (body, headers = {}) =>
  fetch(BASE + ROUTE, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: ORIGIN, ...headers },
    body: JSON.stringify(body),
  })

console.log(`dsh-prompt-enhance-local verify → ${BASE}${ROUTE}\n`)

await probe('GET method guard returns 405', 405, () => fetch(BASE + ROUTE))
await probe('POST without Origin is rejected', 403, () =>
  fetch(BASE + ROUTE, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ draft: 'x' }) }))
await probe('forged Origin (localhost.evil.com) is rejected', 403, () =>
  fetch(BASE + ROUTE, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://localhost.evil.com' }, body: JSON.stringify({ draft: 'x' }) }))
await probe('valid Origin + empty draft reaches validation', 400, () => post({ draft: '' }))
await probe('valid Origin + oversized draft hits 413 cap', 413, () => post({ draft: 'x'.repeat(12001) }))

if (process.argv.includes('--rate')) {
  let saw429 = false
  for (let i = 0; i < 12; i += 1) {
    const response = await post({ draft: '' }).catch(() => undefined)
    if (response?.status === 429) { saw429 = true; break }
  }
  results.push({ label: 'rate limiter eventually returns 429', pass: saw429, got: saw429 ? 429 : 'none', expect: 429 })
  console.log(`${saw429 ? 'PASS' : 'FAIL'}  rate limiter eventually returns 429`)
}

const failed = results.filter((item) => !item.pass)
console.log(`\n${results.length - failed.length}/${results.length} passed`)
if (failed.length > 0) {
  console.log('\n插件可能已因 harness 更新失效。排查顺序：')
  console.log('  1. 设置 → 插件 列表里有没有 dsh-prompt-enhance-local（没有 = 没加载，查 dsh.profile.bundles）')
  console.log('  2. 启动日志里有没有 [dsh-prompt-enhance-local] route ready（没有 = host 半区注册失败）')
  console.log('  3. 对照 README「抗更新」一节检查用到的 seam 是否改名')
  process.exit(1)
}
console.log('插件路由与护栏全部正常。')
