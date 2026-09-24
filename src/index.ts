/**
 * dsh-prompt-enhance-local — host 半区。
 *
 * 本仓库是 zzy6-a/dsh-prompt-enhance（MIT）的本地加固 fork，只做一件事：
 * 把 composer 里的一句话草稿改写成目标明确、结构化的专业提示词。
 *
 * 相对上游的改动（见 README「与上游的差异」）：
 *   - 删除：会话上下文生成（本插件不再读取 sessions）、自定义 system 模板、
 *     空草稿策略（现在一律拒绝空草稿）、落盘诊断日志（改用宿主 logger，
 *     对文件系统零写入）；
 *   - 修复：Origin 校验的 startsWith 绕过（如 http://localhost.evil.com）、
 *     强制要求 Origin 头、采纳 sec-fetch-site 提示、新增内存限流。
 *
 * 职责：暴露一条同源 HTTP 路由，接收 composer 草稿 → 用一次性 LLM 调用改写
 * → 返回结果。调用不落会话日志、不进 agent 上下文（hand-built 一次性调用）。
 *
 * 设置命名空间 `prompt-enhance-local`（host 注册；client 设置卡片读写同一份）：
 *   enabled        总开关
 *   style          改写风格：default | concise | detailed | constraints | structured
 *   modelMode      模型：follow（跟随会话）| fixed（固定 provider/model）
 *   provider/model fixed 模式下使用
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import z from '@deepseek-ai/schemastery'

// ── 本地最小结构面 ────────────────────────────────────────────────────────────
// 本插件只用宿主服务的少数方法。这里自带最小声明，好处是构建只需一个 SDK
// 依赖（schemastery，设置 schema），CI 不必安装整套 @deepseek-ai/* 运行时包；
// 运行时的真实实例由宿主注入，结构兼容即可——这也是抗 harness 更新的第一道防线。

/** One exact-path HTTP route registered on the host web server. */
interface WebRoute {
  kind: 'exact' | 'prefix'
  path: string
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
}

/** One model-visible message handed to a one-shot LLM call. */
interface LlmMessage {
  id: string
  role: 'user'
  source: { kind: 'user' }
  content: Array<{ type: 'text'; text: string }>
}

/** Streaming chunk shape this plugin consumes (text deltas only). */
interface LlmChunk {
  type?: string
  text?: string
}

/** Settings scope face owned by the host settings provider. */
interface SettingsScopeFace<T> {
  get(): T
}

/** The host services this plugin uses, structurally typed. */
interface HostContext {
  logger?: { info?: (message: string) => void; warn?: (error: unknown) => void }
  on(event: 'llm/stream', listener: (options: { purpose?: string; provider: string; model: string }, next: () => unknown) => unknown): () => void
  effect(callback: () => (() => void) | void, label?: string): void
  get?(name: string): unknown
  llm: { stream(options: Record<string, unknown>): AsyncIterable<LlmChunk> }
  webServer: { register(route: WebRoute): () => void }
  settings: { register(namespace: string, schema: unknown): SettingsScopeFace<PromptEnhanceSettings> }
}

/** Build one plain user message (the SDK's constructor is not a runtime dependency here). */
function createUserMessage(input: { source: { kind: 'user' }; content: Array<{ type: 'text'; text: string }> }): LlmMessage {
  return {
    id: globalThis.crypto.randomUUID(),
    role: 'user',
    source: input.source,
    content: input.content,
  }
}

export const name = 'dsh-prompt-enhance-local'
export const inject = ['webServer', 'llm', 'settings']

/** Exact-path route serving the client button. */
const ROUTE_PATH = '/api/dsh-prompt-enhance-local/enhance'
/** Request body cap (a draft is small; anything larger is a misuse). */
const MAX_BODY_BYTES = 64 * 1024
/** Draft cap handed to the model. */
const MAX_DRAFT_CHARS = 12000
/** End-to-end deadline for one enhancement call. */
const TIMEOUT_MS = 90_000
/** Settings namespace shared with the client card. */
export const SETTINGS_NS = 'prompt-enhance-local'
/** Rate limit: enhancement calls allowed per window (per process, in-memory). */
const RATE_LIMIT = 10
const RATE_WINDOW_MS = 60_000

/** Exact loopback hostnames allowed as an Origin host (no prefix matching — see README). */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])

/** Common rewrite policy shared by every style. */
const BASE_RULES = [
  '你是提示词改写器。用户会给你一段写给 AI 编程助手（agent）的任务描述。',
  '规则：',
  '1. 保留原始意图、语言、专有名词、代码、命令、路径、标识符，原样照抄，不要翻译。',
  '2. 不要新增用户没提过的新需求、新技术选型或新文件。',
  '3. 直接输出改写后的提示词正文，不要解释、前言、结语，也不要用代码围栏或引号把整段包起来。',
].join('\n')

/** Per-style task instruction. */
const STYLE_PROMPTS: Record<string, string> = {
  default: [
    '你的唯一任务：把用户的说法改写得更清楚，并补全缺失的关键细节，让 agent 一次就明白目标。',
    '只补全能从原文合理推断的维度：要达成的目标、范围（改哪里 / 不改哪里）、产出形式、必须遵守的约束、验收标准。不要编造具体文件、接口或依赖。',
    '输出必须比输入更具体：至少补上"范围"或"产出形式"其中之一；只有原文已经完整到无可补充时，才允许原样返回。',
    '保持简洁：长度不超过原文的 3 倍，不要写成多级清单。',
    '示例——',
    '输入：帮我给设置页加个导出按钮',
    '输出：在设置页加一个导出按钮，点击后把当前配置导出成文件。导出内容按现有配置项全量导出，格式优先沿用项目里已有的导出实现（没有就用 JSON）；按钮放在设置页现有的操作区，沿用现有按钮样式，不新增依赖。',
  ].join('\n'),
  concise: [
    '你的唯一任务：删掉口语、冗余和重复，用最短的句子表达同一件事。',
    '不要新增信息；长度不超过原文。保留所有关键约束与专有名词。',
  ].join('\n'),
  detailed: [
    '你的唯一任务：把用户的说法扩写成一条完整、可执行的任务描述，补全背景、目标、做法要点与预期产出。',
    '可以补充实现层面的合理细节，但不得改变原始意图，也不要虚构具体文件或接口名。',
  ].join('\n'),
  constraints: [
    '你的唯一任务：在保留原意的前提下，明确这条任务的边界与约束，让 agent 不会做多余的事。',
    '必须写清：要改什么、不要改什么、必须遵守的既有约定、以及完成的标准。',
    '不要把约束写成技术方案，也不要发明新的限制。',
  ].join('\n'),
  structured: [
    '你的唯一任务：把说法整理成结构化任务说明，用小标题分点输出：目标、范围、产出、约束、验收。',
    '每一节只写从原文能推出的内容；推不出的维度写「未指定」而不是编造。',
  ].join('\n'),
}

/**
 * Compose the rewrite system prompt: base rules + the selected style instruction.
 * @param style - settings style id (unknown ids fall back to `default`).
 * @returns the system prompt text.
 */
export function buildSystemPrompt(style: string): string {
  const body = STYLE_PROMPTS[style] ?? STYLE_PROMPTS.default
  return BASE_RULES + '\n' + body
}

/** Settings shape owned by this plugin (defaults are the shipped behavior). */
export interface PromptEnhanceSettings {
  enabled: boolean
  style: string
  modelMode: string
  provider: string
  model: string
}

export const SettingsSchema = z.object({
  enabled: z.boolean().default(true),
  style: z.union(['default', 'concise', 'detailed', 'constraints', 'structured']).default('structured'),
  modelMode: z.union(['follow', 'fixed']).default('follow'),
  provider: z.string().default(''),
  model: z.string().default(''),
})

/** Default-model service face (optional: not every deployment mounts it). */
interface DefaultModelFace {
  currentSelection(): { provider: string; model: string }
}

/** Read the optional default-model service without a hard inject dependency. */
function readDefaultRoute(ctx: HostContext): { provider: string; model: string } | undefined {
  try {
    const getter = ctx.get
    if (typeof getter !== 'function') return undefined
    const face = getter.call(ctx, 'agentDefaultModel') as DefaultModelFace | undefined
    return face?.currentSelection()
  } catch {
    return undefined
  }
}

/** One JSON response. */
function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'referrer-policy': 'no-referrer',
    'cache-control': 'no-store',
  })
  res.end(payload)
}

/** Read a bounded JSON body (undefined when too large or unparseable). */
async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown> | undefined> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = chunk as Buffer
    size += buffer.length
    if (size > MAX_BODY_BYTES) return undefined
    chunks.push(buffer)
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : undefined
  } catch {
    return undefined
  }
}

/** Hostname of a Host header value such as `127.0.0.1:3080` ('' when unparsable). */
function hostHeaderHostname(hostHeader: string): string {
  try {
    return new URL('http://' + hostHeader).hostname.toLowerCase()
  } catch {
    return ''
  }
}

/**
 * Request fence for the enhance route: the browser must prove the call came from
 * the page this server itself serves.
 *
 * Rules (all must hold):
 *   1. An Origin header is REQUIRED and must parse as http(s) — bare requests
 *      (curl without headers, stray processes) are rejected;
 *   2. The Origin hostname must be an EXACT loopback match, or exactly equal to
 *      the request's Host hostname (same-host deployments, e.g. LAN access).
 *      Prefix matching is deliberately NOT used: upstream allowed
 *      `http://localhost.evil.com` via startsWith('localhost');
 *   3. When the browser sends `sec-fetch-site`, it must be `same-origin`
 *      (absent header falls back to rules 1–2 only).
 *
 * Residual risk (documented): a local process can forge every one of these
 * headers — loopback HTTP has no real authentication (the DSH GUI itself has
 * none). The in-memory rate limit below caps abuse at a bounded call rate.
 */
export function originAllowed(req: Pick<IncomingMessage, 'headers'>): boolean {
  const origin = req.headers.origin
  if (typeof origin !== 'string' || origin.length === 0) return false
  let originHost: string
  let protocol: string
  try {
    const url = new URL(origin)
    originHost = url.hostname.toLowerCase()
    protocol = url.protocol
  } catch {
    return false
  }
  if (protocol !== 'http:' && protocol !== 'https:') return false
  if (!LOOPBACK_HOSTS.has(originHost)) {
    const hostHeader = typeof req.headers.host === 'string' ? req.headers.host : ''
    if (hostHeader.length === 0) return false
    if (hostHeaderHostname(hostHeader) !== originHost) return false
  }
  const site = req.headers['sec-fetch-site']
  if (typeof site === 'string' && site.length > 0 && site !== 'same-origin') return false
  return true
}

/**
 * Fixed-window in-memory rate limiter (no dependencies, no state on disk).
 * @param options.limit - calls allowed per window.
 * @param options.windowMs - window length in milliseconds.
 * @param options.now - injectable clock for tests (defaults to Date.now).
 * @returns a limiter whose `allow()` reports whether this call may proceed.
 */
export function createRateLimiter(options: { limit: number; windowMs: number; now?: () => number }): { allow(): boolean } {
  const now = options.now ?? Date.now
  let windowStart = now()
  let count = 0
  return {
    allow(): boolean {
      const at = now()
      if (at - windowStart >= options.windowMs) {
        windowStart = at
        count = 0
      }
      count += 1
      return count <= options.limit
    },
  }
}

/** Strip a wrapping code fence when the model ignores the "no fence" rule. */
export function stripFence(text: string): string {
  const trimmed = text.trim()
  const match = /^```[a-zA-Z0-9_-]*\n([\s\S]*?)\n?```$/.exec(trimmed)
  return match?.[1] !== undefined ? match[1].trim() : trimmed
}

export function apply(ctx: HostContext): void {
  const settings = ctx.settings.register(SETTINGS_NS, SettingsSchema)
  const limiter = createRateLimiter({ limit: RATE_LIMIT, windowMs: RATE_WINDOW_MS })

  /** Most recent main-model route, captured off the llm waterfall (auxiliary purposes excluded). */
  let lastRoute: { provider: string; model: string } | undefined
  ctx.on('llm/stream', (options, next) => {
    if (options.purpose === undefined) lastRoute = { provider: options.provider, model: options.model }
    return next()
  })

  const route: WebRoute = {
    kind: 'exact',
    path: ROUTE_PATH,
    async handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
      try {
        await handle(req, res)
      } catch (error) {
        ctx.logger?.warn?.('[dsh-prompt-enhance-local] handler error: ' + (error instanceof Error ? (error.stack ?? error.message) : String(error)))
        if (!res.headersSent) sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
        else res.destroy()
      }
    },
  }

  /** Route body: split out so the outer seat owns one error fence. */
  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'POST') {
      sendJson(res, 405, { ok: false, error: 'method not allowed' })
      return
    }
    if (!originAllowed(req)) {
      sendJson(res, 403, { ok: false, error: 'forbidden origin' })
      return
    }
    if (!limiter.allow()) {
      sendJson(res, 429, { ok: false, error: '请求过于频繁，请稍后再试' })
      return
    }
    const config = settings.get() as PromptEnhanceSettings
    if (config.enabled !== true) {
      sendJson(res, 403, { ok: false, error: '提示词增强已在设置中关闭' })
      return
    }
    const body = await readJsonBody(req)
    const draft = typeof body?.draft === 'string' ? body.draft.trim() : ''
    if (draft.length === 0) {
      sendJson(res, 400, { ok: false, error: '草稿为空' })
      return
    }
    if (draft.length > MAX_DRAFT_CHARS) {
      sendJson(res, 413, { ok: false, error: `草稿超过 ${MAX_DRAFT_CHARS} 字符` })
      return
    }

    // Model route: an explicit fixed pair wins, otherwise the session route then the default.
    const fixed = config.modelMode === 'fixed' && config.provider.length > 0 && config.model.length > 0
      ? { provider: config.provider, model: config.model }
      : undefined
    const selected = fixed ?? lastRoute ?? readDefaultRoute(ctx)
    if (selected === undefined) {
      sendJson(res, 503, { ok: false, error: '没有可用的模型路由' })
      return
    }

    const system = buildSystemPrompt(config.style)
    const controller = new AbortController()
    const timer = setTimeout(() => { controller.abort() }, TIMEOUT_MS)
    let text = ''
    try {
      const stream = ctx.llm.stream({
        provider: selected.provider,
        model: selected.model,
        system,
        messages: [createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: draft }] })],
        temperature: 0.3,
        maxTokens: 1500,
        signal: controller.signal,
      })
      for await (const chunk of stream) {
        if (chunk.type === 'text-delta') text += chunk.text
      }
    } catch (error) {
      sendJson(res, 502, { ok: false, error: error instanceof Error ? error.message : String(error) })
      return
    } finally {
      clearTimeout(timer)
    }
    const result = stripFence(text)
    if (result.length === 0) {
      sendJson(res, 502, { ok: false, error: '模型没有返回内容' })
      return
    }
    sendJson(res, 200, { ok: true, text: result, route: selected, style: config.style })
  }

  ctx.effect(() => ctx.webServer.register(route), 'dsh-prompt-enhance-local: enhance route')
  ctx.logger?.info?.('[dsh-prompt-enhance-local] route ready: POST ' + ROUTE_PATH)
}
