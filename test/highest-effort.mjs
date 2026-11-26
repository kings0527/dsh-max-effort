import assert from 'node:assert/strict'
import { apply, highestEffort } from '../index.js'

// --- highestEffort -------------------------------------------------------
assert.equal(highestEffort(undefined), undefined)
assert.equal(highestEffort({ efforts: [] }), undefined)
assert.equal(highestEffort({ efforts: [{ id: 'off' }] }), undefined)
assert.equal(
  highestEffort({ efforts: [{ id: 'off' }, { id: 'low' }, { id: 'high' }, { id: 'max' }] }),
  'max',
  'DeepSeek ladder picks max',
)
assert.equal(
  highestEffort({ efforts: [{ id: 'off' }, { id: 'minimal' }, { id: 'low' }, { id: 'medium' }, { id: 'high' }, { id: 'xhigh' }] }),
  'xhigh',
  'no max entry falls back to the greatest advertised level',
)
assert.equal(highestEffort({ efforts: [{ id: 'low' }] }), 'low')
assert.equal(highestEffort({ efforts: [{ id: 'off' }, { id: 'low' }, { id: 'max' }, { id: 'max-plus' }] }), 'max')

// --- apply ---------------------------------------------------------------
// The fake mirrors the real LlmRuntime seams this plugin wraps:
// `resolveModelInfoFor` is the shared resolution point behind both the public
// `resolveModelInfo` and `resolveCallConfig`'s default materialization.
function fakeCtx(modelInfo) {
  const listeners = new Map()
  const disposers = []
  // The adapter's own route metadata, which `prepareCall` uses through
  // `adapter.prepareCall()` — deliberately NOT the patched
  // `resolveModelInfoFor` the catalog seam wraps.
  const adapterModelInfo = async (provider, model) => modelInfo(provider, model)
  const raw = {
    async resolveModelInfoFor(provider, model) {
      return modelInfo(provider, model)
    },
    async resolveModelInfo(provider, model) {
      return this.resolveModelInfoFor(provider, model)
    },
    async prepareCall(config, _signal, configure) {
      const info = await adapterModelInfo(config.provider, config.model)
      const { provider, model, ...controls } = config
      const chosen = configure === undefined ? controls : configure(controls, info)
      const reasoning = info?.reasoning
      const requested = chosen.reasoningEffort
      let resolvedConfig = { provider, model, ...chosen }
      if (reasoning === undefined) {
        if (requested !== undefined) throw new Error(`unsupported reasoning effort ${requested}`)
      } else {
        const effective = requested ?? reasoning.defaultEffort
        if (effective !== undefined) {
          if (!reasoning.efforts.some((effort) => effort.id === effective)) {
            throw new Error(`unsupported reasoning effort ${effective}`)
          }
          if (requested !== effective) resolvedConfig = { ...resolvedConfig, reasoningEffort: effective }
        }
      }
      return { config: resolvedConfig, adapterDefaults: {} }
    },
    async resolveCallConfig(config) {
      const info = await this.resolveModelInfoFor(config.provider, config.model)
      const reasoning = info.reasoning
      if (reasoning === undefined) return { ...config }
      const effective = config.reasoningEffort ?? reasoning.defaultEffort
      if (effective === undefined) return { ...config }
      if (!reasoning.efforts.some((effort) => effort.id === effective)) {
        throw new Error(`unsupported reasoning effort ${effective}`)
      }
      return { ...config, reasoningEffort: effective }
    },
  }
  // Mimic Cordis: `ctx.llm` is a traceable proxy that exposes the raw service
  // under Symbol.for('cordis.original').
  const view = new Proxy(raw, {
    get(target, prop, receiver) {
      if (prop === Symbol.for('cordis.original')) return target
      return Reflect.get(target, prop, receiver)
    },
  })
  const ctx = {
    llm: view,
    logger: { warn() {} },
    emit() {},
    effect(callback) {
      const dispose = callback()
      if (typeof dispose === 'function') disposers.push(dispose)
      return dispose
    },
    on(name, handler) {
      listeners.set(name, handler)
    },
  }
  return { ctx, listeners, disposers }
}

const deepseek = (provider, model) => ({
  provider,
  id: model,
  name: model,
  reasoning: { efforts: [{ id: 'off' }, { id: 'low' }, { id: 'high' }, { id: 'max' }], defaultEffort: 'high' },
})

// The selectModel seam: an effort-free selection is stored with the highest effort.
{
  const { ctx, disposers } = fakeCtx(deepseek)
  apply(ctx, {})
  const stored = await ctx.llm.resolveCallConfig({ provider: 'deepseek-account', model: 'deepseek-flash' })
  assert.equal(stored.reasoningEffort, 'max', 'selectModel stores max even when the client sends no effort')
  const explicit = await ctx.llm.resolveCallConfig({ provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: 'low' })
  assert.equal(explicit.reasoningEffort, 'low', 'an explicit lower effort is preserved')
  for (const dispose of disposers) dispose()
  const restored = await ctx.llm.resolveCallConfig({ provider: 'deepseek-account', model: 'deepseek-flash' })
  assert.equal(restored.reasoningEffort, 'high', 'uninstall restores the adapter default')
}

// The catalog seam: resolveModelInfo advertises the highest default.
{
  const { ctx } = fakeCtx(deepseek)
  apply(ctx, {})
  const info = await ctx.llm.resolveModelInfo('deepseek-account', 'deepseek-flash')
  assert.equal(info.reasoning.defaultEffort, 'max')
  assert.equal(info.reasoning.efforts.at(-1).id, 'max')
}

// Catalog seam can be disabled; the adapter default flows through untouched.
{
  const { ctx } = fakeCtx(deepseek)
  apply(ctx, { catalogDefault: false })
  const info = await ctx.llm.resolveModelInfo('deepseek-account', 'deepseek-flash')
  assert.equal(info.reasoning.defaultEffort, 'high')
  const stored = await ctx.llm.resolveCallConfig({ provider: 'deepseek-account', model: 'deepseek-flash' })
  assert.equal(stored.reasoningEffort, 'high')
}

// A service that refuses the override fails loudly instead of no-oping.
{
  const { ctx } = fakeCtx(deepseek)
  Object.freeze(ctx.llm)
  assert.throws(() => apply(ctx, {}), TypeError)
}

// Request safety: DSH freezes the selection before `agent/request`, so the
// plugin must never register a late effort override — even if an old profile
// still carries `requestFallback: true`. The call seam lives inside
// `prepareCall`, after that guard.
{
  const { ctx, listeners } = fakeCtx(deepseek)
  apply(ctx, { requestFallback: true })
  assert.equal(
    listeners.get('agent/request'),
    undefined,
    'the plugin never mutates a frozen request configuration',
  )
  const stored = await ctx.llm.resolveCallConfig({ provider: 'deepseek-account', model: 'deepseek-flash' })
  assert.equal(stored.reasoningEffort, 'max', 'model selection still lands on max')
}

// Call seam: a call without a stored effort really goes out at the highest
// level. This is the case the catalog seam alone cannot reach — Sessions
// resumed from a log whose selection predates this plugin.
{
  const { ctx, disposers } = fakeCtx(deepseek)
  apply(ctx, {})

  const prepared = await ctx.llm.prepareCall({ provider: 'deepseek-account', model: 'deepseek-flash' })
  assert.equal(prepared.config.reasoningEffort, 'max', 'the outgoing call carries max')

  const explicit = await ctx.llm.prepareCall({
    provider: 'deepseek-account',
    model: 'deepseek-flash',
    reasoningEffort: 'low',
  })
  assert.equal(explicit.config.reasoningEffort, 'low', 'an explicitly named effort is preserved')

  const configured = await ctx.llm.prepareCall(
    { provider: 'deepseek-account', model: 'deepseek-flash' },
    undefined,
    (controls) => ({ ...controls, temperature: 0.2 }),
  )
  assert.equal(configured.config.temperature, 0.2, "a caller's own configure still runs")
  assert.equal(configured.config.reasoningEffort, 'max')

  for (const dispose of disposers) dispose()
  const restored = await ctx.llm.prepareCall({ provider: 'deepseek-account', model: 'deepseek-flash' })
  assert.equal(restored.config.reasoningEffort, 'high', 'uninstall restores the adapter default')
}

// Call seam can be disabled; the adapter default flows through untouched.
{
  const { ctx } = fakeCtx(deepseek)
  apply(ctx, { callDefault: false })
  const prepared = await ctx.llm.prepareCall({ provider: 'deepseek-account', model: 'deepseek-flash' })
  assert.equal(prepared.config.reasoningEffort, 'high')
}

// A model without reasoning metadata keeps its call configuration.
{
  const { ctx } = fakeCtx(() => ({ provider: 'acme', id: 'plain', name: 'plain' }))
  apply(ctx, {})
  const prepared = await ctx.llm.prepareCall({ provider: 'acme', model: 'plain' })
  assert.equal(prepared.config.reasoningEffort, undefined)
}

// DSH 0.2.2 normalizeModelInfo seam: when both catalogDefault and callDefault
// are enabled, raising defaultEffort in `normalizeModelInfo` makes `prepareCall`
// materialize `max` while keeping `adapterDefaults.reasoningEffort === true`
// (so `dsh-agent` does not mistake a defaulted level for an explicit user pin)
// and exposing `model.reasoning.defaultEffort === 'max'` to `configure`.
{
  const disposers = []
  const raw = {
    normalizeModelInfo(_reg, model, resolved) {
      return { ...resolved, id: model }
    },
    async resolveModelInfo(provider, model) {
      return this.normalizeModelInfo({ provider: { id: provider } }, model, deepseek(provider, model))
    },
    async prepareCall(config, _signal, configure) {
      const info = this.normalizeModelInfo(
        { provider: { id: config.provider } },
        config.model,
        deepseek(config.provider, config.model),
      )
      const { provider, model, ...controls } = config
      const proposed = configure === undefined ? config : { ...configure(controls, info), provider, model }
      const effective = proposed.reasoningEffort ?? info.reasoning?.defaultEffort
      const resolvedConfig = effective === undefined ? proposed : { ...proposed, reasoningEffort: effective }
      const adapterDefaults =
        proposed.reasoningEffort === undefined && resolvedConfig.reasoningEffort !== undefined
          ? { reasoningEffort: true }
          : {}
      return { config: resolvedConfig, adapterDefaults }
    },
  }
  const view = new Proxy(raw, {
    get(target, prop, receiver) {
      if (prop === Symbol.for('cordis.original')) return target
      return Reflect.get(target, prop, receiver)
    },
  })
  const ctx = {
    llm: view,
    logger: { warn() {} },
    emit() {},
    effect(cb) {
      const d = cb()
      if (typeof d === 'function') disposers.push(d)
      return d
    },
  }
  apply(ctx, {})
  let seenDefault
  const prepared = await ctx.llm.prepareCall(
    { provider: 'deepseek-account', model: 'deepseek-flash' },
    undefined,
    (controls, model) => {
      seenDefault = model.reasoning?.defaultEffort
      return controls
    },
  )
  assert.equal(seenDefault, 'max', 'configure sees the raised defaultEffort')
  assert.equal(prepared.config.reasoningEffort, 'max')
  assert.equal(prepared.adapterDefaults.reasoningEffort, true, 'defaulted effort preserves adapterDefaults provenance')
  for (const d of disposers) d()
  const after = await ctx.llm.prepareCall({ provider: 'deepseek-account', model: 'deepseek-flash' })
  assert.equal(after.config.reasoningEffort, 'high')
}

// Regression guard: a release that keeps `normalizeModelInfo` but stops
// routing `prepareCall` through it must still send the highest level. The
// catalog path is patched, yet the call seam sees the adapter's own default
// (`high`) and raises the call itself.
{
  const disposers = []
  const adapterInfo = (provider, model) => deepseek(provider, model)
  const raw = {
    normalizeModelInfo(_reg, model, resolved) {
      return { ...resolved, id: model }
    },
    async resolveModelInfo(provider, model) {
      return this.normalizeModelInfo({ provider: { id: provider } }, model, adapterInfo(provider, model))
    },
    async prepareCall(config, _signal, configure) {
      // Deliberately bypasses `normalizeModelInfo`, like a runtime rewiring.
      const info = adapterInfo(config.provider, config.model)
      const { provider, model, ...controls } = config
      const proposed = configure === undefined ? config : { ...configure(controls, info), provider, model }
      return { config: proposed, adapterDefaults: {} }
    },
  }
  const view = new Proxy(raw, {
    get(target, prop, receiver) {
      if (prop === Symbol.for('cordis.original')) return target
      return Reflect.get(target, prop, receiver)
    },
  })
  const ctx = {
    llm: view,
    logger: { warn() {} },
    emit() {},
    effect(cb) {
      const d = cb()
      if (typeof d === 'function') disposers.push(d)
      return d
    },
  }
  apply(ctx, {})
  const info = await ctx.llm.resolveModelInfo('deepseek-account', 'deepseek-flash')
  assert.equal(info.reasoning.defaultEffort, 'max', 'catalog still advertises max')
  const prepared = await ctx.llm.prepareCall({ provider: 'deepseek-account', model: 'deepseek-flash' })
  assert.equal(prepared.config.reasoningEffort, 'max', 'the call seam covers a rewired prepareCall')
  for (const d of disposers) d()
}

console.log('highest-effort: all assertions passed')
