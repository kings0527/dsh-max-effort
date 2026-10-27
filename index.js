// dsh-max-effort — Host plugin.
//
// Goal: switching models in the Web GUI must land on the highest reasoning
// effort the model advertises, so the user never has to open the effort menu
// for a second click.
//
// Two seams:
//
// 1. `llm.resolveModelInfo()` feeds `sessionController.modelCatalog()` (the
//    catalog behind the composer model seat and the `/model` popup). Both
//    entries build a selection from the clicked model's `reasoning.defaultEffort`
//    and omit the effort when it is undefined — which is what renders as
//    "Default". Advertising the highest effort there makes every model switch
//    carry it, and stores it in the Session selection.
//
// 2. `agent/request` returns the frozen call configuration before
//    `llm.prepareCall()` validates it. A request that names no effort (older
//    stored selections, subagents, titles) is lifted to the same highest
//    advertised level. An explicit effort is preserved.
//
// The request seam degrades safely: an adapter with no reasoning metadata, or
// one whose only level is `off`, keeps its current default and the request is
// left untouched. The catalog seam fails loudly when the Host API it wraps is
// gone, because a silent no-op would look like "Default" all over again.

export const name = 'max-effort'
export const inject = ['llm']

/**
 * `ctx.llm` is a traceable proxy: reads wrap every method in another proxy, so
 * identity checks must go through the raw service object Cordis exposes under
 * `Symbol.for('cordis.original')`.
 */
const CORDIS_ORIGINAL = Symbol.for('cordis.original')

/**
 * Pick the highest selectable effort from one adapter's reasoning metadata.
 *
 * The Harness contract orders `efforts` from least to greatest, so the last
 * non-`off` entry wins; an explicit `max` entry wins over a custom tail id.
 *
 * @param reasoning - the model's `LlmModelReasoningInfo`, if it has one.
 * @returns the effort id, or undefined when the model offers nothing above off.
 */
export function highestEffort(reasoning) {
  const efforts = reasoning?.efforts
  if (!Array.isArray(efforts) || efforts.length === 0) return undefined
  const selectable = efforts.filter(
    (effort) => effort !== null && typeof effort === 'object' && typeof effort.id === 'string' && effort.id.length > 0 && effort.id !== 'off',
  )
  if (selectable.length === 0) return undefined
  const explicitMax = selectable.find((effort) => effort.id === 'max')
  return (explicitMax ?? selectable[selectable.length - 1]).id
}

/**
 * Return the same model metadata with `reasoning.defaultEffort` raised to the
 * highest advertised effort.
 *
 * @param info - detached `LlmResolvedModelInfo` from the LLM registry.
 * @returns the original object when nothing changes, otherwise a shallow copy.
 */
function withHighestDefault(info) {
  if (info === null || typeof info !== 'object' || info.reasoning === undefined) return info
  const highest = highestEffort(info.reasoning)
  if (highest === undefined || highest === info.reasoning.defaultEffort) return info
  return {
    ...info,
    reasoning: { ...info.reasoning, defaultEffort: highest },
  }
}

/**
 * Plugin body.
 *
 * @param ctx - owning Host context.
 * @param config - optional switches from `cordis.patch.yml`.
 * @param config.catalogDefault - advertise the highest effort as the catalog default (default true).
 * @param config.requestFallback - lift effort-free requests to the highest effort (default true).
 */
export function apply(ctx, config = {}) {
  const options = {
    catalogDefault: config?.catalogDefault !== false,
    requestFallback: config?.requestFallback !== false,
  }
  const llm = ctx.llm

  // The client fetches its model catalog once per connection and refreshes it
  // only on a registry/settings/credential notification. A page that connected
  // while the composition was still starting holds the pre-patch defaults until
  // one of those fires, so announce the new catalog after patching.
  if (options.catalogDefault) {
    // `ctx.llm` is a read-through traceable proxy; write to the raw service.
    const target = llm[CORDIS_ORIGINAL] ?? llm
    const original = target.resolveModelInfo
    if (typeof original !== 'function') {
      throw new Error('max-effort: llm.resolveModelInfo is unavailable, so model-switch defaults cannot be raised')
    }
    const patched = async function resolveModelInfoWithHighestDefault(...args) {
      return withHighestDefault(await original.apply(this, args))
    }
    target.resolveModelInfo = patched
    if (target.resolveModelInfo !== patched) {
      throw new Error('max-effort: llm.resolveModelInfo did not accept the catalog override')
    }
    ctx.effect(() => () => {
      if (target.resolveModelInfo === patched) target.resolveModelInfo = original
    })

    const announce = () => {
      try {
        ctx.emit('llm/adapters-updated')
      } catch (error) {
        ctx.logger?.warn?.(`max-effort: could not announce the refreshed model catalog: ${String(error)}`)
      }
    }
    announce()
    // A client that connects during this apply misses the immediate announce.
    const timers = [setTimeout(announce, 1500), setTimeout(announce, 5000)]
    for (const timer of timers) timer.unref?.()
    ctx.effect(() => () => {
      for (const timer of timers) clearTimeout(timer)
    })
  }

  if (options.requestFallback) {
    ctx.on('agent/request', async (_payload, next) => {
      const frozen = await next()
      if (frozen === null || typeof frozen !== 'object') return frozen
      if (frozen.reasoningEffort !== undefined) return frozen
      try {
        const info = await llm.resolveModelInfo(frozen.provider, frozen.model)
        const highest = highestEffort(info?.reasoning)
        if (highest === undefined) return frozen
        return { ...frozen, reasoningEffort: highest }
      } catch {
        // Resolution failures surface through prepareCall with their own error;
        // never mask them by rewriting the config here.
        return frozen
      }
    })
  }
}
