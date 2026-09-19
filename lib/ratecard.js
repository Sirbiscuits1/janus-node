/**
 * ratecard.js — the provider's rate table, derived from its own on-chain listings.
 *
 * WHY THIS EXISTS
 * ---------------
 * The obvious way to support several models is an env var holding a JSON blob of
 * prices. That is wrong for two reasons:
 *
 *   1. Adding a model would mean a Render redeploy, so nobody would do it often.
 *   2. The env and the on-chain listing would drift, and when they drift the
 *      listing is a signed public promise while the env is what actually charges.
 *
 * So the listings ARE the rate table. Publish a listing -> the model becomes
 * available. Delist -> it stops being served, on the next refresh.
 *
 * SECURITY: anyone can publish a listing to the topic, including one naming YOUR
 * endpoint at prices of their choosing. A listing is only trusted when its locking
 * key is the key derived from THIS provider's identity key — the same derivation
 * the client uses to verify the server in pay402.js.
 *
 * Signatures are not re-verified here: ComputeTopicManager.decodeAndVerify()
 * already rejected anything unsigned before the overlay admitted it, so every
 * output the lookup returns has been checked. This file is deliberately
 * self-contained (no import out of provider/) so it cannot break if Render only
 * deploys the provider subdirectory.
 */

import { PrivateKey, ProtoWallet, PushDrop, Transaction, Utils } from '@bsv/sdk'

export const PROTOCOL_TAG = 'janus-compute-v2'
export const LISTING_PROTOCOL_ID = [0, 'janus compute']
export const LISTING_KEY_ID = '1'

/** Refresh cadence. Cheap: one POST to your own overlay. */
export const DEFAULT_REFRESH_MS = 60_000

/** If the overlay cannot be reached, keep serving the last good table this long. */
export const DEFAULT_STALE_TOLERANCE_MS = 30 * 60_000

class RateCardError extends Error {
  constructor (message, code) {
    super(message)
    this.name = 'RateCardError'
    this.code = code
  }
}

/**
 * The listing key for an identity key, computed with the well-known 'anyone'
 * private key (1). Public derivation — no secrets. Must stay identical to
 * deriveListingKey() in client/pay402.js or clients will reject the server.
 */
export const deriveListingKey = async (identityKey) => {
  const anyone = new ProtoWallet(new PrivateKey(1))
  const { publicKey } = await anyone.getPublicKey({
    protocolID: LISTING_PROTOCOL_ID,
    keyID: LISTING_KEY_ID,
    counterparty: identityKey,
    forSelf: false
  })
  return publicKey
}

/** Ask the overlay for every current listing on the topic. */
const fetchListings = async ({ overlayUrl, lookupService, signal }) => {
  const res = await fetch(`${overlayUrl.replace(/\/+$/, '')}/lookup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ service: lookupService, query: { findAll: true } }),
    signal
  })

  if (!res.ok) {
    throw new RateCardError(`Overlay lookup failed: HTTP ${res.status}`, 'LOOKUP_HTTP')
  }

  const answer = await res.json()
  const outputs = answer?.outputs
  if (!Array.isArray(outputs)) {
    throw new RateCardError('Overlay lookup returned no outputs array', 'LOOKUP_SHAPE')
  }
  return outputs
}

/**
 * Field order, fixed by ComputeTopicManager:
 *   0 protocol  1 service  2 model  3 contextTokens  4 quantization
 *   5 satsPerMInput  6 satsPerMOutput  7 maxOutputTokens
 *   8 region  9 endpoint  10 attestation  11 issuedAt   (+ signature)
 */
const decodeListing = (output) => {
  try {
    const beef = output.beef ?? output.BEEF
    if (!beef) return null

    const tx = Transaction.fromBEEF(beef)
    const vout = output.outputIndex ?? output.vout ?? 0
    const script = tx.outputs[vout]?.lockingScript
    if (!script) return null

    const { lockingPublicKey: rawKey, fields } = PushDrop.decode(script)
    if (!Array.isArray(fields) || fields.length < 12) return null

    // PushDrop.decode returns a PublicKey OBJECT, while getPublicKey() returns a
    // hex string. Comparing them directly is always false, which silently drops
    // every listing and looks exactly like "the overlay returned nothing".
    const lockingPublicKey = (typeof rawKey === 'string' ? rawKey : String(rawKey)).toLowerCase()

    const f = fields.slice(0, 12).map((bytes) => Utils.toUTF8(bytes))
    if (f[0] !== PROTOCOL_TAG) return null

    const num = (s) => {
      const n = Number(s)
      return Number.isFinite(n) ? n : null
    }

    const listing = {
      lockingPublicKey,
      service: f[1],
      model: f[2],
      contextTokens: num(f[3]),
      quantization: f[4],
      satsPerMInput: num(f[5]),
      satsPerMOutput: num(f[6]),
      maxOutputTokens: num(f[7]),
      region: f[8],
      endpoint: f[9],
      attestation: f[10],
      issuedAt: f[11],
      txid: tx.id('hex'),
      outputIndex: vout
    }

    // A listing with an unparseable price is worse than no listing — it would
    // quote NaN and take money for nothing.
    if (listing.satsPerMInput === null || listing.satsPerMOutput === null) return null
    if (listing.maxOutputTokens === null || listing.contextTokens === null) return null
    if (!listing.model) return null

    return listing
  } catch {
    return null
  }
}

/**
 * Build the model -> rates map from listings that belong to us.
 *
 * Duplicate models: if two of our own listings name the same model (which happens
 * mid-reprice, when the new listing is published before the old one is spent),
 * the CHEAPER output rate wins. Never charge more than something we are currently
 * advertising.
 */
export const buildRateTable = (listings, ourListingKey) => {
  const table = new Map()

  for (const listing of listings) {
    if (!listing) continue
    if (listing.lockingPublicKey !== ourListingKey) continue

    const existing = table.get(listing.model)
    if (existing && existing.satsPerMOutput <= listing.satsPerMOutput) continue

    table.set(listing.model, listing)
  }

  return table
}

export class RateCard {
  constructor ({
    overlayUrl,
    lookupService,
    identityKey,
    refreshMs = DEFAULT_REFRESH_MS,
    staleToleranceMs = DEFAULT_STALE_TOLERANCE_MS,
    logger = console
  }) {
    if (!overlayUrl) throw new RateCardError('overlayUrl is required', 'CONFIG')
    if (!lookupService) throw new RateCardError('lookupService is required', 'CONFIG')
    if (!identityKey) throw new RateCardError('identityKey is required', 'CONFIG')

    this.overlayUrl = overlayUrl
    this.lookupService = lookupService
    this.identityKey = identityKey
    this.refreshMs = refreshMs
    this.staleToleranceMs = staleToleranceMs
    this.logger = logger

    this.listingKey = null
    this.table = new Map()
    this.lastGoodAt = 0
    this.lastError = null
    this.timer = null
  }

  async refresh ({ timeoutMs = 15_000 } = {}) {
    if (!this.listingKey) {
      this.listingKey = (await deriveListingKey(this.identityKey)).toLowerCase()
    }

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), timeoutMs)

    try {
      const outputs = await fetchListings({
        overlayUrl: this.overlayUrl,
        lookupService: this.lookupService,
        signal: controller.signal
      })

      const decoded = outputs.map(decodeListing)
      const mine = decoded.filter((l) => l && l.lockingPublicKey === this.listingKey)
      const table = buildRateTable(decoded, this.listingKey)

      this.logger.log(
        `[ratecard] ${outputs.length} listing(s) on topic, ${mine.length} ours, ` +
        `${table.size} model(s) serving: ${[...table.keys()].join(', ') || '(none)'}`
      )

      if (table.size === 0) {
        this.logger.warn('[ratecard] no listings of ours — every request will 503 until one is published')
        // "Decoded fine, but none matched" and "nothing on the topic" look
        // identical from outside. Print the keys so they never do again.
        const seen = [...new Set(decoded.filter(Boolean).map((l) => l.lockingPublicKey))]
        if (seen.length > 0) {
          this.logger.warn(`[ratecard]   ours:  ${this.listingKey}`)
          for (const k of seen) this.logger.warn(`[ratecard]   found: ${k}`)
        }
        const undecodable = decoded.filter((l) => l === null).length
        if (undecodable > 0) {
          this.logger.warn(`[ratecard]   ${undecodable} output(s) did not decode as a ${PROTOCOL_TAG} listing`)
        }
      }

      this.table = table
      this.lastGoodAt = Date.now()
      this.lastError = null
      return table
    } catch (err) {
      this.lastError = err
      this.logger.error(`[ratecard] refresh failed: ${err.message}`)
      throw err
    } finally {
      clearTimeout(timeout)
    }
  }

  start () {
    if (this.timer) return
    this.timer = setInterval(() => {
      this.refresh().catch(() => { /* logged; keep serving the old table */ })
    }, this.refreshMs)
    if (typeof this.timer.unref === 'function') this.timer.unref()
  }

  stop () {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /** True when the table is fresh enough to price against. */
  isUsable () {
    if (this.lastGoodAt === 0) return false
    return (Date.now() - this.lastGoodAt) <= this.staleToleranceMs
  }

  get (model) {
    if (typeof model !== 'string' || model.length === 0) return null
    return this.table.get(model) ?? null
  }

  models () {
    return [...this.table.keys()].sort()
  }

  describe () {
    return {
      listingKey: this.listingKey,
      models: [...this.table.values()].map((r) => ({
        model: r.model,
        satsPerMInput: r.satsPerMInput,
        satsPerMOutput: r.satsPerMOutput,
        maxOutputTokens: r.maxOutputTokens,
        contextTokens: r.contextTokens,
        quantization: r.quantization,
        region: r.region,
        attestation: r.attestation,
        endpoint: r.endpoint,
        listing: `${r.txid}:${r.outputIndex}`
      })),
      refreshedAt: this.lastGoodAt ? new Date(this.lastGoodAt).toISOString() : null,
      stale: !this.isUsable(),
      lastError: this.lastError ? this.lastError.message : null
    }
  }
}

export { RateCardError }
