// dsh-max-effort — Host plugin.
//
// Goal: the composer's "Max" is real. Switching models in the Web GUI must land
// on the highest reasoning effort the model advertises, and a call that names
// no effort must actually be sent at that level instead of only showing the
// label.
//
// Three seams:
//
// 1. `llm.resolveModelInfoFor()` is the one internal resolution point behind
//    both the public `llm.resolveModelInfo()` (which feeds
//    `sessionController.modelCatalog()`, the catalog behind the composer model
//    seat and the `/model` popup) and `llm.resolveCallConfig()` (which
//    `session.selectModel` uses to normalize and store a Session's selection).
//    Raising `reasoning.defaultEffort` there makes every model switch carry
//    the highest effort even when the client sends none — the client's caption
//    then reads the stored selection, not its cached catalog.
//
// 2. `llm.prepareCall()` is where the Harness logs the request header and
//    dispatches the provider call. Its third argument, `ConfigureCall`, is a
//    pure synchronous hook that picks the concrete controls from captured
//    model metadata *before* defaults and validation are applied. Passing one
//    that raises an effort-free call to the highest advertised level makes the
//    effort real for Sessions that carry no stored selection (Sessions resumed
//    from before this plugin, subagents, titles) — and the logged header
//    records it, so the next step re-derives the same value.
//
// 3. `llm/adapters-updated` is announced after the patch so connected clients
//    refetch their cached model catalog; the client caches it per connection
//    and a page that connected while the composition was still starting would
//    otherwise keep the pre-patch defaults.
//
// Why not the `agent/request` waterfall: DSH 0.2.2 rejects a proposed effort
// that differs from the one step preparation fixed (`agent-loop` agent.ts
// throws "agent/request proposed reasoning effort …"), which fails the whole
// turn. `prepareCall`'s configure hook runs after that check, inside the call
// the loop already froze, so it is the supported seam.
//
// The call seam degrades safely: an adapter with no reasoning metadata, or one
// whose only level is `off`, keeps its current default and the request is left
// untouched. The resolution and call seams fail loudly when the Host API they
// wrap is gone, because a silent no-op would look like "Default" all over
// again.

export const name = 'max-effort'
export const inject = ['llm']

/**
 * `ctx.llm` is a traceable proxy: reads wrap every method in another proxy, so
 * writes and identity checks must go through the raw service object Cordis
 * exposes under `Symbol.for('cordis.original')`.
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
 * @param config.catalogDefault - advertise the highest effort as the model default (default true).
 * @param config.callDefault - lift effort-free calls to the highest effort inside `prepareCall` (default true).
 *
 * The retired `requestFallback` switch is ignored: it used to register the
 * `agent/request` seam this release's loop rejects.
 */
export function apply(ctx, config = {}) {
  const options = {
    catalogDefault: config?.catalogDefault !== false,
    callDefault: config?.callDefault !== false,
  }
  const llm = ctx.llm
  const target = llm[CORDIS_ORIGINAL] ?? llm

  if (options.catalogDefault) {
    // `ctx.llm` is a read-through traceable proxy; write to the raw service.
    const original = target.resolveModelInfoFor
    if (typeof original !== 'function') {
      throw new Error('max-effort: llm.resolveModelInfoFor is unavailable, so model-switch defaults cannot be raised')
    }
    const patched = async function resolveModelInfoForWithHighestDefault(...args) {
      return withHighestDefault(await original.apply(this, args))
    }
    target.resolveModelInfoFor = patched
    if (target.resolveModelInfoFor !== patched) {
      throw new Error('max-effort: llm.resolveModelInfoFor did not accept the catalog override')
    }
    ctx.effect(() => () => {
      if (target.resolveModelInfoFor === patched) target.resolveModelInfoFor = original
    })

    // The client fetches its model catalog once per connection and refreshes it
    // only on a registry/settings/credential notification. A page that connected
    // while the composition was still starting holds the pre-patch defaults
    // until one of those fires, so announce the new catalog after patching.
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

  if (options.callDefault) {
    // `prepareCall` applies defaults and validates the controls *after* calling
    // `configure`, so an effort supplied here is indistinguishable from one the
    // step itself fixed: it is logged in the request header and sent to the
    // provider. A caller that already named an effort (a stored selection, a
    // pinned level) keeps it; an effort-free caller gets the highest level the
    // captured model advertises.
    const originalPrepareCall = target.prepareCall
    if (typeof originalPrepareCall !== 'function') {
      throw new Error('max-effort: llm.prepareCall is unavailable, so effort-free calls cannot be raised')
    }
    const patchedPrepareCall = async function prepareCallWithHighestEffort(callConfig, signal, configure) {
      const raiseEffort = (controls, model) => {
        const chosen = configure === undefined ? controls : configure(controls, model)
        if (chosen === null || typeof chosen !== 'object') return chosen
        if (chosen.reasoningEffort !== undefined) return chosen
        const highest = highestEffort(model?.reasoning)
        if (highest === undefined) return chosen
        return { ...chosen, reasoningEffort: highest }
      }
      return originalPrepareCall.call(this, callConfig, signal, raiseEffort)
    }
    target.prepareCall = patchedPrepareCall
    if (target.prepareCall !== patchedPrepareCall) {
      throw new Error('max-effort: llm.prepareCall did not accept the request override')
    }
    ctx.effect(() => () => {
      if (target.prepareCall === patchedPrepareCall) target.prepareCall = originalPrepareCall
    })
  }
}
