/**
 * autopublish.js — keep exactly one live listing that points at where we
 * actually are.
 *
 * A listing is a signed public promise that a particular URL will answer. On a
 * home machine that URL changes — the tunnel reconnects, the laptop sleeps, the
 * power blips. Every one of those events, left alone, leaves a listing on the
 * overlay advertising an address that is now dead or, worse, belongs to someone
 * else's tunnel.
 *
 * So the rule is simple and absolute: ONE live listing, and it always names the
 * current address.
 *
 * Order matters. Publish the replacement BEFORE spending the old one, so there
 * is never a moment where this provider has vanished from the market. During the
 * overlap both are live, and the rate card charges the cheaper — which is why
 * that rule exists in ratecard.js.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises'
import path from 'node:path'

/**
 * Where we remember the outpoint of the listing we published. If the process
 * dies between publishing and recording, we would otherwise have no way to
 * retire it and it would sit there advertising a dead tunnel until it was
 * noticed by hand.
 */
const stateFile = (dir) => path.join(dir, 'listing-state.json')

const loadState = async (dir) => {
  try {
    return JSON.parse(await readFile(stateFile(dir), 'utf8'))
  } catch {
    return { current: null, orphans: [] }
  }
}

const saveState = async (dir, state) => {
  await mkdir(dir, { recursive: true })
  await writeFile(stateFile(dir), JSON.stringify(state, null, 2), 'utf8')
}

export class ListingLifecycle {
  /**
   * @param {object}   opts
   * @param {object}   opts.wallet        the provider's wallet
   * @param {Function} opts.publishListing  from lib/listing.js
   * @param {Function} opts.delistListing   from lib/listing.js
   * @param {Function} opts.fetchBeef       from lib/beef.js
   * @param {object}   opts.spec          listing fields minus the endpoint
   * @param {string}   opts.overlayUrl
   * @param {string}   opts.topic
   * @param {string}   opts.stateDir      where to persist outpoints
   */
  constructor ({
    wallet, publishListing, delistListing, fetchBeef,
    spec, overlayUrl, topic, stateDir, onChange = () => {}, logger = console
  }) {
    this.wallet = wallet
    this.publishListing = publishListing
    this.delistListing = delistListing
    this.fetchBeef = fetchBeef
    this.spec = spec
    this.overlayUrl = overlayUrl
    this.topic = topic
    this.stateDir = stateDir
    this.onChange = onChange
    this.logger = logger
    this.state = { current: null, orphans: [] }
    this.busy = Promise.resolve()
  }

  async init () {
    this.state = await loadState(this.stateDir)
    // Anything left from a previous run is an orphan pointing at a dead tunnel.
    if (this.state.current) {
      this.state.orphans.push(this.state.current)
      this.state.current = null
      await saveState(this.stateDir, this.state)
    }
    await this._sweepOrphans()
  }

  /** Serialise everything: two concurrent republishes would race on state. */
  _queue (fn) {
    this.busy = this.busy.then(fn, fn)
    return this.busy
  }

  /** Called on every tunnel address change, including the first. */
  async setEndpoint (publicUrl) {
    return this._queue(async () => {
      const endpoint = `${publicUrl.replace(/\/+$/, '')}/v1/chat/completions`
      if (this.state.current?.endpoint === endpoint) return

      const previous = this.state.current
      const listing = { ...this.spec, endpoint }

      this.logger.log(`[listing] publishing for ${endpoint}`)
      let result
      try {
        result = await this.publishListing(this.wallet, listing, this.overlayUrl, this.topic)
      } catch (err) {
        this.logger.error(`[listing] publish failed: ${err.message}`)
        // Leave the old listing alone. A stale address is bad; no listing at
        // all is worse, and the next address change will try again.
        return
      }

      this.state.current = {
        txid: result.txid,
        outputIndex: result.outputIndex ?? 0,
        endpoint,
        at: new Date().toISOString()
      }
      // Record BEFORE retiring the old one, so a crash here leaves an orphan we
      // can find rather than a listing we have forgotten about.
      if (previous) this.state.orphans.push(previous)
      await saveState(this.stateDir, this.state)

      this.logger.log(`[listing] live: ${result.txid}:${this.state.current.outputIndex}`)
      this.onChange(this.state.current)

      await this._sweepOrphans()
    })
  }

  /** Retire anything that is no longer the current listing. */
  async _sweepOrphans () {
    if (this.state.orphans.length === 0) return
    const remaining = []

    for (const orphan of this.state.orphans) {
      try {
        await this.delistListing(
          this.wallet, orphan.txid, Number(orphan.outputIndex),
          this.overlayUrl, this.topic, this.fetchBeef
        )
        this.logger.log(`[listing] retired ${orphan.txid.slice(0, 12)}…`)
      } catch (err) {
        // Keep it on the list and try again next time. The usual cause is the
        // overlay being briefly unreachable, which fixes itself.
        this.logger.warn(`[listing] could not retire ${orphan.txid.slice(0, 12)}…: ${err.message}`)
        remaining.push(orphan)
      }
    }

    this.state.orphans = remaining
    await saveState(this.stateDir, this.state)
  }

  /**
   * Take the listing down on the way out. Without this, stopping the node leaves
   * it advertised and buyers pay for requests that will never be answered —
   * they get refunded, but it wastes their time and damages the market.
   */
  async shutdown () {
    return this._queue(async () => {
      if (this.state.current) {
        this.state.orphans.push(this.state.current)
        this.state.current = null
        await saveState(this.stateDir, this.state)
      }
      await this._sweepOrphans()
      if (this.state.orphans.length === 0) {
        this.logger.log('[listing] delisted cleanly')
      } else {
        this.logger.warn(
          `[listing] ${this.state.orphans.length} listing(s) still advertised — ` +
          'they will be retired next time this node starts'
        )
      }
    })
  }
}
