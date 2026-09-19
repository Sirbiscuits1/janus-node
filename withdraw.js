#!/usr/bin/env node
/**
 * withdraw.js — move earnings out of this computer's wallet.
 *
 *   npx @janus/node withdraw --to 1YourBsvAddress...
 *   npx @janus/node withdraw --to 1YourBsvAddress... --amount 50000
 *   npx @janus/node withdraw --to 1YourBsvAddress... --all --confirm
 *
 * WHY A SEPARATE WALLET AT ALL
 * ----------------------------
 * A provider has to sign listings and send refunds unattended — at 3am, with
 * nobody there to approve a prompt. A BRC-100 desktop wallet asks permission for
 * every action, which is exactly right for a person and impossible for a daemon.
 * So the node holds its own key.
 *
 * The cost of that is this file. Earnings land in a wallet that is not the one
 * you spend from, and without a way out they just accumulate. This is the way
 * out.
 *
 * KEEP A FLOAT. Refunds are paid from this balance. Sweep it to zero and the
 * next buyer whose answer comes in under their ceiling cannot be refunded —
 * they keep getting charged the full quote, which is the one behaviour that
 * makes a provider look dishonest. --all leaves a reserve for that reason.
 */

import { P2PKH } from '@bsv/sdk'
import { readFile } from 'node:fs/promises'
import { createInterface } from 'node:readline/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

import { createServerWallet } from './lib/wallet.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const CONFIG_PATH = path.join(HERE, 'janus-node.json')

/** Left behind by --all so refunds keep working. */
export const REFUND_RESERVE_SATS = 5_000

const args = process.argv.slice(2)
const flag = (name) => {
  const i = args.indexOf(`--${name}`)
  return i === -1 ? null : (args[i + 1] ?? true)
}
const has = (name) => args.includes(`--${name}`)

const c = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  gold: (s) => `\x1b[33m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`
}
const say = (s = '') => console.log(s)
const die = (msg) => { console.error(`\n  ${c.red('✗')} ${msg}\n`); process.exit(1) }

const main = async () => {
  let config
  try {
    config = JSON.parse(await readFile(CONFIG_PATH, 'utf8'))
  } catch {
    die(`No janus-node.json here. Run setup first.`)
  }

  const to = flag('to')
  if (!to || to === true) {
    die('Where to? Pass --to followed by a BSV address from your own wallet.')
  }

  // Validate before touching the network: a typo here sends money nowhere
  // recoverable, and the error from a bad script is not readable.
  let lockingScript
  try {
    lockingScript = new P2PKH().lock(String(to))
  } catch {
    die(`"${to}" is not a BSV address this can pay. Copy the receive address from your wallet.`)
  }

  say()
  say(`  ${c.bold('Janus Compute')} — withdraw`)
  say(`  ${c.dim('─'.repeat(60))}`)

  const { wallet, identityKey } = await createServerWallet({
    privateKey: config.privateKey,
    network: 'main',
    storageUrl: process.env.WALLET_STORAGE_URL
  })

  const { outputs } = await wallet.listOutputs({ basket: 'default', limit: 1000 })
  const balance = outputs.reduce((sum, o) => sum + o.satoshis, 0)

  say(`  from      ${identityKey.slice(0, 20)}…`)
  say(`  balance   ${balance.toLocaleString()} sat`)
  say(`  to        ${to}`)

  if (balance === 0) {
    say()
    say(`  Nothing to withdraw yet.`)
    say()
    return
  }

  let amount
  if (has('all')) {
    amount = balance - REFUND_RESERVE_SATS
    if (amount <= 0) {
      say()
      say(`  ${c.gold('Balance is at or below the refund reserve.')}`)
      say(`  ${c.dim(`${REFUND_RESERVE_SATS.toLocaleString()} sat stays behind so you can keep refunding buyers.`)}`)
      say(`  ${c.dim('Use --amount to override, but expect refunds to start failing.')}`)
      say()
      return
    }
  } else {
    const raw = flag('amount')
    if (!raw || raw === true) die('How much? Pass --amount <satoshis>, or --all to sweep.')
    amount = Number(raw)
    if (!Number.isFinite(amount) || amount <= 0) die('--amount must be a positive number of satoshis')
    if (amount > balance) die(`Only ${balance.toLocaleString()} sat available`)
  }

  const left = balance - amount
  say(`  amount    ${c.gold(amount.toLocaleString())} sat`)
  say(`  leaving   ${left.toLocaleString()} sat ${left < REFUND_RESERVE_SATS ? c.red('— too little for refunds') : c.dim('for refunds')}`)

  if (!has('confirm')) {
    say()
    say(`  Dry run. Nothing sent. Add ${c.bold('--confirm')} to actually withdraw.`)
    say()
    return
  }

  if (left < REFUND_RESERVE_SATS && !has('yes')) {
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    const a = await rl.question(
      `\n  This leaves too little to refund buyers. Continue anyway? ${c.dim('[y/N]')} `
    )
    rl.close()
    if (!/^y(es)?$/i.test(a.trim())) {
      say(`\n  Cancelled.\n`)
      return
    }
  }

  say()
  say(`  Sending…`)

  try {
    const result = await wallet.createAction({
      description: 'Janus Compute withdrawal',
      outputs: [{
        lockingScript: lockingScript.toHex(),
        satoshis: amount,
        outputDescription: 'Withdrawal'
      }],
      labels: ['withdrawal']
    })

    const txid = result?.txid ?? result?.tx?.id?.('hex') ?? null
    say()
    say(`  ${c.green('✓')} Sent ${amount.toLocaleString()} sat`)
    if (txid) say(`    ${c.dim(txid)}`)
    say()
    say(`  ${c.dim('It will appear in your wallet within a minute or so.')}`)
    say()
  } catch (err) {
    die(`Withdrawal failed: ${err.message}`)
  }
}

main().catch((err) => die(err.stack ?? err.message))
