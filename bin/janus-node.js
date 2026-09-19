#!/usr/bin/env node
/**
 * janus-node — the one command a provider ever types.
 *
 *   npx @janus/node            what to do next
 *   npx @janus/node setup      look at this computer, price it, make a wallet
 *   npx @janus/node start      go live
 *   npx @janus/node withdraw   move earnings to your own wallet
 *
 * This exists because `npm run setup` only works inside a checked-out repo. A
 * provider should never see a repo. One binary, three verbs, and a no-argument
 * form that tells them where they are rather than printing usage at them.
 */

import { existsSync } from 'node:fs'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(HERE, '..')
const CONFIG_PATH = path.join(ROOT, 'janus-node.json')

const c = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  gold: (s) => `\x1b[33m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`
}
const say = (s = '') => console.log(s)

const COMMANDS = {
  setup: '../setup.js',
  start: '../start.js',
  withdraw: '../withdraw.js'
}

/**
 * No arguments should not mean "here is a wall of usage". It should mean "here
 * is the next thing to do", which depends entirely on whether they have set up
 * yet — the only state that matters.
 */
const showWhereYouAre = () => {
  const configured = existsSync(CONFIG_PATH)

  say()
  say(`  ${c.bold('Janus Compute')} ${c.dim('· sell your computer\'s spare power')}`)
  say(`  ${c.dim('─'.repeat(58))}`)
  say()

  if (!configured) {
    say(`  You have not set up yet. Start here:`)
    say()
    say(`    ${c.gold('npx @janus/node setup')}`)
    say()
    say(`  ${c.dim('It looks at your computer, picks a model it can run, checks')}`)
    say(`  ${c.dim('what others charge, and makes a wallet. One question.')}`)
    say()
    say(`  ${c.dim('You will need Ollama (ollama.com) and cloudflared first.')}`)
    say()
    return
  }

  let model = null
  try {
    model = JSON.parse(readFileSync(CONFIG_PATH, 'utf8')).model
  } catch { /* unreadable config is handled properly by the commands themselves */ }

  say(`  ${c.green('✓')} Set up${model ? ` · ${model}` : ''}`)
  say()
  say(`  Go live:        ${c.gold('npx @janus/node start')}`)
  say(`  Cash out:       ${c.dim('npx @janus/node withdraw --to <your address>')}`)
  say(`  Change model:   ${c.dim('npx @janus/node setup')}`)
  say()
}

const main = async () => {
  const [, , command, ...rest] = process.argv

  if (!command || command === 'help' || command === '--help' || command === '-h') {
    showWhereYouAre()
    return
  }

  const target = COMMANDS[command]
  if (!target) {
    say()
    say(`  Unknown command: ${command}`)
    say(`  Try one of: ${Object.keys(COMMANDS).join(', ')}`)
    say()
    process.exit(1)
  }

  // The commands read process.argv themselves, so hand them a clean one that
  // looks exactly as it would if they had been invoked directly.
  process.argv = [process.argv[0], path.join(HERE, target), ...rest]
  await import(target)
}

main().catch((err) => {
  console.error(`\n  ✗ ${err.stack ?? err.message}\n`)
  process.exit(1)
})
