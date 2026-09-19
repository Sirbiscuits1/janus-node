#!/usr/bin/env node
/**
 * setup.js — turn a computer into a Janus provider without asking it anything
 * it cannot answer for itself.
 *
 *   npm run setup
 *   npm run setup -- --yes      (no questions; for Docker and headless boxes)
 *
 * Design rule: the node decides, the human confirms once. Every question we
 * could answer by looking, we look. The only thing a person genuinely has to do
 * is put a little money in the wallet, and we explain exactly why.
 */

import { PrivateKey } from '@bsv/sdk'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { createInterface } from 'node:readline/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import os from 'node:os'

import { inspectMachine, ollamaOpenAIBase, mapQuantization, DEFAULT_OLLAMA_URL } from './lib/hardware.js'
import { isCloudflaredInstalled, cloudflaredInstallHint } from './lib/tunnel.js'
import { CMD } from './lib/command.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const CONFIG_PATH = path.join(HERE, 'janus-node.json')

const OVERLAY_URL = process.env.OVERLAY_URL ?? 'https://overlay.janusprotocol.xyz'
const LOOKUP_SERVICE = process.env.LOOKUP_SERVICE ?? 'ls_compute_dev'

/** What the wallet needs before it can work. Publishing costs a few satoshis;
 *  refunds come out of this until earnings cover them. */
const STARTER_SATS = 10_000

const args = process.argv.slice(2)
const assumeYes = args.includes('--yes') || args.includes('-y')

const c = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  gold: (s) => `\x1b[33m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`
}

const say = (s = '') => console.log(s)
const die = (msg) => { console.error(`\n  ${c.red('✗')} ${msg}\n`); process.exit(1) }

/** Rough parameter count from a model id: "llama3.1:8b" -> 8, "Qwen3.5-9B" -> 9 */
const paramsOf = (name) => {
  const m = String(name).match(/(\d+(?:\.\d+)?)\s*b\b/i)
  return m ? Number(m[1]) : null
}

const median = (xs) => {
  if (xs.length === 0) return null
  const s = [...xs].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2)
}

/**
 * Suggest a price by looking at what the market already charges for models of a
 * similar size. Prices in satoshis throughout — no currency conversion, so no
 * oracle to be wrong about.
 */
const suggestRates = async (modelName) => {
  const fallback = { satsPerMInput: 150_000, satsPerMOutput: 400_000, basis: 'default' }
  try {
    const res = await fetch(`${OVERLAY_URL.replace(/\/+$/, '')}/lookup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ service: LOOKUP_SERVICE, query: { findAll: true } }),
      signal: AbortSignal.timeout(15_000)
    })
    if (!res.ok) return fallback

    const { PushDrop, Transaction, Utils } = await import('@bsv/sdk')
    const answer = await res.json()
    const listings = []

    for (const out of answer?.outputs ?? []) {
      try {
        const tx = Transaction.fromBEEF(out.beef)
        const script = tx.outputs[out.outputIndex ?? 0]?.lockingScript
        const { fields } = PushDrop.decode(script)
        const f = fields.slice(0, 12).map((b) => Utils.toUTF8(b))
        if (f[0] !== 'janus-compute-v2') continue
        listings.push({ model: f[2], in: Number(f[5]), out: Number(f[6]) })
      } catch { /* a listing we cannot read is not a listing we can learn from */ }
    }

    if (listings.length === 0) return fallback

    const mine = paramsOf(modelName)
    let comparable = listings
    if (mine !== null) {
      // Same size class, roughly. A 9B and an 8B compete; a 9B and a 70B do not.
      const scored = listings
        .map((l) => ({ ...l, p: paramsOf(l.model) }))
        .filter((l) => l.p !== null)
      const near = scored.filter((l) => l.p >= mine * 0.6 && l.p <= mine * 1.6)
      if (near.length > 0) comparable = near
    }

    const satsPerMInput = median(comparable.map((l) => l.in))
    const satsPerMOutput = median(comparable.map((l) => l.out))
    if (!satsPerMInput || !satsPerMOutput) return fallback

    return {
      satsPerMInput,
      satsPerMOutput,
      basis: `${comparable.length} comparable listing${comparable.length === 1 ? '' : 's'}`
    }
  } catch {
    return fallback
  }
}

const ask = async (question, fallbackAnswer) => {
  if (assumeYes) return fallbackAnswer
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    const a = await rl.question(question)
    return a.trim()
  } finally {
    rl.close()
  }
}

const main = async () => {
  say()
  say(`  ${c.bold('Janus Compute')} — set up this computer to earn`)
  say(`  ${c.dim('─'.repeat(60))}`)
  say()

  // ── 1. Look at the machine ────────────────────────────────────────────────
  say(`  Looking at your computer…`)
  const machine = await inspectMachine({ ollamaUrl: process.env.OLLAMA_URL ?? DEFAULT_OLLAMA_URL })

  say()
  say(`    Graphics    ${machine.gpu.label}${machine.gpu.vramGb ? ` · ${machine.gpu.vramGb} GB` : ''}`)
  say(`    Ollama      ${machine.ollama.running ? c.green('running') : c.red('not running')}` +
      (machine.ollama.running ? ` · ${machine.ollama.models.length} model(s) installed` : ''))

  if (!machine.ollama.running) {
    say()
    say(`  ${c.gold('Ollama is what actually runs the AI.')} It is a free one-click install.`)
    say(`    1. Get it from https://ollama.com`)
    say(`    2. Open it, then run:  ${c.bold('ollama pull llama3.1:8b')}`)
    say(`    3. Run this setup again.`)
    say()
    process.exit(1)
  }

  if (!machine.recommended) {
    say()
    if (machine.ollama.models.length === 0) {
      say(`  ${c.gold('Ollama has no models yet.')} Download one and run setup again:`)
      say(`    ${c.bold('ollama pull llama3.1:8b')}   ${c.dim('(about 5 GB)')}`)
    } else {
      say(`  ${c.gold('Nothing you have downloaded fits comfortably on this machine.')}`)
      say(`  Try a smaller one, then run setup again:`)
      say(`    ${c.bold('ollama pull llama3.2:3b')}   ${c.dim('(about 2 GB)')}`)
    }
    say()
    process.exit(1)
  }

  const chosen = machine.recommended
  say(`    Best fit    ${c.bold(chosen.name)}` +
      `${chosen.sizeGb ? ` · ${chosen.sizeGb} GB` : ''}` +
      `${chosen.parameterSize ? ` · ${chosen.parameterSize}` : ''}`)

  // ── 2. Check we can be reached ────────────────────────────────────────────
  const fixedUrl = process.env.PUBLIC_URL ?? null
  const haveTunnel = fixedUrl ? true : await isCloudflaredInstalled()
  say(`    Address     ${fixedUrl
    ? `${fixedUrl} ${c.dim('(yours)')}`
    : haveTunnel ? c.green('ready') + c.dim(' (free Cloudflare tunnel)') : c.red('missing')}`)

  if (!haveTunnel) {
    say()
    say(`  ${c.gold('One more free install.')} Buyers need a public address to reach you:`)
    say(`    ${c.bold(cloudflaredInstallHint())}`)
    say(`  Then run this setup again.`)
    say()
    process.exit(1)
  }

  // ── 3. Price it from the live market ──────────────────────────────────────
  say()
  say(`  Checking what others charge…`)
  const rates = await suggestRates(chosen.name)
  const perAnswer = Math.round(((200 * rates.satsPerMOutput) + (30 * rates.satsPerMInput)) / 1e6 / 5) * 5

  say()
  say(`    Suggested   ${c.gold(`~${perAnswer} sat`)} per typical answer  ${c.dim(`(from ${rates.basis})`)}`)
  say(`                ${c.dim(`${rates.satsPerMInput.toLocaleString()} in / ${rates.satsPerMOutput.toLocaleString()} out per million tokens`)}`)

  // ── 4. The one confirmation ───────────────────────────────────────────────
  say()
  const answer = await ask(
    `  Offer ${c.bold(chosen.name)} at ~${perAnswer} sat per answer? ${c.dim('[Y/n]')} `,
    'y'
  )
  if (answer && !/^y(es)?$/i.test(answer)) {
    say()
    say(`  No problem. Re-run setup when you want to change the model or price.`)
    say(`  ${c.dim('Tip: you can edit janus-node.json directly afterwards.')}`)
    say()
    process.exit(0)
  }

  // ── 5. Identity ───────────────────────────────────────────────────────────
  let config = {}
  try { config = JSON.parse(await readFile(CONFIG_PATH, 'utf8')) } catch { /* first run */ }

  const isNewKey = !config.privateKey
  if (isNewKey) config.privateKey = PrivateKey.fromRandom().toHex()
  const identityKey = PrivateKey.fromHex(config.privateKey).toPublicKey().toString()

  Object.assign(config, {
    model: chosen.name,
    quantization: mapQuantization(chosen.quantization),
    contextTokens: Number(process.env.CONTEXT_TOKENS ?? 32768),
    maxOutputTokens: Number(process.env.MAX_OUTPUT_TOKENS ?? 2048),
    satsPerMInput: rates.satsPerMInput,
    satsPerMOutput: rates.satsPerMOutput,
    region: config.region ?? process.env.REGION ?? 'home',
    attestation: 'none',
    upstreamBaseUrl: ollamaOpenAIBase(process.env.OLLAMA_URL ?? DEFAULT_OLLAMA_URL),
    upstreamApiKey: 'ollama',
    overlayUrl: OVERLAY_URL,
    port: Number(process.env.PORT ?? 8080),
    publicUrl: fixedUrl,
    createdAt: config.createdAt ?? new Date().toISOString()
  })

  await mkdir(path.dirname(CONFIG_PATH), { recursive: true })
  await writeFile(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf8')

  // ── 6. Money in, money out ────────────────────────────────────────────────
  say()
  say(`  ${c.dim('─'.repeat(60))}`)
  say(`  ${c.green('✓')} Saved. ${isNewKey ? 'A new wallet was created for this computer.' : 'Using your existing wallet.'}`)
  say()
  say(`  ${c.bold('Your provider ID')}`)
  say(`    ${identityKey}`)
  say()
  say(`  ${c.bold(`Send about ${STARTER_SATS.toLocaleString()} satoshis to it`)} ${c.dim('(a fraction of a cent)')}`)
  say(`  ${c.dim('This is a float, not a fee. It pays the tiny cost of listing, and it')}`)
  say(`  ${c.dim('lets you refund buyers whatever their answers do not use. Earnings top')}`)
  say(`  ${c.dim('it back up — nobody but you can ever touch it.')}`)
  say()
  if (isNewKey) {
    say(`  ${c.red('Back up this file:')} ${CONFIG_PATH}`)
    say(`  ${c.dim('It holds the private key to your earnings. Lose it and the money is gone.')}`)
    say()
  }
  say(`  ${c.dim('─'.repeat(60))}`)
  say(`  Then start earning with:  ${c.bold(`${CMD} start`)}`)
  say()
}

main().catch((err) => die(err.stack ?? err.message))
