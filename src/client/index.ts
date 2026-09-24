/**
 * dsh-prompt-enhance-local — client 半区。
 *
 * 在 composer 工具行注册一个小按钮，位置在 `conversation.input.right`（渲染出来
 * 紧贴模型选择器左侧）。点击 → 读当前草稿 → 调 host 一次性改写 → 整稿替换，
 * 并给出可撤销的入口（撤销按钮在草稿未被手动改动前一直可用）。
 *
 * 另注册设置分区 `settings.section`，读写 host 同名命名空间 `prompt-enhance-local`。
 *
 * 构建契约：本文件编译出的 `lib/client.js` 会被宿主按 **包名**
 * （`dsh-prompt-enhance-local`）作为 boot graph 的 entry id 导入，注册 id 由
 * `tsdown.config.ts` 从 package.json 派生——手写第二个名字会让宿主永远找不到
 * 这个入口，整个 Web GUI 停在 “Failed to load plugins”。
 */
import { createElement as h, useCallback, useEffect, useMemo, useRef, useState } from 'react'

export const inject = ['slots', 'settingsScope']

/** Host route served by this plugin's host half. */
const ROUTE = '/api/dsh-prompt-enhance-local/enhance'

let warnedOnce = false

/** Register the composer button on the right tool-row cluster (before the model seat). */
export function apply(ctx: any): void {
  ctx.effect(() => ctx.slots.inject('conversation.input.right', () => ctx.slots.register({
    name: 'conversation.input.right',
    id: 'prompt-enhance-local',
    order: 10,
    inject: (sessionId: string) => ({
      /** Ask the host to rewrite one draft; resolves with the enhanced text. */
      enhanceDraft: async (draft: string): Promise<string> => {
        const response = await fetch(ROUTE, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({ sessionId, draft }),
        })
        const payload = await response.json().catch(() => undefined) as
          | { ok?: boolean; text?: string; error?: string }
          | undefined
        if (response.ok !== true || payload?.ok !== true) {
          throw new Error(payload?.error ?? `HTTP ${response.status}`)
        }
        const text = typeof payload.text === 'string' ? payload.text : ''
        if (text.trim().length === 0) throw new Error('模型没有返回内容')
        return text
      },
    }),
  }, PromptEnhanceSeat)), 'dsh-prompt-enhance-local: composer seat')

  // 设置：与 host 侧同名命名空间（prompt-enhance-local）的另一半——这里只做读写。
  // 注册成独立分区（settings.section）：设置页左侧出现自己的「提示词增强」一项，
  // 而不是挤进插件配置 tab 里。
  const scope = ctx.settingsScope.bind({ namespace: 'prompt-enhance-local' })
  ctx.effect(() => ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'prompt-enhance-local',
    order: 100,
    label: () => '提示词增强',
    inject: () => ({ scope }),
  }, SettingsSection)), 'dsh-prompt-enhance-local: settings section')

  // 设置页左侧导航的图标由外壳按 section id 硬编码（未识别的 id 一律回退成齿轮），
  // 插件无法在注册时自带图标；这里用一次极轻的 DOM 装饰把齿轮换成 ✨：
  // 找到文本为「提示词增强」的导航项 → 隐藏它的 svg → 前面插一个 ✨。
  // 纯装饰：任何一步失败都只是"还是齿轮"，不影响功能与注册。
  ctx.effect(() => {
    let queued = false
    const paint = (): void => {
      queued = false
      try {
        const spans = document.querySelectorAll('span')
        for (const span of Array.from(spans)) {
          if (span.textContent?.trim() !== '提示词增强') continue
          const cell = span.parentElement
          if (cell === null || cell.dataset.promptEnhanceNav === 'done') continue
          const svg = cell.querySelector('svg')
          if (svg === null) continue
          svg.style.display = 'none'
          cell.insertBefore(sparkleIcon(), cell.firstChild)
          cell.dataset.promptEnhanceNav = 'done'
        }
      } catch { /* cosmetic only */ }
    }
    const schedule = (): void => {
      if (queued) return
      queued = true
      window.requestAnimationFrame(paint)
    }
    const observer = new MutationObserver(schedule)
    observer.observe(document.body, { childList: true, subtree: true })
    paint()
    return () => observer.disconnect()
  }, 'dsh-prompt-enhance-local: settings nav icon')
}

/** Guard seat: renders nothing when the standard kit is unavailable (never breaks the composer). */
function PromptEnhanceSeat(props: any) {
  if (typeof props?.useInput !== 'function' || props?.inputActions === undefined) {
    if (!warnedOnce) {
      warnedOnce = true
      console.warn('[dsh-prompt-enhance-local] conversation.input.right seat has no standard kit; button skipped')
    }
    return null
  }
  return h(PromptEnhanceButton, props)
}

function PromptEnhanceButton({ useInput, inputActions, enhanceDraft }: any) {
  const draft: string = useInput((state: any) => state.draft)
  const phase: string = useInput((state: any) => state.phase)
  /** 草稿里是否含芯片（@ 文件引用 / 命令 / skill）：整稿替换会切断引用，故直接禁用。 */
  const hasChips: boolean = useInput((state: any) => Array.isArray(state?.occurrences) && state.occurrences.length > 0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [hover, setHover] = useState(false)
  /** Draft before the last successful enhancement, kept while it can still be undone. */
  const [original, setOriginal] = useState<string | null>(null)
  /** Text produced by the last enhancement (the undo is live only while the draft still equals it). */
  const [enhanced, setEnhanced] = useState<string | null>(null)

  const empty = typeof draft !== 'string' || draft.trim().length === 0
  const locked = phase !== 'plain'
  const undoable = original !== null && enhanced !== null && draft === enhanced
  const disabled = busy || locked || empty || hasChips

  const run = useCallback(() => {
    const current = typeof draft === 'string' ? draft.trim() : ''
    if (current.length === 0 || busy) return
    setBusy(true)
    setError('')
    void (async () => {
      try {
        const text = await enhanceDraft(current)
        setOriginal(draft)
        setEnhanced(text)
        inputActions.setDraft(text)
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : String(reason))
      } finally {
        setBusy(false)
      }
    })()
  }, [busy, draft, enhanceDraft, inputActions])

  const revert = useCallback(() => {
    if (original === null) return
    inputActions.setDraft(original)
    setOriginal(null)
    setEnhanced(null)
    setError('')
  }, [inputActions, original])

  const button = disabled ? 'not-allowed' : 'pointer'
  const iconColor = error !== '' ? 'var(--dsw-alias-label-error, #d92d20)' : 'var(--dsw-alias-label-secondary, #6b7280)'
  const baseStyle: Record<string, unknown> = {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 28,
    height: 28,
    padding: 0,
    margin: 0,
    border: 'none',
    borderRadius: 8,
    background: 'transparent',
    color: iconColor,
    cursor: button,
    opacity: disabled && !busy ? 0.45 : 1,
    transition: 'background .12s ease',
    flex: 'none',
  }

  const sparkle = h('svg', { width: 17, height: 17, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true },
    h('path', {
      d: 'M8 1.6l1.55 4.05L13.6 7.2l-4.05 1.55L8 12.8 6.45 8.75 2.4 7.2l4.05-1.55L8 1.6z',
      fill: 'currentColor',
    }),
    h('path', { d: 'M12.8 11.2l.6 1.6 1.6.6-1.6.6-.6 1.6-.6-1.6-1.6-.6 1.6-.6.6-1.6z', fill: 'currentColor' }),
  )

  const undoIcon = h('svg', { width: 17, height: 17, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true },
    h('path', {
      d: 'M5.6 3.2L2.4 6.4l3.2 3.2M2.6 6.4h6.1a4.4 4.4 0 0 1 0 8.8H6.2',
      stroke: 'currentColor',
      'stroke-width': 1.5,
      'stroke-linecap': 'round',
      'stroke-linejoin': 'round',
    }),
  )

  const children: unknown[] = [
    h('button', {
      key: 'enhance',
      type: 'button',
      'data-testid': 'prompt-enhance-run',
      'aria-label': '优化提示词',
      title: hasChips
        ? '当前草稿含文件引用 / 命令芯片，一键替换会切断这些引用——先去掉了再优化'
        : (error !== '' ? `优化失败：${error}` : (empty ? '先输入内容再优化' : '优化提示词（一键替换，可撤销）')),
      disabled,
      onClick: run,
      onMouseEnter: () => setHover(true),
      onMouseLeave: () => setHover(false),
      style: {
        ...baseStyle,
        background: hover && !disabled ? 'var(--dsw-alias-interactive-bg-hover, rgba(15,23,42,.06))' : 'transparent',
      },
    }, busy
      ? h('span', { style: { fontSize: 13, letterSpacing: 1, opacity: 0.7 } }, '···')
      : sparkle),
  ]

  if (undoable) {
    children.push(h('button', {
      key: 'undo',
      type: 'button',
      'data-testid': 'prompt-enhance-undo',
      'aria-label': '撤销优化',
      title: '撤销优化，恢复原文',
      onClick: revert,
      onMouseEnter: () => setHover(true),
      onMouseLeave: () => setHover(false),
      style: {
        ...baseStyle,
        color: 'var(--dsw-alias-label-primary, #111827)',
        background: hover ? 'var(--dsw-alias-interactive-bg-hover, rgba(15,23,42,.06))' : 'transparent',
      },
    }, undoIcon))
  }

  return h('span', {
    'data-testid': 'prompt-enhance-seat',
    style: { display: 'inline-flex', alignItems: 'center', gap: 2, flex: 'none' },
  }, children)
}


/* ────────────────────────── 设置分区 ────────────────────────── */

const STYLE_OPTIONS: Array<[string, string]> = [
  ['default', '补全细节、明确目标'],
  ['concise', '更简洁：删冗余，不加信息'],
  ['detailed', '更详细：补背景、做法要点与产出'],
  ['constraints', '加约束：写清边界与验收标准'],
  ['structured', '结构化：目标 / 范围 / 产出 / 约束 / 验收（默认）'],
]

const MODEL_OPTIONS: Array<[string, string]> = [
  ['follow', '跟随当前会话'],
  ['fixed', '固定 provider / model'],
]

/** Rows keep the official settings-row rhythm; class hooks carry the interaction states. */
const SETTINGS_CSS = `
.pe-row { display: flex; align-items: center; gap: 8px; padding: 16px 0; border-bottom: .5px solid var(--dsw-alias-border-l2, #e4e7ec); }
.pe-rowText { flex: 1; min-width: 0; padding-right: 48px; display: flex; flex-direction: column; gap: 4px; }
.pe-field { display: flex; flex-direction: column; gap: 10px; padding: 16px 0 4px; }
.pe-title { font-size: 14px; line-height: 22px; color: var(--dsw-alias-label-primary, #111827); }
.pe-desc { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary, #667085); }
.pe-check { width: 16px; height: 16px; flex: none; cursor: pointer; accent-color: var(--dsw-alias-brand-primary, #4d6bfe); }
.pe-selectWrap { position: relative; flex: none; }
.pe-select { display: inline-flex; align-items: center; justify-content: space-between; gap: 12px; min-width: 208px; height: 36px; padding: 0 14px; border: none; border-radius: 18px; background: var(--dsw-alias-bg-module-platform, #fff); color: var(--dsw-alias-label-primary, #111827); font: inherit; font-size: 14px; line-height: 22px; cursor: pointer; transition: background .12s ease; }
.pe-select:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(15,23,42,.06)); }
.pe-select:disabled { opacity: .5; cursor: not-allowed; }
.pe-menu { position: absolute; top: calc(100% + 6px); right: 0; z-index: 40; min-width: 100%; max-height: 264px; overflow: auto; padding: 4px; border: 1px solid var(--dsw-alias-border-l2, #e4e7ec); border-radius: 10px; background: var(--dsw-alias-bg-layer-1, #fff); box-shadow: var(--dsw-elevation-panel, 0 10px 28px rgba(16,24,40,.14)); display: flex; flex-direction: column; gap: 2px; }
.pe-item { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 8px 10px; border: none; border-radius: 8px; background: transparent; color: var(--dsw-alias-label-primary, #111827); font: inherit; font-size: 13px; line-height: 18px; text-align: left; white-space: nowrap; cursor: pointer; }
.pe-item:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(15,23,42,.06)); }
.pe-item[data-active="true"] { font-weight: 500; }
.pe-input { height: 36px; box-sizing: border-box; padding: 0 12px; border: 1px solid var(--dsw-alias-border-l2, #d0d5dd); border-radius: 10px; background: var(--dsw-alias-bg-module-platform, #fff); color: var(--dsw-alias-label-primary, #111827); font: inherit; font-size: 13px; }
.pe-input:focus, .pe-textarea:focus { outline: none; border-color: var(--dsw-alias-brand-primary, #4d6bfe); }
.pe-textarea { width: 100%; box-sizing: border-box; min-height: 88px; resize: vertical; padding: 10px 12px; border: 1px solid var(--dsw-alias-border-l2, #d0d5dd); border-radius: 12px; background: var(--dsw-alias-bg-module-platform, #fff); color: var(--dsw-alias-label-primary, #111827); font: inherit; font-size: 13px; line-height: 20px; }
.pe-textarea::placeholder { color: var(--dsw-alias-label-tertiary, #98a2b3); }
.pe-route { display: flex; gap: 8px; flex: none; }
`

/** Inject the section stylesheet once per document. */
function ensureSettingsCss(): void {
  if (typeof document === 'undefined') return
  if (document.querySelector('style[data-prompt-enhance-css]') !== null) return
  const style = document.createElement('style')
  style.setAttribute('data-prompt-enhance-css', '')
  style.textContent = SETTINGS_CSS
  document.head.appendChild(style)
}

/** Chevron glyph for the selection trigger (same geometry family as the SDK icons). */
function chevronGlyph() {
  return h('svg', { width: 12, height: 12, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true },
    h('path', {
      d: 'M4 6.2L8 10.2L12 6.2',
      stroke: 'currentColor',
      'stroke-width': 1.4,
      'stroke-linecap': 'round',
      'stroke-linejoin': 'round',
    }))
}

/** Check glyph marking the selected menu row. */
function checkGlyph() {
  return h('svg', { width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true },
    h('path', {
      d: 'M3.4 8.4L6.4 11.4L12.6 4.9',
      stroke: 'currentColor',
      'stroke-width': 1.6,
      'stroke-linecap': 'round',
      'stroke-linejoin': 'round',
    }))
}

function sectionRow(title: string, desc: string, control: unknown) {
  return h('div', { className: 'pe-row', key: title },
    h('div', { className: 'pe-rowText' },
      h('div', { className: 'pe-title' }, title),
      desc.length > 0 ? h('div', { className: 'pe-desc' }, desc) : null),
    control)
}

/** Custom dropdown: same pill trigger as the shell, but the opened list is ours to style. */
function SectionSelect({ value, options, disabled, onChange }: {
  value: string
  options: Array<[string, string]>
  disabled?: boolean
  onChange: (next: string) => void
}) {
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (!open) return undefined
    const onPointerDown = (event: MouseEvent): void => {
      if (wrapRef.current !== null && event.target instanceof Node && !wrapRef.current.contains(event.target)) setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  const current = options.find(([id]) => id === value) ?? options[0]
  return h('div', { className: 'pe-selectWrap', ref: wrapRef },
    h('button', {
      type: 'button',
      className: 'pe-select',
      disabled: disabled === true,
      'aria-haspopup': 'listbox',
      'aria-expanded': open,
      onClick: () => setOpen((prev) => !prev),
    },
      h('span', null, current?.[1] ?? ''),
      chevronGlyph()),
    open
      ? h('div', { className: 'pe-menu', role: 'listbox' },
        options.map(([id, label]) => h('button', {
          key: id,
          type: 'button',
          role: 'option',
          'aria-selected': id === value,
          className: 'pe-item',
          'data-active': id === value ? 'true' : undefined,
          onClick: () => {
            onChange(id)
            setOpen(false)
          },
        },
          h('span', null, label),
          id === value ? checkGlyph() : null)))
      : null)
}

function SettingsSection(props: any) {
  ensureSettingsCss()
  const scope = props?.scope
  const [snapshot, setSnapshot] = useState(() => (scope ? scope.getSnapshot() : undefined))
  useEffect(() => {
    if (scope === undefined) return undefined
    return scope.subscribe(() => setSnapshot(scope.getSnapshot()))
  }, [scope])

  const value = useMemo(() => {
    if (snapshot === undefined) return {}
    if (snapshot.status === 'ready') return snapshot.value ?? {}
    return {}
  }, [snapshot])

  const set = useCallback((field: string, next: unknown) => {
    if (scope !== undefined) void scope.set(field, next)
  }, [scope])

  if (scope === undefined) return null

  const enabled = value.enabled !== false
  const style = typeof value.style === 'string' ? value.style : 'structured'
  const modelMode = typeof value.modelMode === 'string' ? value.modelMode : 'follow'
  const provider = typeof value.provider === 'string' ? value.provider : ''
  const model = typeof value.model === 'string' ? value.model : ''

  const rows: unknown[] = [
    sectionRow('启用提示词增强按钮', '关闭后 composer 里的 ✨ 按钮不再出现。',
      h('input', {
        type: 'checkbox',
        className: 'pe-check',
        checked: enabled,
        onChange: (event: any) => set('enabled', event.target.checked === true),
      })),
    sectionRow('改写风格', '决定按钮点下去怎么改写你的说法。',
      SectionSelect({
        value: style,
        options: STYLE_OPTIONS,
        disabled: !enabled,
        onChange: (next) => set('style', next),
      })),
    sectionRow('模型', '默认跟随当前会话用的模型；也可以固定一个便宜的模型专跑改写。',
      SectionSelect({
        value: modelMode,
        options: MODEL_OPTIONS,
        disabled: !enabled,
        onChange: (next) => set('modelMode', next),
      })),
  ]

  if (modelMode === 'fixed') {
    rows.push(sectionRow('固定路由', '形如 provider=opencode-go、model=deepseek-flash。',
      h('div', { className: 'pe-route' },
        h('input', {
          className: 'pe-input',
          style: { width: 140 },
          placeholder: 'provider',
          value: provider,
          disabled: !enabled,
          onChange: (event: any) => set('provider', String(event.target.value)),
        }),
        h('input', {
          className: 'pe-input',
          style: { width: 160 },
          placeholder: 'model',
          value: model,
          disabled: !enabled,
          onChange: (event: any) => set('model', String(event.target.value)),
        }))))
  }


  return h('div', { 'data-testid': 'prompt-enhance-settings', style: { padding: '4px 0 12px' } },
    h('div', { style: { marginBottom: 8 } },
      h('div', { style: { fontSize: 16, fontWeight: 600, lineHeight: '24px', color: 'var(--dsw-alias-label-primary, #111827)' } }, '提示词增强'),
      h('div', { className: 'pe-desc', style: { marginTop: 4 } },
        'composer 输入框旁 ✨ 按钮的行为：改写风格与所用模型。')),
    rows)
}

/* ───────────────────── 官方同款图标 ───────────────────── */

/** SVG 命名空间（DOM 装饰不走 React，直接建节点）。 */
const SVG_NS = 'http://www.w3.org/2000/svg'

/** `@deepseek-ai/dsh-client-ui-primitives` 的 IconSparkle16 三条路径（原样照抄，风格与整套图标一致）。 */
const SPARKLE_PATHS = [
  'M6.1 3.1Q6.6 7.8 11.3 8.3Q6.6 8.8 6.1 13.5Q5.6 8.8 0.9 8.3Q5.6 7.8 6.1 3.1Z',
  'M11.9 1Q12.2 3.7 14.9 4Q12.2 4.3 11.9 7Q11.6 4.3 8.9 4Q11.6 3.7 11.9 1Z',
  'M12.5 9.4Q12.7 11.4 14.7 11.6Q12.7 11.8 12.5 13.8Q12.3 11.8 10.3 11.6Q12.3 11.4 12.5 9.4Z',
]

/** Build the sparkle glyph: 16×16, `currentColor`, same geometry as the SDK icon. */
function sparkleIcon(): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg')
  svg.setAttribute('width', '16')
  svg.setAttribute('height', '16')
  svg.setAttribute('viewBox', '0 0 16 16')
  svg.setAttribute('fill', 'none')
  svg.setAttribute('aria-hidden', 'true')
  svg.style.flex = 'none'
  for (const d of SPARKLE_PATHS) {
    const path = document.createElementNS(SVG_NS, 'path')
    path.setAttribute('d', d)
    path.setAttribute('fill', 'currentColor')
    svg.appendChild(path)
  }
  return svg
}
