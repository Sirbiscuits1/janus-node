/**
 * capabilities.js — find out what each listed model can actually do, by asking
 * it, and publish the answer.
 *
 * WHY PROBE INSTEAD OF DECLARE
 *
 * A declared capability is a claim. Half the small open models advertise tool
 * support and then answer in prose anyway, because support was bolted on in a
 * fine-tune that did not take. If we copy the model card into a flag, we
 * inherit its optimism and the buyer discovers the truth after paying.
 *
 * A probe costs one tiny request per model, once, and it is the difference
 * between "the vendor says this works" and "we tried it and it worked".
 *
 * WHAT IT IS NOT
 *
 * Not a guarantee. A model that used a tool once may decline the next time —
 * tool use is a choice, not a feature flag. So the honest report is three-way:
 * `true` (we saw it work), `false` (we asked and it answered in prose), and
 * `unknown` (not yet probed, or the probe itself failed). Reporting `false` for
 * "we have not looked" would be a lie with the same shape as a measurement.
 */

/**
 * The smallest request that forces the decision.
 *
 * Deliberately unanswerable from the model's own knowledge — it cannot know a
 * live temperature — so a model that CAN call the tool has every reason to, and
 * one that answers in prose has told us something real. A question it could
 * answer itself would make a capable model look incapable.
 */
const PROBE_TOOLS = [{
  type: 'function',
  function: {
    name: 'get_current_temperature',
    description: 'Get the current temperature in a named city, in celsius.',
    parameters: {
      type: 'object',
      properties: {
        city: { type: 'string', description: 'The city to look up, e.g. "Oslo".' }
      },
      required: ['city']
    }
  }
}]

const PROBE_MESSAGES = [
  { role: 'user', content: 'What is the temperature in Oslo right now?' }
]

/** Never let a probe hang a boot or a refresh. */
const PROBE_TIMEOUT_MS = 20_000

/**
 * Ask one model whether it will call a tool.
 *
 * Returns `{ tools, jsonMode, error }` where each capability is true, false or
 * 'unknown'. Never throws: a provider that cannot probe should still serve.
 */
export const probeModel = async ({ baseUrl, apiKey, model, fetchImpl = fetch }) => {
  const url = `${String(baseUrl).replace(/\/$/, '')}/chat/completions`

  const ask = async (body) => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS)
    try {
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(body),
        signal: controller.signal
      })
      const text = await res.text()
      if (!res.ok) throw new Error(`${res.status}: ${text.slice(0, 200)}`)
      return JSON.parse(text)
    } finally {
      clearTimeout(timer)
    }
  }

  let tools = 'unknown'
  let jsonMode = 'unknown'
  let error = null

  try {
    const data = await ask({
      model,
      messages: PROBE_MESSAGES,
      tools: PROBE_TOOLS,
      tool_choice: 'auto',
      // Enough for a call, not enough to write an essay if it refuses.
      max_tokens: 64
    })
    const calls = data?.choices?.[0]?.message?.tool_calls
    tools = Array.isArray(calls) && calls.length > 0
  } catch (err) {
    // An upstream that rejects the request outright — "this model does not
    // support tools" — is a genuine `false`, not an unknown. Anything else
    // (timeout, 500, network) leaves us honestly ignorant.
    const message = String(err?.message ?? '')
    if (/tool|function/i.test(message) && /support|invalid|not allowed|unsupported/i.test(message)) {
      tools = false
    }
    error = message.slice(0, 200)
  }

  try {
    const data = await ask({
      model,
      messages: [{ role: 'user', content: 'Reply with {"ok":true} and nothing else.' }],
      response_format: { type: 'json_object' },
      max_tokens: 32
    })
    const content = data?.choices?.[0]?.message?.content ?? ''
    JSON.parse(content)
    jsonMode = true
  } catch {
    // A parse failure here means the model ignored the format, which is a real
    // `false`. A transport failure would also land here, so this is the weaker
    // of the two probes — which is why tools is the one buyers see first.
    jsonMode = false
  }

  return { tools, jsonMode, error, probedAt: new Date().toISOString() }
}

/**
 * Probe results for every listed model, refreshed alongside the rate card.
 *
 * Probing happens in the background and never blocks serving. Until a model has
 * been probed its capabilities read `unknown`, which is the truth.
 */
export class Capabilities {
  #results = new Map()
  #inFlight = new Set()
  #config

  constructor ({ baseUrl, apiKey, fetchImpl = fetch } = {}) {
    this.#config = { baseUrl, apiKey, fetchImpl }
  }

  get (model) {
    return this.#results.get(model) ?? { tools: 'unknown', jsonMode: 'unknown', probedAt: null }
  }

  /** Every result, for the /v1/models response. */
  all () {
    return Object.fromEntries(this.#results)
  }

  /**
   * Probe any model we have not seen yet. Safe to call repeatedly — a model
   * already probed, or currently being probed, is skipped, so a refresh loop
   * does not spend money on every tick.
   */
  async ensure (models = []) {
    const todo = models.filter((m) => !this.#results.has(m) && !this.#inFlight.has(m))
    if (todo.length === 0) return this.all()

    await Promise.all(todo.map(async (model) => {
      this.#inFlight.add(model)
      try {
        const result = await probeModel({ ...this.#config, model })
        this.#results.set(model, result)
        console.log(
          `[capabilities] ${model}: tools=${result.tools} json=${result.jsonMode}` +
          (result.error ? ` (${result.error})` : '')
        )
      } catch (err) {
        console.warn(`[capabilities] ${model} probe failed: ${err.message}`)
      } finally {
        this.#inFlight.delete(model)
      }
    }))

    return this.all()
  }

  /** Force a re-probe, e.g. after changing upstreams. */
  reset (model = null) {
    if (model) this.#results.delete(model)
    else this.#results.clear()
  }
}

/**
 * The OpenAI `/v1/models` shape, with our extras under a namespaced key.
 *
 * Standard fields stay exactly standard so a stock client can parse this
 * without special-casing Janus, and everything of ours lives under `janus`
 * where it cannot collide.
 */
export const buildModelsResponse = ({ rateCard, capabilities, endpoint }) => ({
  object: 'list',
  data: rateCard.models().map((model) => {
    const rates = rateCard.get(model) ?? {}
    const caps = capabilities.get(model)
    return {
      id: model,
      object: 'model',
      owned_by: 'janus',
      janus: {
        endpoint,
        satsPerMInput: rates.satsPerMInput,
        satsPerMOutput: rates.satsPerMOutput,
        contextTokens: rates.contextTokens,
        maxOutputTokens: rates.maxOutputTokens,
        quantization: rates.quantization,
        listing: rates.txid ? `${rates.txid}:${rates.outputIndex}` : null,
        capabilities: {
          tools: caps.tools,
          jsonMode: caps.jsonMode,
          // Say when, so a stale result is visibly stale rather than implicitly
          // current. A capability measured six weeks ago against a different
          // upstream is not evidence about today.
          probedAt: caps.probedAt
        }
      }
    }
  })
})
