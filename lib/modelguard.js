/**
 * modelguard.js — everything that must be true before we quote a request.
 *
 * Deliberately additive: it does NOT modify pricing.js. quoteRequest(body, rates)
 * and settleRequest(usage, rates) already take a rates object, so multi-model
 * support is a matter of handing them the RIGHT rates object. That is what this
 * does, plus the three checks that only make sense once listings differ.
 *
 * Order matters. resolveModel() runs BEFORE quoting (you cannot quote a model you
 * do not list). checkLimits() runs AFTER quoting, because the quote is what knows
 * how many input tokens the prompt came to.
 */

/** Request asked for a model we do not have a live listing for. */
export const ERR_UNKNOWN_MODEL = 'unknown_model'
/** Request wants a longer answer than the listing promises. */
export const ERR_OUTPUT_TOO_LONG = 'output_exceeds_listing'
/** Prompt is longer than the listing's context window. */
export const ERR_CONTEXT_TOO_LONG = 'context_exceeds_listing'
/** We cannot currently see our own listings, so we cannot honestly price. */
export const ERR_RATES_UNAVAILABLE = 'rates_unavailable'

const err = (code, message, extra = {}) => ({ ok: false, code, message, ...extra })

/**
 * Pick the rates for this request's model.
 *
 * Unknown model is a 400, not a 402. A 402 invites the client to pay, and we are
 * never going to serve this — taking payment first and refunding after would be
 * both slower and worse.
 */
export const resolveModel = (body, rateCard) => {
  if (!rateCard.isUsable()) {
    return err(
      ERR_RATES_UNAVAILABLE,
      'Provider cannot read its own listings right now and will not guess a price.'
    )
  }

  const model = body?.model
  if (typeof model !== 'string' || model.length === 0) {
    return err(ERR_UNKNOWN_MODEL, 'Request must name a model.', { available: rateCard.models() })
  }

  const rates = rateCard.get(model)
  if (!rates) {
    return err(
      ERR_UNKNOWN_MODEL,
      `This provider does not list "${model}".`,
      { available: rateCard.models() }
    )
  }

  return { ok: true, rates }
}

/**
 * Enforce the ceilings the listing publicly promised.
 *
 * These are refusals, not clamps. Silently capping max_tokens would mean the
 * buyer pays for a quote they did not ask for and gets a truncated answer — the
 * one failure mode that looks like theft even when it is not.
 */
export const checkLimits = ({ body, quote, rates }) => {
  const requested = Number.isFinite(body?.max_tokens) ? body.max_tokens : null

  if (requested !== null && requested > rates.maxOutputTokens) {
    return err(
      ERR_OUTPUT_TOO_LONG,
      `Listing allows answers up to ${rates.maxOutputTokens} tokens; this asked for ${requested}.`,
      { maxOutputTokens: rates.maxOutputTokens }
    )
  }

  const inputTokens = quote?.inputTokens
  if (Number.isFinite(inputTokens) && Number.isFinite(rates.contextTokens)) {
    const ceiling = requested ?? rates.maxOutputTokens
    if ((inputTokens + ceiling) > rates.contextTokens) {
      return err(
        ERR_CONTEXT_TOO_LONG,
        `Prompt plus answer would need ${inputTokens + ceiling} tokens; listing offers ${rates.contextTokens}.`,
        { contextTokens: rates.contextTokens, inputTokens }
      )
    }
  }

  return { ok: true }
}

/** Shape a guard failure into an HTTP response body. */
export const sendGuardError = (res, failure) => {
  const status = failure.code === ERR_RATES_UNAVAILABLE ? 503 : 400
  return res.status(status).json({
    error: {
      type: failure.code,
      message: failure.message,
      ...(failure.available ? { available_models: failure.available } : {}),
      ...(failure.maxOutputTokens ? { max_output_tokens: failure.maxOutputTokens } : {}),
      ...(failure.contextTokens ? { context_tokens: failure.contextTokens } : {})
    }
  })
}
