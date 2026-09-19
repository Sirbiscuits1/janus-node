/**
 * The one place the invocation string lives.
 *
 * Right now the node runs straight from GitHub, which works today and needs no
 * npm publish. The day it is published this becomes `npx @janusprotocol/node`
 * (or whatever name turns out to be free) and every screen that tells a
 * provider what to type changes with it — because nothing else hardcodes it.
 *
 * The modal on the website has to print the same string. Keep it in one
 * constant there too.
 */
export const CMD = process.env.JANUS_CMD ?? 'npx github:Sirbiscuits1/janus-node'
