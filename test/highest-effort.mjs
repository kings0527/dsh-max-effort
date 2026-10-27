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
  const raw = {
    async resolveModelInfoFor(provider, model) {
      return modelInfo(provider, model)
    },
    async resolveModelInfo(provider, model) {
      return this.resolveModelInfoFor(provider, model)
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

// Request seam: only effort-free configurations are lifted.
{
  const { ctx, listeners } = fakeCtx(deepseek)
  apply(ctx, {})
  const handler = listeners.get('agent/request')
  assert.equal(typeof handler, 'function')

  const frozen = { provider: 'deepseek-account', model: 'deepseek-flash' }
  assert.equal((await handler({}, async () => frozen)).reasoningEffort, 'max')

  const explicit = { provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: 'low' }
  assert.equal(await handler({}, async () => explicit), explicit, 'explicit effort is preserved')

  // requestFallback can be disabled.
  const { ctx: ctx2, listeners: listeners2 } = fakeCtx(deepseek)
  apply(ctx2, { requestFallback: false })
  assert.equal(listeners2.get('agent/request'), undefined)

  // A model without reasoning metadata is left alone.
  const { ctx: ctx4, listeners: listeners4 } = fakeCtx(() => ({ provider: 'acme', id: 'plain', name: 'plain' }))
  apply(ctx4, {})
  const plain = { provider: 'acme', model: 'plain' }
  assert.equal(await listeners4.get('agent/request')({}, async () => plain), plain)

  // A resolution failure keeps the configuration untouched.
  const { ctx: ctx3, listeners: listeners3 } = fakeCtx(() => {
    throw new Error('unavailable')
  })
  apply(ctx3, {})
  const untouched = { provider: 'acme', model: 'plain' }
  assert.equal(await listeners3.get('agent/request')({}, async () => untouched), untouched)
}

console.log('highest-effort: all assertions passed')
