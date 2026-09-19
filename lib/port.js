/**
 * port.js — find a local port that is actually free.
 *
 * Port 8080 is one of the most contested numbers on a developer's machine, and
 * a fair number of ordinary ones too. Binding it blindly means the node dies on
 * first run with EADDRINUSE, which to a non-technical person reads as "this
 * software is broken" rather than "something else is using a number".
 *
 * Nothing downstream cares which port we land on: the listing advertises the
 * tunnel's public address, and the tunnel is pointed at whatever we picked. The
 * local port is an implementation detail, so there is no reason to let it be a
 * failure.
 */

import net from 'node:net'

/** Is this port bindable right now? */
export const isPortFree = (port, host = '127.0.0.1') => new Promise((resolve) => {
  const server = net.createServer()
  server.once('error', () => resolve(false))
  server.once('listening', () => server.close(() => resolve(true)))
  server.listen(port, host)
})

/**
 * First free port at or after `start`. Steps by one rather than picking at
 * random so a returning provider usually gets the same port back, which keeps
 * anything they bookmarked working.
 */
export const findFreePort = async (start = 8080, attempts = 40) => {
  for (let port = start; port < start + attempts; port += 1) {
    if (await isPortFree(port)) return port
  }
  throw new Error(
    `No free port between ${start} and ${start + attempts - 1}. ` +
    'Something unusual is running; set PORT to one you know is free.'
  )
}
