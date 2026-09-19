// A passthrough to any OpenAI-compatible inference API. Deliberately
// provider-agnostic: point UPSTREAM_BASE_URL at DeepInfra, Groq, OpenRouter,
// Together or a local server and nothing else changes.

// Generation time scales with the number of tokens requested, so a fixed
// timeout fails large requests that were working fine. A 70B model running
// at roughly 25 tokens/sec needs ~160s for 4000 tokens; a flat 60s cut those
// off mid-generation and the buyer paid for an aborted call.
export const TIMEOUT_BASE_MS = 20000
export const TIMEOUT_PER_TOKEN_MS = 40

export const timeoutForTokens = (maxTokens, baseMs = TIMEOUT_BASE_MS, perTokenMs = TIMEOUT_PER_TOKEN_MS) =>
  baseMs + Math.max(0, Number(maxTokens) || 0) * perTokenMs

export class UpstreamTimeoutError extends Error {
  constructor (timeoutMs, maxTokens) {
    super(`Upstream did not respond within ${Math.round(timeoutMs / 1000)}s for ${maxTokens} max tokens`)
    this.name = 'UpstreamTimeoutError'
    this.timeoutMs = timeoutMs
  }
}

export const callUpstream = async ({
  baseUrl, apiKey, model, messages, maxTokens, timeoutMs
}) => {
  const limit = timeoutMs ?? timeoutForTokens(maxTokens)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), limit)

  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({ model, messages, max_tokens: maxTokens }),
      signal: controller.signal
    })

    const text = await res.text()
    if (!res.ok) throw new Error(`Upstream ${res.status}: ${text.slice(0, 300)}`)

    const data = JSON.parse(text)
    return {
      content: data?.choices?.[0]?.message?.content ?? '',
      finishReason: data?.choices?.[0]?.finish_reason ?? null,
      usage: data?.usage ?? null,
      upstreamModel: data?.model ?? model
    }
  } catch (err) {
    // AbortError is opaque — name the cause so a timeout is not mistaken for
    // an upstream rejection.
    if (err?.name === 'AbortError' || /aborted/i.test(String(err?.message))) {
      throw new UpstreamTimeoutError(limit, maxTokens)
    }
    throw err
  } finally {
    clearTimeout(timer)
  }
}
