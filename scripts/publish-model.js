#!/usr/bin/env node
/**
 * publish-model.js — turn a catalogue entry into an on-chain listing.
 *
 *   node scripts/publish-model.js --model meta-llama/Meta-Llama-3.1-8B-Instruct
 *   node scripts/publish-model.js --all
 *   node scripts/publish-model.js --all --confirm
 *
 * DRY RUN BY DEFAULT. Nothing touches the chain or your wallet without --confirm.
 * Publishing spends a real UTXO and the listing is a public signed promise to sell
 * at that price, so the default is to show you the arithmetic and stop.
 *
 * Reads: models.json (upstream cost + specs), the oracle (BSV/USD), your markup.
 * Writes: one POST to ${PROVIDER_URL}/admin/publish per model.
 */

import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const CATALOGUE = path.join(HERE, '..', 'models.json')

const SATS_PER_BSV = 100_000_000

/** Quantization values the topic manager will admit. Anything else is rejected on-chain. */
const VALID_QUANTIZATIONS = ['fp32', 'fp16', 'bf16', 'fp8', 'int8', 'int4', 'unknown']

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

/**
 * BSV/USD. Prefer the same oracle the swap uses so the tab never shows two prices.
 * --bsv-usd overrides it for a manual publish.
 */
const getBsvUsd = async () => {
  const manual = flag('bsv-usd')
  if (manual && manual !== true) {
    const n = Number(manual)
    if (!Number.isFinite(n) || n <= 0) die(`--bsv-usd must be a positive number, got "${manual}"`)
    console.log(`  rate      $${n} / BSV  (manual override)`)
    return n
  }

  const url = process.env.ORACLE_URL
  if (!url) {
    die('Set ORACLE_URL to your swap\'s BSV/USD feed, or pass --bsv-usd 16.04')
  }

  const res = await fetch(url, { headers: { accept: 'application/json' } })
  if (!res.ok) die(`Oracle returned HTTP ${res.status}. Pass --bsv-usd to publish anyway.`)

  const json = await res.json()
  // ORACLE_PRICE_PATH lets you point at the field without editing this script,
  // e.g. ORACLE_PRICE_PATH=data.rate for {"data":{"rate":16.04}}
  const pathExpr = process.env.ORACLE_PRICE_PATH ?? 'price'
  const value = pathExpr.split('.').reduce((acc, key) => (acc == null ? acc : acc[key]), json)

  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) {
    die(`Oracle response had no usable number at "${pathExpr}". Response was: ${JSON.stringify(json).slice(0, 200)}`)
  }
  console.log(`  rate      $${n} / BSV  (${url})`)
  return n
}

const usdPerMToSats = (usdPerM, bsvUsd) => Math.round((usdPerM / bsvUsd) * SATS_PER_BSV)

const fmtUsd = (n) => `$${n.toFixed(n < 0.01 ? 4 : 2)}`
const fmtInt = (n) => n.toLocaleString('en-US')

const buildListing = (entry, defaults, bsvUsd, markupPct) => {
  const quantization = entry.quantization ?? 'unknown'
  if (!VALID_QUANTIZATIONS.includes(quantization)) {
    die(`"${entry.model}" has quantization "${quantization}", which the topic manager will reject. Use one of: ${VALID_QUANTIZATIONS.join(', ')}`)
  }

  const mult = 1 + (markupPct / 100)
  const listedIn = entry.upstreamUsdPerMInput * mult
  const listedOut = entry.upstreamUsdPerMOutput * mult

  return {
    model: entry.model,
    contextTokens: entry.contextTokens,
    quantization,
    satsPerMInput: usdPerMToSats(listedIn, bsvUsd),
    satsPerMOutput: usdPerMToSats(listedOut, bsvUsd),
    maxOutputTokens: entry.maxOutputTokens ?? defaults.maxOutputTokens,
    region: entry.region ?? defaults.region,
    attestation: entry.attestation ?? defaults.attestation,
    _preview: {
      upstreamIn: entry.upstreamUsdPerMInput,
      upstreamOut: entry.upstreamUsdPerMOutput,
      listedIn,
      listedOut,
      markupPct
    }
  }
}

const printListing = (listing, label) => {
  const p = listing._preview
  console.log(`\n  ${label}`)
  console.log(`  ${'─'.repeat(64)}`)
  console.log(`  model     ${listing.model}`)
  console.log(`  context   ${fmtInt(listing.contextTokens)} tokens · answers up to ${fmtInt(listing.maxOutputTokens)}`)
  console.log(`  precision ${listing.quantization} · ${listing.region} · attestation ${listing.attestation}`)
  console.log(`  cost      ${fmtUsd(p.upstreamIn)} in · ${fmtUsd(p.upstreamOut)} out  per 1M  (what DeepInfra charges you)`)
  console.log(`  list at   ${fmtUsd(p.listedIn)} in · ${fmtUsd(p.listedOut)} out  per 1M  (+${p.markupPct}%)`)
  console.log(`  on chain  ${fmtInt(listing.satsPerMInput)} sat in · ${fmtInt(listing.satsPerMOutput)} sat out  per 1M`)
}

const publish = async (listing) => {
  const providerUrl = process.env.PROVIDER_URL
  const adminToken = process.env.ADMIN_TOKEN
  if (!providerUrl) die('PROVIDER_URL is not set')
  if (!adminToken) die('ADMIN_TOKEN is not set')

  const { _preview, ...body } = listing

  const res = await fetch(`${providerUrl.replace(/\/+$/, '')}/admin/publish`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-admin-token': adminToken
    },
    body: JSON.stringify(body)
  })

  const text = await res.text()
  if (!res.ok) {
    console.error(`  ✗ ${listing.model} — HTTP ${res.status}: ${text.slice(0, 400)}`)
    return false
  }

  let parsed
  try { parsed = JSON.parse(text) } catch { parsed = { raw: text } }
  console.log(`  ✓ ${listing.model} — ${parsed.txid ?? parsed.outpoint ?? 'published'}`)
  return true
}

const main = async () => {
  const raw = await readFile(CATALOGUE, 'utf8')
  const catalogue = JSON.parse(raw)
  const defaults = catalogue.defaults ?? {}

  const markupPct = flag('markup') && flag('markup') !== true
    ? Number(flag('markup'))
    : (defaults.markupPct ?? 15)
  if (!Number.isFinite(markupPct) || markupPct < 0) die(`--markup must be a non-negative number`)

  const wanted = flag('model')
  let entries
  if (has('all')) {
    entries = catalogue.models
  } else if (wanted && wanted !== true) {
    entries = catalogue.models.filter((m) => m.model === wanted)
    if (entries.length === 0) {
      die(`"${wanted}" is not in models.json. Known: \n    ${catalogue.models.map((m) => m.model).join('\n    ')}`)
    }
  } else {
    die('Pass --model <id> or --all. Add --confirm to actually publish.')
  }

  console.log(`\n  Janus Compute — publish listings`)
  console.log(`  markup    +${markupPct}%`)
  const bsvUsd = await getBsvUsd()

  const listings = entries.map((e) => buildListing(e, defaults, bsvUsd, markupPct))
  listings.forEach((l, i) => printListing(l, `${i + 1}/${listings.length}`))

  const unverified = entries.filter((e) => e.verified !== true)
  if (unverified.length > 0) {
    console.log(`\n  ⚠ ${unverified.length} of these have verified:false in models.json:`)
    unverified.forEach((e) => console.log(`      ${e.model}`))
    console.log(`    Confirm their price on https://deepinfra.com/pricing and send one test`)
    console.log(`    request to check the served model name matches, then set verified:true.`)
  }

  if (!has('confirm')) {
    console.log(`\n  Dry run. Nothing was published. Re-run with --confirm to sign and broadcast.\n`)
    return
  }

  console.log(`\n  Publishing ${listings.length} listing(s)…\n`)
  let ok = 0
  for (const listing of listings) {
    if (await publish(listing)) ok += 1
  }
  console.log(`\n  ${ok}/${listings.length} published.\n`)
}

main().catch((err) => die(err.stack ?? err.message))
