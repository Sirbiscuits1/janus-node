#!/usr/bin/env node
/**
 * reprice.js — keep on-chain sat prices in line with a moving BSV/USD rate.
 *
 *   node scripts/reprice.js                    # dry run, shows drift
 *   node scripts/reprice.js --confirm          # republish what has drifted
 *   node scripts/reprice.js --band 5 --confirm # tighter than the default 10%
 *
 * THE PROBLEM THIS SOLVES
 * -----------------------
 * satsPerMInput / satsPerMOutput are fixed in the listing when you publish. BSV/USD
 * is not fixed. If BSV doubles, your listing silently doubles in dollar terms and
 * you stop being competitive. If BSV halves, you are selling under cost and will
 * not notice until you reconcile. With one listing you might catch it by eye. With
 * five you will not.
 *
 * ORDER OF OPERATIONS
 * -------------------
 * Publish the new listing BEFORE spending the old one. For a moment both are live,
 * and buildRateTable() in lib/ratecard.js resolves that by charging the cheaper of
 * the two. The reverse order would leave a window with no listing at all, where the
 * model vanishes from the marketplace mid-reprice.
 */

import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const CATALOGUE = path.join(HERE, '..', 'models.json')

const SATS_PER_BSV = 100_000_000

const args = process.argv.slice(2)
const flag = (name) => {
  const i = args.indexOf(`--${name}`)
  return i === -1 ? null : (args[i + 1] ?? true)
}
const has = (name) => args.includes(`--${name}`)

const die = (msg) => {
  console.error(`\n  ✗ ${msg}\n`)
  process.exit(1)
}

const providerUrl = () => {
  const u = process.env.PROVIDER_URL
  if (!u) die('PROVIDER_URL is not set')
  return u.replace(/\/+$/, '')
}

const adminHeaders = () => {
  const token = process.env.ADMIN_TOKEN
  if (!token) die('ADMIN_TOKEN is not set')
  return { 'content-type': 'application/json', 'x-admin-token': token }
}

const getBsvUsd = async () => {
  const manual = flag('bsv-usd')
  if (manual && manual !== true) {
    const n = Number(manual)
    if (!Number.isFinite(n) || n <= 0) die(`--bsv-usd must be a positive number`)
    return n
  }
  const url = process.env.ORACLE_URL
  if (!url) die('Set ORACLE_URL, or pass --bsv-usd 16.04')

  const res = await fetch(url, { headers: { accept: 'application/json' } })
  if (!res.ok) die(`Oracle returned HTTP ${res.status}`)
  const json = await res.json()
  const pathExpr = process.env.ORACLE_PRICE_PATH ?? 'price'
  const value = pathExpr.split('.').reduce((acc, key) => (acc == null ? acc : acc[key]), json)
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) die(`Oracle gave no usable number at "${pathExpr}"`)
  return n
}

/** What the provider says it is currently listing. */
const getLiveListings = async () => {
  const res = await fetch(`${providerUrl()}/`, { headers: { accept: 'application/json' } })
  if (!res.ok) die(`Provider root returned HTTP ${res.status}`)
  const json = await res.json()
  if (!Array.isArray(json.models)) {
    die('Provider root has no models array — is the multi-model patch deployed?')
  }
  if (json.stale) {
    die('Provider reports a stale rate card (it cannot read its own listings). Fix that before repricing.')
  }
  return json.models
}

const usdPerMToSats = (usdPerM, bsvUsd) => Math.round((usdPerM / bsvUsd) * SATS_PER_BSV)
const fmtInt = (n) => n.toLocaleString('en-US')
const pct = (n) => `${n >= 0 ? '+' : ''}${n.toFixed(1)}%`

const main = async () => {
  const catalogue = JSON.parse(await readFile(CATALOGUE, 'utf8'))
  const defaults = catalogue.defaults ?? {}
  const byModel = new Map(catalogue.models.map((m) => [m.model, m]))

  const markupPct = flag('markup') && flag('markup') !== true
    ? Number(flag('markup'))
    : (defaults.markupPct ?? 15)

  const band = flag('band') && flag('band') !== true ? Number(flag('band')) : 10
  if (!Number.isFinite(band) || band <= 0) die('--band must be a positive number')

  const bsvUsd = await getBsvUsd()
  const live = await getLiveListings()

  console.log(`\n  Janus Compute — reprice check`)
  console.log(`  rate      $${bsvUsd} / BSV`)
  console.log(`  markup    +${markupPct}%   band ±${band}%`)
  console.log(`  ${'─'.repeat(72)}`)

  const drifted = []

  for (const listing of live) {
    const entry = byModel.get(listing.model)
    if (!entry) {
      console.log(`  ?  ${listing.model}`)
      console.log(`     live on chain but not in models.json — skipping (add it or delist it)`)
      continue
    }

    const mult = 1 + (markupPct / 100)
    const targetIn = usdPerMToSats(entry.upstreamUsdPerMInput * mult, bsvUsd)
    const targetOut = usdPerMToSats(entry.upstreamUsdPerMOutput * mult, bsvUsd)

    const driftOut = ((listing.satsPerMOutput - targetOut) / targetOut) * 100
    const driftIn = ((listing.satsPerMInput - targetIn) / targetIn) * 100
    const worst = Math.abs(driftOut) >= Math.abs(driftIn) ? driftOut : driftIn

    const needs = Math.abs(worst) > band
    const mark = needs ? '→' : '·'
    console.log(`  ${mark}  ${listing.model}`)
    console.log(`     out ${fmtInt(listing.satsPerMOutput)} sat → ${fmtInt(targetOut)} sat  (${pct(driftOut)})`)
    console.log(`     in  ${fmtInt(listing.satsPerMInput)} sat → ${fmtInt(targetIn)} sat  (${pct(driftIn)})`)

    if (needs) {
      drifted.push({
        listing,
        entry,
        next: {
          model: entry.model,
          contextTokens: entry.contextTokens,
          quantization: entry.quantization ?? 'unknown',
          satsPerMInput: targetIn,
          satsPerMOutput: targetOut,
          maxOutputTokens: entry.maxOutputTokens ?? defaults.maxOutputTokens,
          region: entry.region ?? defaults.region,
          attestation: entry.attestation ?? defaults.attestation
        }
      })
    }
  }

  if (drifted.length === 0) {
    console.log(`\n  Everything within ±${band}%. Nothing to do.\n`)
    return
  }

  console.log(`\n  ${drifted.length} listing(s) outside the band.`)

  if (!has('confirm')) {
    console.log(`  Dry run — nothing published. Re-run with --confirm.\n`)
    return
  }

  console.log(`  Republishing (new listing first, then spend the old one)…\n`)

  for (const { listing, next } of drifted) {
    // 1. publish the replacement
    const pubRes = await fetch(`${providerUrl()}/admin/publish`, {
      method: 'POST',
      headers: adminHeaders(),
      body: JSON.stringify(next)
    })
    if (!pubRes.ok) {
      console.error(`  ✗ ${next.model} — publish failed HTTP ${pubRes.status}: ${(await pubRes.text()).slice(0, 300)}`)
      console.error(`    Old listing left untouched, so the model is still being served.`)
      continue
    }
    console.log(`  ✓ ${next.model} — new listing published`)

    // 2. only now retire the old one
    const [txid, outputIndex] = String(listing.listing ?? '').split(':')
    if (!txid) {
      console.error(`    ! could not read the old outpoint — delist it by hand, or you will`)
      console.error(`      keep two live listings for this model.`)
      continue
    }

    const delRes = await fetch(`${providerUrl()}/admin/delist`, {
      method: 'POST',
      headers: adminHeaders(),
      body: JSON.stringify({ txid, outputIndex: Number(outputIndex) })
    })
    if (!delRes.ok) {
      console.error(`    ! old listing ${txid}:${outputIndex} did not delist (HTTP ${delRes.status}).`)
      console.error(`      Harmless for buyers — the cheaper of the two is charged — but clean it up.`)
      continue
    }
    console.log(`    old listing ${txid.slice(0, 12)}…:${outputIndex} retired`)
  }

  console.log(``)
}

main().catch((err) => die(err.stack ?? err.message))
