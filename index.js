import express from 'express'
import { send402, validatePayment, HEADERS } from '@bsv/402-pay'
import { createServerWallet } from './lib/wallet.js'
import { publishListing, delistListing } from './lib/listing.js'
import { quoteRequest, settleRequest } from './lib/pricing.js'
import { tryRefund, DEFAULT_MIN_REFUND_SATS } from './lib/refund.js'
import { callUpstream, timeoutForTokens } from './lib/upstream.js'
import { fetchBeef } from './lib/beef.js'
import { RateCard } from './lib/ratecard.js'
import { resolveModel, checkLimits, sendGuardError } from './lib/modelguard.js'
import { corsMiddleware } from './lib/cors.js'
import {
  buildUpstreamBody, buildResponseMessage, checkResponseConsistency
} from './lib/passthrough.js'

const PORT = Number(process.env.PORT) || 8080
const OVERLAY_URL = process.env.OVERLAY_URL ?? 'https://overlay.janusprotocol.xyz'
const TOPIC = process.env.COMPUTE_TOPIC ?? 'tm_compute_dev'
const LOOKUP_SERVICE = process.env.LOOKUP_SERVICE ?? 'ls_compute_dev'
const ADMIN_TOKEN = process.env.ADMIN_TOKEN
const PUBLIC_URL = process.env.PUBLIC_URL

const UPSTREAM_BASE_URL = process.env.UPSTREAM_BASE_URL
const UPSTREAM_API_KEY = process.env.UPSTREAM_API_KEY
const MIN_REFUND_SATS = Number(process.env.MIN_REFUND_SATS ?? DEFAULT_MIN_REFUND_SATS)

// Quantization values ComputeTopicManager will admit. Publishing anything else
// is rejected on-chain, so catch it here where the error is readable.
const VALID_QUANTIZATIONS = ['fp32', 'fp16', 'bf16', 'fp8', 'int8', 'int4', 'unknown']

// UPSTREAM_MODEL used to pin every request to one model. It cannot survive more
// than one listing, so the model now comes from the listing the buyer chose.
// Setting it has no effect; it is read only to warn.
const LEGACY_UPSTREAM_MODEL = process.env.UPSTREAM_MODEL

const requireAdmin = (req, res) => {
  if (!ADMIN_TOKEN || req.headers['x-admin-token'] !== ADMIN_TOKEN) {
    res.status(401).json({ ok: false, error: 'Bad admin token' })
    return false
  }
  return true
}

const main = async () => {
  for (const [name, value] of Object.entries({
    PROVIDER_PRIVATE_KEY: process.env.PROVIDER_PRIVATE_KEY,
    PUBLIC_URL,
    UPSTREAM_BASE_URL,
    UPSTREAM_API_KEY
  })) {
    if (!value) throw new Error(`${name} is not set`)
  }
  if (!PUBLIC_URL.startsWith('https://')) {
    throw new Error('PUBLIC_URL must be the https URL of this service')
  }

  console.log('Initialising server wallet...')
  const { wallet, identityKey } = await createServerWallet({
    privateKey: process.env.PROVIDER_PRIVATE_KEY,
    network: 'main',
    storageUrl: process.env.WALLET_STORAGE_URL
  })
  console.log('Provider identity key:', identityKey)

  const ENDPOINT = `${PUBLIC_URL}/v1/chat/completions`

  // Prices come from our own listings on the overlay, not from env. See
  // lib/ratecard.js for why.
  const rateCard = new RateCard({
    overlayUrl: OVERLAY_URL,
    lookupService: LOOKUP_SERVICE,
    identityKey
  })

  try {
    await rateCard.refresh()
  } catch (err) {
    // Do not crash. Render would restart-loop, and a provider that is up but
    // returning an honest 503 is more useful than one that is down.
    console.error(`Rate card could not load at boot: ${err.message}`)
    console.error('Serving 503 on inference until the overlay is reachable.')
  }
  rateCard.start()

  const app = express()

  // Browsers cannot reach this service without it, and the 402 headers are
  // unreadable to JavaScript without the expose list. See lib/cors.js.
  app.use(corsMiddleware())

  app.use(express.json({ limit: '1mb' }))

  app.get('/', (req, res) => {
    res.json({
      service: 'janus-provider',
      status: 'alive',
      identityKey,
      endpoint: ENDPOINT,
      ...rateCard.describe(),
      upstream: { baseUrl: UPSTREAM_BASE_URL, configured: Boolean(UPSTREAM_API_KEY) }
    })
  })

  // OpenAI-shaped so any existing client works, with payment in front.
  //
  // The library's createPaymentMiddleware prices from the path alone, which
  // cannot express per-token pricing. So the 402 is handled directly with the
  // same primitives the middleware uses.
  app.post('/v1/chat/completions', async (req, res) => {
    if (!Array.isArray(req.body?.messages) || req.body.messages.length === 0) {
      return res.status(400).json({ error: { message: 'messages is required' } })
    }

    // Fields we cannot price honestly are refused here, before any payment is
    // taken. Refusing after would mean issuing a refund for something we could
    // have caught for free. `extra` is everything we WILL forward.
    const { extra, refused } = buildUpstreamBody(req.body)
    if (refused.length > 0) {
      return res.status(400).json({
        error: {
          type: 'unsupported_parameter',
          message: `Not supported: ${refused.map((r) => r.field).join(', ')}`,
          details: refused
        }
      })
    }

    // Which model, and therefore which prices? An unlisted model is a 400, not a
    // 402 — we are never going to serve it, so inviting payment would be a lie.
    const resolved = resolveModel(req.body, rateCard)
    if (!resolved.ok) return sendGuardError(res, resolved)
    const rates = resolved.rates

    let quote
    try {
      quote = quoteRequest(req.body, rates)
    } catch (err) {
      return res.status(400).json({ error: { message: `Bad request: ${err.message}` } })
    }

    // Refuse anything past the ceilings this listing publicly promised. Silently
    // clamping would charge for a quote the buyer did not ask for and return a
    // truncated answer.
    const limits = checkLimits({ body: req.body, quote, rates })
    if (!limits.ok) return sendGuardError(res, limits)

    // No payment attached yet: quote and stop.
    if (!req.headers[HEADERS.BEEF]) {
      res.set('x-janus-input-tokens', String(quote.inputTokens))
      res.set('x-janus-max-output-tokens', String(quote.maxOutputTokens))
      res.set('x-janus-model', rates.model)
      return send402(res, identityKey, quote.sats)
    }

    let payment
    try {
      payment = await validatePayment(req, wallet, quote.sats)
    } catch (err) {
      console.error('Payment validation threw:', err.message)
      return send402(res, identityKey, quote.sats)
    }
    if (!payment || payment.accepted !== true) {
      console.log('Payment rejected:', payment?.reason ?? 'no result')
      return send402(res, identityKey, quote.sats)
    }

    console.log(
      `Paid ${quote.sats} sat for ${rates.model} by ${String(payment.senderIdentityKey).slice(0, 16)}...`
    )

    const started = Date.now()
    try {
      const result = await callUpstream({
        baseUrl: UPSTREAM_BASE_URL,
        apiKey: UPSTREAM_API_KEY,
        // The listing's model id, forwarded as-is. Each listing must therefore
        // name an id the upstream accepts.
        model: rates.model,
        messages: req.body.messages,
        maxTokens: quote.maxOutputTokens,
        // tools, tool_choice, temperature, seed, response_format…
        extra,
        timeoutMs: timeoutForTokens(
          quote.maxOutputTokens,
          Number(process.env.TIMEOUT_BASE_MS ?? 20000),
          Number(process.env.TIMEOUT_PER_TOKEN_MS ?? 40)
        )
      })

      // The quote priced the caller's max_tokens ceiling. Settle against what
      // was actually used and return the difference, or the buyer pays many
      // times the value of a short answer.
      const settled = settleRequest(result.usage, rates)
      const owed = settled ? Math.max(0, quote.sats - settled.sats) : 0

      let refund = null
      if (owed >= MIN_REFUND_SATS) {
        refund = await tryRefund({
          wallet,
          buyerIdentityKey: payment.senderIdentityKey,
          satoshis: owed,
          reason: `Refund ${owed} sat unused`
        })
      }

      // The upstream's own message, not one rebuilt from its text. A tool-call
      // reply has content: null and the payload in tool_calls; reconstructing
      // it by hand threw the payload away.
      const message = buildResponseMessage(result.message, result.content)

      // An upstream that claims tool calls must return them. Checked rather
      // than trusted, so a change upstream surfaces in our logs and not in a
      // buyer's agent three weeks later.
      const consistency = checkResponseConsistency(message, result.finishReason)
      if (!consistency.ok) {
        console.warn(`[upstream] ${rates.model}: ${consistency.reason}`)
      }

      res.json({
        model: rates.model,
        choices: [{
          index: 0,
          message,
          finish_reason: result.finishReason
        }],
        usage: result.usage,
        janus: {
          satsQuoted: quote.sats,
          satsSettled: settled?.sats ?? null,
          satsRefunded: refund?.ok ? refund.satoshis : 0,
          netPaid: quote.sats - (refund?.ok ? refund.satoshis : 0),
          refundBelowThreshold: owed > 0 && owed < MIN_REFUND_SATS ? owed : 0,
          refundFailed: refund && !refund.ok ? refund.error : null,
          // Present when satsRefunded > 0. Pass this to the wallet's
          // internalizeAction to take receipt of the change.
          refundPayment: refund?.ok ? refund.payment : null,
          quotedInputTokens: quote.inputTokens,
          // Tool schemas are billed by the upstream as prompt tokens. Quoting
          // messages only meant the provider served them free, and ate the
          // difference whenever a reply used its full output allowance.
          quotedToolTokens: quote.breakdown?.toolTokens ?? 0,
          toolCalls: consistency.toolCalls ?? 0,
          maxOutputTokens: quote.maxOutputTokens,
          actualUsage: result.usage,
          durationMs: Date.now() - started,
          providerKey: identityKey,
          advertisedModel: rates.model,
          // What actually served the request. Upstreams sometimes route to a
          // variant (a -Turbo build, different quantization) that is not what
          // was asked for. Where model identity is the product, a buyer must
          // be able to see the difference.
          servedModel: result.upstreamModel,
          modelMatchesListing: result.upstreamModel === rates.model,
          // Which listing priced this request, so a buyer can check the rate
          // against the chain rather than trusting the response.
          listing: `${rates.txid}:${rates.outputIndex}`,
          simulated: false
        }
      })
    } catch (err) {
      // The payment is already internalized, so a failure here means the buyer
      // paid for nothing. Refund the whole amount.
      console.error('UPSTREAM FAILED AFTER PAYMENT', {
        sender: payment.senderIdentityKey,
        model: rates.model,
        sats: quote.sats,
        error: err.message
      })

      const refund = await tryRefund({
        wallet,
        buyerIdentityKey: payment.senderIdentityKey,
        satoshis: quote.sats,
        reason: 'Refund, inference failed'
      })

      res.status(502).json({
        error: {
          message: 'Upstream inference failed. Payment refunded.',
          model: rates.model,
          satsQuoted: quote.sats,
          satsRefunded: refund?.ok ? refund.satoshis : 0,
          refundPayment: refund?.ok ? refund.payment : null,
          refundFailed: refund?.ok ? null : refund?.error,
          refundContact: identityKey
        }
      })
    }
  })

  /**
   * Publish a listing. The body carries the listing, because with several models
   * there is no single set of env vars that could describe them all.
   *
   * scripts/publish-model.js computes the satoshi rates from models.json, your
   * markup and the oracle, then posts the result here.
   */
  app.post('/admin/publish', async (req, res) => {
    if (!requireAdmin(req, res)) return

    const {
      model,
      contextTokens,
      quantization = 'unknown',
      satsPerMInput,
      satsPerMOutput,
      maxOutputTokens = 4096,
      region = 'us-east',
      attestation = 'none'
    } = req.body ?? {}

    const missing = Object.entries({ model, contextTokens, satsPerMInput, satsPerMOutput })
      .filter(([, v]) => v === undefined || v === null || v === '')
      .map(([k]) => k)
    if (missing.length > 0) {
      return res.status(400).json({ ok: false, error: `Missing: ${missing.join(', ')}` })
    }
    if (!VALID_QUANTIZATIONS.includes(quantization)) {
      return res.status(400).json({
        ok: false,
        error: `quantization must be one of: ${VALID_QUANTIZATIONS.join(', ')}`
      })
    }
    for (const [name, value] of Object.entries({
      contextTokens, satsPerMInput, satsPerMOutput, maxOutputTokens
    })) {
      if (!Number.isFinite(Number(value)) || Number(value) <= 0) {
        return res.status(400).json({ ok: false, error: `${name} must be a positive number` })
      }
    }

    const listing = {
      model: String(model),
      contextTokens: Number(contextTokens),
      quantization,
      satsPerMInput: Number(satsPerMInput),
      satsPerMOutput: Number(satsPerMOutput),
      maxOutputTokens: Number(maxOutputTokens),
      region: String(region),
      attestation: String(attestation),
      endpoint: ENDPOINT
    }

    try {
      console.log('Publishing listing:', listing.model)
      const result = await publishListing(wallet, listing, OVERLAY_URL, TOPIC)
      console.log('Published:', result.txid)

      // Serve it immediately rather than up to a refresh interval later.
      await rateCard.refresh().catch((err) => {
        console.warn(`Published, but rate card refresh failed: ${err.message}`)
      })

      res.json({ ok: true, ...result, listing, serving: rateCard.models() })
    } catch (err) {
      console.error('Publish failed:', err.message)
      res.status(500).json({ ok: false, error: err.message })
    }
  })

  app.post('/admin/delist', async (req, res) => {
    if (!requireAdmin(req, res)) return
    const { txid, outputIndex = 0 } = req.body ?? {}
    if (!txid) return res.status(400).json({ ok: false, error: 'txid required' })
    try {
      const result = await delistListing(wallet, txid, Number(outputIndex), OVERLAY_URL, TOPIC, fetchBeef)

      await rateCard.refresh().catch((err) => {
        console.warn(`Delisted, but rate card refresh failed: ${err.message}`)
      })

      res.json({ ok: true, ...result, serving: rateCard.models() })
    } catch (err) {
      console.error('Delist failed:', err.message)
      res.status(500).json({ ok: false, error: err.message })
    }
  })

  /** Force a re-read of our listings without waiting for the timer. */
  app.post('/admin/refresh', async (req, res) => {
    if (!requireAdmin(req, res)) return
    try {
      await rateCard.refresh()
      res.json({ ok: true, ...rateCard.describe() })
    } catch (err) {
      res.status(502).json({ ok: false, error: err.message })
    }
  })

  app.post('/admin/fund', async (req, res) => {
    if (!requireAdmin(req, res)) return
    const { tx, outputIndex, senderIdentityKey, derivationPrefix, derivationSuffix } = req.body ?? {}
    if (!Array.isArray(tx) || typeof outputIndex !== 'number') {
      return res.status(400).json({ ok: false, error: 'tx (array) and outputIndex required' })
    }
    try {
      await wallet.internalizeAction({
        tx,
        outputs: [{
          outputIndex,
          protocol: 'wallet payment',
          paymentRemittance: { senderIdentityKey, derivationPrefix, derivationSuffix }
        }],
        description: 'Provider funding',
        labels: ['funding']
      })
      const { outputs } = await wallet.listOutputs({ basket: 'default', limit: 1000 })
      const total = outputs.reduce((sum, o) => sum + o.satoshis, 0)
      res.json({ ok: true, satoshis: total })
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message })
    }
  })

  app.get('/admin/balance', async (req, res) => {
    if (!requireAdmin(req, res)) return
    try {
      const { outputs } = await wallet.listOutputs({ basket: 'default', limit: 1000 })
      const total = outputs.reduce((sum, o) => sum + o.satoshis, 0)
      res.json({ ok: true, satoshis: total, utxoCount: outputs.length, identityKey })
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message })
    }
  })

  if (LEGACY_UPSTREAM_MODEL) {
    console.warn(
      `NOTE: UPSTREAM_MODEL is set to "${LEGACY_UPSTREAM_MODEL}" but is no longer used. ` +
      'Each request is forwarded under the model named by its listing, so every listing ' +
      'must use an id the upstream accepts. You can remove the variable.'
    )
  }

  app.listen(PORT, () => {
    const models = rateCard.models()
    console.log(`janus-provider listening on ${PORT}`)
    console.log(`  endpoint: ${ENDPOINT}`)
    console.log(`  overlay:  ${OVERLAY_URL}  (${LOOKUP_SERVICE} / ${TOPIC})`)
    console.log(`  refunds:  unused satoshis returned above ${MIN_REFUND_SATS} sat`)
    if (models.length === 0) {
      console.log('  models:   none — publish a listing, then POST /admin/refresh')
    } else {
      console.log(`  models:   ${models.length} serving`)
      for (const m of models) {
        const r = rateCard.get(m)
        console.log(`            ${m}  ${r.satsPerMInput} in / ${r.satsPerMOutput} out  sat per M`)
      }
    }
  })
}

main().catch((err) => {
  console.error('FATAL startup error:', err)
  process.exit(1)
})
