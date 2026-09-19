/**
 * cors.js — let browsers talk to this provider.
 *
 * WHY THIS IS NEEDED
 * ------------------
 * Every test of this provider so far ran in Node, where the same-origin policy
 * does not exist. From a web page it is a different story, and three separate
 * things have to be right or the compute tab cannot buy anything:
 *
 *   1. The origin must be allowed at all, or the request never arrives.
 *
 *   2. The 402 flow sends custom x-bsv-* request headers, which makes it a
 *      "non-simple" request. The browser sends an OPTIONS preflight first and
 *      refuses to send the real request unless that preflight is answered.
 *
 *   3. THE ONE THAT WASTES A DAY: a browser hides response headers from
 *      JavaScript unless they are named in Access-Control-Expose-Headers. The
 *      whole quote lives in x-bsv-sats / x-bsv-server / x-bsv-nonce, so without
 *      this the client gets a 402 it cannot read. That looks like a malformed
 *      402, not a CORS problem, and sends you hunting in entirely the wrong
 *      place.
 *
 * Wide-open origins are correct here, not lazy. This is a public paid endpoint:
 * there are no cookies and no session, and authority comes from a signed payment
 * in the request itself. A browser cannot acquire that by visiting a hostile
 * page. The admin routes are guarded by the admin token, which CORS neither adds
 * to nor subtracts from.
 */

/** Response headers the client must be able to read. */
export const EXPOSED_HEADERS = [
  // The 402 quote, from @bsv/402-pay
  'x-bsv-sats',
  'x-bsv-server',
  'x-bsv-nonce',
  'x-bsv-time',
  'x-bsv-vout',
  'x-bsv-sender',
  // Our own hints, so a client can show the quote breakdown before paying
  'x-janus-input-tokens',
  'x-janus-max-output-tokens',
  'x-janus-model'
]

/** Request headers the client is allowed to send. */
export const ALLOWED_HEADERS = [
  'content-type',
  'accept',
  'authorization',
  'x-admin-token',
  'x-bsv-beef',
  'x-bsv-sender',
  'x-bsv-nonce',
  'x-bsv-time',
  'x-bsv-vout',
  'x-bsv-sats',
  'x-bsv-server'
]

export const corsMiddleware = ({
  exposed = EXPOSED_HEADERS,
  allowed = ALLOWED_HEADERS,
  maxAgeSeconds = 86400
} = {}) => (req, res, next) => {
  res.set('Access-Control-Allow-Origin', '*')
  res.set('Vary', 'Origin')
  res.set('Access-Control-Expose-Headers', exposed.join(', '))

  if (req.method === 'OPTIONS') {
    res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    // Echo what was asked for when present: a client sending a header we did not
    // anticipate then fails visibly on the real request rather than silently at
    // preflight, which is much easier to diagnose.
    res.set('Access-Control-Allow-Headers', req.headers['access-control-request-headers'] || allowed.join(', '))
    res.set('Access-Control-Max-Age', String(maxAgeSeconds))
    return res.sendStatus(204)
  }

  return next()
}
