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

// Tool definitions are serialised into the prompt by the chat template, so the
// upstream bills for them as input. Pricing only `messages` therefore quoted
// less than the request cost, and the shortfall was hidden by the unused
// output allowance — until a reply actually used its max_tokens, at which
// point the provider served at a loss. Measured with a realistic four-parameter
// tool schema, this is 200-1,500 tokens that used to be free.
//
// The extra overhead covers the wrapper the template puts around each function
// definition, which raw JSON length does not capture.
export const PER_TOOL_OVERHEAD = 12
export const TOOLS_BLOCK_OVERHEAD = 16

export const estimateTokens = (text) =>
  Math.max(1, Math.ceil(String(text).length / CHARS_PER_TOKEN))

/**
 * Tokens for one message, including a tool-call payload.
 *
 * An assistant message carrying tool calls has `content: null` and the real
 * payload in `tool_calls`. Counting only `content` priced a multi-turn agent
 * conversation as though the calls it had already made were free — and they are
 * resent in full on every subsequent turn, so the gap widens with each one.
 */
export const estimateOneMessage = (m) => {
  const content = typeof m?.content === 'string'
    ? m.content
    : JSON.stringify(m?.content ?? '')

  let tokens = estimateTokens(content) + estimateTokens(m?.role ?? '')

  if (Array.isArray(m?.tool_calls) && m.tool_calls.length > 0) {
    tokens += estimateTokens(JSON.stringify(m.tool_calls))
  }
  // `tool` messages carry the id the call is answering; small, but real.
  if (m?.tool_call_id) tokens += estimateTokens(m.tool_call_id)
  if (m?.name) tokens += estimateTokens(m.name)

  return tokens
}

export const estimateMessageTokens = (messages) => {
  const arr = Array.isArray(messages) ? messages : []
  const textTokens = arr.reduce((sum, m) => sum + estimateOneMessage(m), 0)
  return textTokens + arr.length * PER_MESSAGE_OVERHEAD + CONVERSATION_OVERHEAD
}

/** Tokens the tool definitions add to the prompt. Zero when there are none. */
export const estimateToolTokens = (tools, toolChoice) => {
  const arr = Array.isArray(tools) ? tools : []
  if (arr.length === 0) return 0

  const schema = arr.reduce(
    (sum, t) => sum + estimateTokens(JSON.stringify(t)) + PER_TOOL_OVERHEAD, 0)

  // tool_choice naming a specific function adds a little more.
  const choice = toolChoice && typeof toolChoice === 'object'
    ? estimateTokens(JSON.stringify(toolChoice))
    : 0

  return schema + choice + TOOLS_BLOCK_OVERHEAD
}

// Must be deterministic for a given body: the 402 quotes once, the client pays
// that exact amount and re-sends the same body. A quote that moved between the
// two calls would fail validation.
export const quoteRequest = (body, rates) => {
  const messages = body?.messages ?? []
  const messageTokens = estimateMessageTokens(messages)
  const toolTokens = estimateToolTokens(body?.tools, body?.tool_choice)

  // response_format with a JSON schema is also serialised into the prompt.
  const formatTokens = body?.response_format?.json_schema
    ? estimateTokens(JSON.stringify(body.response_format.json_schema))
    : 0

  const inputTokens = messageTokens + toolTokens + formatTokens

  const requested = Number(body?.max_tokens)
  const maxOutputTokens = Math.min(
    Number.isInteger(requested) && requested > 0 ? requested : DEFAULT_MAX_OUTPUT,
    rates.maxOutputTokens
  )

  const sats = Math.ceil(
    (inputTokens / 1e6) * rates.satsPerMInput +
    (maxOutputTokens / 1e6) * rates.satsPerMOutput
  )

  return {
    inputTokens,
    maxOutputTokens,
    sats: Math.max(1, sats),
    // Broken out so the provider can see where a quote came from, and so
    // checkLimits can compare the true prompt size against the context window.
    breakdown: { messageTokens, toolTokens, formatTokens }
  }
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
