// Prepaid billing with no account means the price is quoted BEFORE the work,
// but output length is unknown until after. So the quote prices input tokens
// plus the caller's own max_tokens ceiling, and the provider refunds the
// difference once actual usage is known.
//
// Because unused satoshis come back, the quote can afford to be generous.
// Over-estimating costs the buyer nothing and protects the provider from
// serving at a loss.

export const DEFAULT_MAX_OUTPUT = 512

// Counting exactly needs the model's own tokenizer, and a passthrough serves
// many models. These constants are deliberately conservative.
export const CHARS_PER_TOKEN = 3.6

// Chat models wrap every message in template markup — role names, delimiters,
// priming tokens — that raw character counting misses entirely. Measured
// against DeepInfra: a 30-character single-turn prompt counted 17 tokens,
// where naive character counting predicted 9.
export const PER_MESSAGE_OVERHEAD = 8
export const CONVERSATION_OVERHEAD = 3

export const estimateTokens = (text) =>
  Math.max(1, Math.ceil(String(text).length / CHARS_PER_TOKEN))

export const estimateMessageTokens = (messages) => {
  const arr = Array.isArray(messages) ? messages : []
  const textTokens = arr.reduce((sum, m) => {
    const content = typeof m?.content === 'string'
      ? m.content
      : JSON.stringify(m?.content ?? '')
    return sum + estimateTokens(content) + estimateTokens(m?.role ?? '')
  }, 0)
  return textTokens + arr.length * PER_MESSAGE_OVERHEAD + CONVERSATION_OVERHEAD
}

// Must be deterministic for a given body: the 402 quotes once, the client pays
// that exact amount and re-sends the same body. A quote that moved between the
// two calls would fail validation.
export const quoteRequest = (body, rates) => {
  const messages = body?.messages ?? []
  const inputTokens = estimateMessageTokens(messages)

  const requested = Number(body?.max_tokens)
  const maxOutputTokens = Math.min(
    Number.isInteger(requested) && requested > 0 ? requested : DEFAULT_MAX_OUTPUT,
    rates.maxOutputTokens
  )

  const sats = Math.ceil(
    (inputTokens / 1e6) * rates.satsPerMInput +
    (maxOutputTokens / 1e6) * rates.satsPerMOutput
  )

  return { inputTokens, maxOutputTokens, sats: Math.max(1, sats) }
}

// What the request was actually worth, from the upstream's own token counts.
// This is what the buyer should end up paying; the difference is refunded.
export const settleRequest = (usage, rates) => {
  const inputTokens = Number(usage?.prompt_tokens ?? 0)
  const outputTokens = Number(usage?.completion_tokens ?? 0)
  if (!Number.isFinite(inputTokens) || !Number.isFinite(outputTokens)) return null

  const sats = Math.ceil(
    (inputTokens / 1e6) * rates.satsPerMInput +
    (outputTokens / 1e6) * rates.satsPerMOutput
  )
  return { inputTokens, outputTokens, sats: Math.max(1, sats) }
}
