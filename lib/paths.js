/**
 * Where the node keeps its config and listing state.
 *
 * This has to live in the user's home folder, not next to the code. When the
 * node is run with `npx github:…` the package lands in npm's cache, which is
 * temporary and can be cleared at any time — so a wallet key written beside the
 * code is a wallet key that quietly disappears. The provider would run setup,
 * fund it, come back tomorrow and be told they had never set up, with their
 * money stranded on a key nobody has any more.
 *
 * ~/.janus/ survives npx cache clears, package upgrades and reinstalls, which is
 * the whole point.
 */

import os from 'node:os'
import path from 'node:path'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const PKG_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')

export const JANUS_HOME = process.env.JANUS_HOME ?? path.join(os.homedir(), '.janus')

/** Where anything written from now on goes. */
export const CONFIG_PATH = path.join(JANUS_HOME, 'janus-node.json')
export const STATE_DIR = path.join(JANUS_HOME, 'state')

/**
 * Earlier builds wrote the config beside the code. Anyone who ran those from a
 * git checkout still has it there, and silently ignoring it would look exactly
 * like their setup vanishing. Prefer the home copy; fall back to the old one.
 */
const LEGACY_CONFIG = path.join(PKG_ROOT, 'janus-node.json')

export const resolveConfigPath = () => {
  if (existsSync(CONFIG_PATH)) return CONFIG_PATH
  if (existsSync(LEGACY_CONFIG)) return LEGACY_CONFIG
  return CONFIG_PATH
}
