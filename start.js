#!/usr/bin/env node
/**
 * start.js — run the node: tunnel up, provider up, listing published.
 *
 *   npm start
 *
 * This is the only command a provider ever needs after setup. It opens a public
 * address, starts serving, publishes a listing pointing at that address, and
 * takes the listing down again when you stop it.
 */

import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

import { Tunnel } from './lib/tunnel.js'
import { ListingLifecycle } from './lib/autopublish.js'
import { detectOllama, DEFAULT_OLLAMA_URL } from './lib/hardware.js'
import { findFreePort } from './lib/port.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const CONFIG_PATH = path.join(HERE, 'janus-node.json')
const STATE_DIR = path.join(HERE, '.janus')

const c = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  gold: (s) => `\x1b[33m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`
}
const say = (s = '') => console.log(s)

const main = async () => {
  let config
  try {
    config = JSON.parse(await readFile(CONFIG_PATH, 'utf8'))
  } catch {
    say()
    say(`  ${c.red('Not set up yet.')} Run this first:  ${c.bold('npm run setup')}`)
    say()
    process.exit(1)
  }

  say()
  say(`  ${c.bold('Janus Compute')} — starting`)
  say(`  ${c.dim('─'.repeat(60))}`)

  // Ollama must be up before we advertise anything, or the first buyer pays for
  // a request that cannot be served. They would be refunded, but a provider
  // whose debut is a refund is not a provider anyone comes back to.
  const ollama = await detectOllama(process.env.OLLAMA_URL ?? DEFAULT_OLLAMA_URL)
  if (!ollama.running) {
    say()
    say(`  ${c.red('Ollama is not running.')} Start Ollama, then run this again.`)
    say()
    process.exit(1)
  }
  const hasModel = ollama.models.some((m) => m.name === config.model)
  if (!hasModel) {
    say()
    say(`  ${c.red(`"${config.model}" is no longer installed in Ollama.`)}`)
    say(`  Either run ${c.bold(`ollama pull ${config.model}`)} or ${c.bold('npm run setup')} to pick another.`)
    say()
    process.exit(1)
  }
  say(`  ${c.green('✓')} Ollama ready · ${config.model}`)

  // ── A local port that is actually free ────────────────────────────────────
  // 8080 is heavily contested. Nothing downstream cares which one we get: the
  // listing advertises the tunnel's address, and the tunnel points at whatever
  // we bind here.
  const port = await findFreePort(config.port ?? 8080)
  if (port !== config.port) {
    say(`  ${c.dim(`port ${config.port} was busy, using ${port}`)}`)
  }

  // ── Public address, before anything is advertised ─────────────────────────
  const tunnel = new Tunnel({ port, fixedUrl: config.publicUrl })
  let publicUrl
  try {
    publicUrl = await tunnel.start()
  } catch (err) {
    say()
    say(`  ${c.red('Could not get a public address.')}`)
    say(`  ${err.message}`)
    say()
    process.exit(1)
  }
  say(`  ${c.green('✓')} Reachable at ${publicUrl}`)

  // ── Hand the provider its configuration ───────────────────────────────────
  process.env.PROVIDER_PRIVATE_KEY = config.privateKey
  process.env.PUBLIC_URL = publicUrl
  process.env.UPSTREAM_BASE_URL = config.upstreamBaseUrl
  process.env.UPSTREAM_API_KEY = config.upstreamApiKey || 'ollama'
  process.env.OVERLAY_URL = config.overlayUrl
  process.env.PORT = String(port)
  // Local-only admin surface. Random per boot so the routes are never reachable
  // with a blank or guessable token, and nobody has to think about it.
  process.env.ADMIN_TOKEN = process.env.ADMIN_TOKEN ?? randomUUID()

  // Importing boots the server. Everything above had to be settled first.
  const { createServerWallet } = await import('./lib/wallet.js')
  const { publishListing, delistListing } = await import('./lib/listing.js')
  const { fetchBeef } = await import('./lib/beef.js')
  await import('./index.js')

  // ── Wallet and listing lifecycle ──────────────────────────────────────────
  const { wallet, identityKey } = await createServerWallet({
    privateKey: config.privateKey,
    network: 'main',
    storageUrl: process.env.WALLET_STORAGE_URL
  })

  const balance = await wallet.listOutputs({ basket: 'default', limit: 1000 })
    .then(({ outputs }) => outputs.reduce((sum, o) => sum + o.satoshis, 0))
    .catch(() => null)

  if (balance !== null) {
    say(`  ${balance > 0 ? c.green('✓') : c.gold('!')} Wallet ${balance.toLocaleString()} sat`)
    if (balance < 1000) {
      say()
      say(`  ${c.gold('Almost nothing in the wallet.')} Publishing costs a few satoshis and`)
      say(`  refunds come out of this until you have earned some. Send about 10,000 to:`)
      say(`    ${identityKey}`)
      say()
    }
  }

  const lifecycle = new ListingLifecycle({
    wallet,
    publishListing,
    delistListing,
    fetchBeef,
    overlayUrl: config.overlayUrl,
    topic: process.env.COMPUTE_TOPIC ?? 'tm_compute_dev',
    stateDir: STATE_DIR,
    spec: {
      model: config.model,
      contextTokens: config.contextTokens,
      quantization: config.quantization,
      satsPerMInput: config.satsPerMInput,
      satsPerMOutput: config.satsPerMOutput,
      maxOutputTokens: config.maxOutputTokens,
      region: config.region,
      attestation: config.attestation
    },
    onChange: (listing) => {
      say()
      say(`  ${c.green('●')} ${c.bold('You are live.')}`)
      say(`    ${config.model} · ~${Math.round(((200 * config.satsPerMOutput) + (30 * config.satsPerMInput)) / 1e6 / 5) * 5} sat per answer`)
      say(`    ${c.dim(`listing ${listing.txid.slice(0, 16)}…`)}`)
      say()
      say(`  ${c.dim('Leave this window open. Close it and you stop being listed.')}`)
      say()
    }
  })

  await lifecycle.init()
  await lifecycle.setEndpoint(publicUrl)

  // The free tunnel's address changes when it reconnects. Republish rather than
  // restart, so there is no gap where this provider has vanished.
  tunnel.on('url', ({ url, previous }) => {
    if (!previous) return
    say(`  ${c.gold('!')} Address changed, republishing…`)
    lifecycle.setEndpoint(url).catch((err) => console.error(`[listing] ${err.message}`))
  })

  // ── Leave cleanly ─────────────────────────────────────────────────────────
  let shuttingDown = false
  const shutdown = async (signal) => {
    if (shuttingDown) return
    shuttingDown = true
    say()
    say(`  ${c.dim(`${signal} — taking your listing down…`)}`)
    try {
      await lifecycle.shutdown()
    } catch (err) {
      console.error(`[listing] ${err.message}`)
    }
    await tunnel.stop()
    say(`  ${c.green('✓')} Stopped. Nothing is advertised.`)
    say()
    process.exit(0)
  }

  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))
}

main().catch((err) => {
  console.error(`\n  ✗ ${err.stack ?? err.message}\n`)
  process.exit(1)
})
