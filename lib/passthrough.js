/**
 * passthrough.js — which parts of an OpenAI-shaped request cross the provider,
 * and which parts of the reply come back.
 *
 * WHY THIS FILE EXISTS
 *
 * The provider used to forward three things — model, messages, max_tokens — and
 * rebuild the response by hand as `{ role, content }`. Anything else a caller
 * sent was discarded on the way up, and anything else the upstream returned was
 * discarded on the way down.
 *
 * For plain completions that is invisible. For an agent it is fatal, and fatal
 * in the worst way: `tools` vanishes, the model answers in prose because it was
 * never told it had tools, and every layer reports success. Nobody sees an
 * error. The agent just quietly cannot work, and the obvious conclusion is that
 * the model is bad.
 *
 * Worse, `finish_reason` WAS forwarded. So an upstream that did return tool
 * calls produced `finish_reason: "tool_calls"` with no `tool_calls` array —
 * which is not a valid OpenAI response, and strict clients throw on it.
 *
 * ALLOWLIST, NOT PASSTHROUGH-EVERYTHING
 *
 * Forwarding the raw body would let a caller set fields that break the pricing
 * contract — `n: 10` multiplies output tokens by ten against a quote that
 * priced one, and `stream: true` changes the response shape the settlement code
 * expects. So fields are named explicitly, and adding one is a deliberate act.
 */

/**
 * Request fields forwarded upstream.
 *
 * `model`, `messages` and `max_tokens` are handled by the caller because they
 * come from the listing and the quote rather than from the buyer.
 */
export const FORWARDED_REQUEST_FIELDS = [
  'tools',            // the reason this file exists
  'tool_choice',
  'parallel_tool_calls',
  'temperature',
  'top_p',
  'stop',
  'seed',
  'response_format',  // json mode
  'presence_penalty',
  'frequency_penalty',
  'logit_bias',
  'user'
]

/**
 * Fields REFUSED with an explanation rather than silently dropped.
 *
 * Each of these would break the quote-then-refund contract, and a buyer who
 * sent one deserves to be told rather than charged for something different
 * from what they asked for.
 */
export const REFUSED_REQUEST_FIELDS = {
  n: 'Only one completion per request is priced. Send separate requests.',
  best_of: 'Not priced — it generates several completions and bills for all of them.',
  stream: 'Streaming is not supported yet: settlement needs the final token counts.'
}

/** Response message fields returned to the buyer, beyond role and content. */
export const FORWARDED_MESSAGE_FIELDS = [
  'tool_calls',
  'refusal',
  'annotations',
  'function_call'  // deprecated by OpenAI, still emitted by some upstreams
]

/**
 * Build the extra body to send upstream. Returns `{ extra, refused }`.
 * `refused` non-empty means answer 400 — before taking payment.
 */
export const buildUpstreamBody = (body = {}) => {
  const refused = []
  for (const [field, why] of Object.entries(REFUSED_REQUEST_FIELDS)) {
    if (body[field] !== undefined && body[field] !== null && body[field] !== false) {
      refused.push({ field, why })
    }
  }

  const extra = {}
  for (const field of FORWARDED_REQUEST_FIELDS) {
    if (body[field] !== undefined) extra[field] = body[field]
  }

  return { extra, refused }
}

/**
 * Rebuild the assistant message for the response.
 *
 * `content` is always present, even as null, because the OpenAI schema says so
 * and clients index into it. A tool-call reply legitimately has null content.
 */
export const buildResponseMessage = (upstreamMessage = {}, fallbackContent = null) => {
  const message = {
    role: upstreamMessage.role ?? 'assistant',
    content: upstreamMessage.content ?? fallbackContent ?? null
  }
  for (const field of FORWARDED_MESSAGE_FIELDS) {
    if (upstreamMessage[field] !== undefined) message[field] = upstreamMessage[field]
  }
  return message
}

/**
 * A reply claiming tool calls must carry them, and vice versa.
 *
 * This catches the exact failure the old code produced, and it is checked at
 * runtime rather than trusted: an upstream that starts stripping tool calls
 * should surface here, not in a buyer's agent three weeks later.
 */
export const checkResponseConsistency = (message, finishReason) => {
  const hasCalls = Array.isArray(message?.tool_calls) && message.tool_calls.length > 0

  if (finishReason === 'tool_calls' && !hasCalls) {
    return {
      ok: false,
      reason: 'upstream said finish_reason=tool_calls but returned no tool_calls array'
    }
  }
  if (hasCalls && finishReason !== 'tool_calls' && finishReason !== 'stop') {
    return {
      ok: false,
      reason: `tool_calls present but finish_reason is "${finishReason}"`
    }
  }
  return { ok: true, toolCalls: hasCalls ? message.tool_calls.length : 0 }
}
