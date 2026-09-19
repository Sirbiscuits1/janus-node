/**
 * tunnel.js — give a machine behind a home router a public HTTPS address.
 *
 * THE PROBLEM
 * -----------
 * A listing carries an `endpoint` URL that strangers must be able to reach. A
 * GPU in someone's spare room has no public IP, no DNS and no TLS certificate,
 * and asking a non-technical person to port-forward and obtain a certificate is
 * where every "share your hardware" project loses its users.
 *
 * Cloudflare quick tunnels solve it with no account, no configuration and no
 * money: run cloudflared against a local port and it prints back a working
 * https://<random>.trycloudflare.com address.
 *
 * THE CATCH THAT SHAPES EVERYTHING ELSE
 * -------------------------------------
 * A quick tunnel's address is EPHEMERAL. Restart and it changes. Since the
 * address is baked into the on-chain listing, a changed address silently turns
 * every listing into a dead link pointing at someone else's tunnel eventually.
 *
 * So this emits 'url' every time the address changes, and the listing lifecycle
 * (lib/autopublish.js) republishes on it. Anyone who supplies their own domain
 * skips all of this.
 */

import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { exec } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(exec)

const QUICK_TUNNEL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i

export const isCloudflaredInstalled = async () => {
  try {
    await run('cloudflared --version', { timeout: 6000, windowsHide: true })
    return true
  } catch {
    return false
  }
}

/** Platform-appropriate install advice, in one sentence each. */
export const cloudflaredInstallHint = () => {
  switch (process.platform) {
    case 'darwin':
      return 'brew install cloudflared'
    case 'win32':
      return 'winget install --id Cloudflare.cloudflared'
    default:
      return 'See https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/'
  }
}

export class Tunnel extends EventEmitter {
  /**
   * @param {number} port          local port the provider listens on
   * @param {string|null} fixedUrl a public URL the user already owns; when set,
   *                               no tunnel is started and this is used as-is
   */
  constructor ({ port, fixedUrl = null, logger = console }) {
    super()
    this.port = port
    this.fixedUrl = fixedUrl
    this.logger = logger
    this.url = fixedUrl
    this.proc = null
    this.stopping = false
    this.restarts = 0
  }

  get usingTunnel () {
    return !this.fixedUrl
  }

  async start () {
    if (this.fixedUrl) {
      this.logger.log(`[tunnel] using your own address: ${this.fixedUrl}`)
      return this.fixedUrl
    }

    if (!(await isCloudflaredInstalled())) {
      const err = new Error(
        `cloudflared is not installed. Install it with:\n    ${cloudflaredInstallHint()}\n` +
        'Or set PUBLIC_URL to an https address you already control.'
      )
      err.code = 'NO_CLOUDFLARED'
      throw err
    }

    return this._spawn()
  }

  _spawn () {
    return new Promise((resolve, reject) => {
      const args = ['tunnel', '--url', `http://127.0.0.1:${this.port}`, '--no-autoupdate']
      this.proc = spawn('cloudflared', args, { windowsHide: true })

      let settled = false
      const onLine = (line) => {
        const match = line.match(QUICK_TUNNEL_RE)
        if (!match) return
        const url = match[0]
        if (url === this.url) return

        const previous = this.url
        this.url = url
        this.logger.log(`[tunnel] public address: ${url}`)
        // Listeners republish on this. It fires on first start too, which is
        // what makes the first publish automatic.
        this.emit('url', { url, previous })
        if (!settled) { settled = true; resolve(url) }
      }

      // cloudflared writes the banner to stderr, not stdout.
      const attach = (stream) => {
        let buf = ''
        stream.on('data', (chunk) => {
          buf += chunk.toString()
          const lines = buf.split('\n')
          buf = lines.pop() ?? ''
          for (const l of lines) onLine(l)
        })
      }
      attach(this.proc.stderr)
      attach(this.proc.stdout)

      this.proc.on('exit', (code) => {
        if (this.stopping) return
        this.logger.warn(`[tunnel] cloudflared exited (${code}); reconnecting`)
        this.emit('down')
        // Back off, but keep trying: an unattended node on a home connection
        // will lose its tunnel now and then, and it must come back without
        // anyone noticing.
        const delay = Math.min(60_000, 2000 * Math.pow(2, Math.min(this.restarts, 5)))
        this.restarts += 1
        setTimeout(() => {
          if (!this.stopping) this._spawn().catch((e) => this.logger.error(`[tunnel] ${e.message}`))
        }, delay)
      })

      this.proc.on('error', (err) => {
        if (!settled) { settled = true; reject(err) }
      })

      setTimeout(() => {
        if (!settled) {
          settled = true
          reject(new Error('cloudflared did not report an address within 60s'))
        }
      }, 60_000)
    })
  }

  async stop () {
    this.stopping = true
    if (this.proc && !this.proc.killed) {
      this.proc.kill()
    }
  }
}
