import { Transaction } from '@bsv/sdk'

const BB = 'https://bananablocks.com/api/v1'
const MAX_DEPTH = 25

export const fetchBeef = async (txid) => {
  const res = await fetch(`${BB}/tx/${txid}/beef/hex`)
  if (!res.ok) throw new Error(`BEEF fetch failed for ${txid.slice(0, 16)}: HTTP ${res.status}`)
  const hex = (await res.text()).trim()
  if (!hex || hex.length < 20) throw new Error(`Empty BEEF for ${txid.slice(0, 16)}`)
  return Transaction.fromHexBEEF(hex)
}

// BRC-100 wallets prune ancestry they trust, and some report mined
// transactions as unproven, so the BEEF they return can fail overlay
// verification. Walk every branch until it terminates in a merkle
// proof, fetching whatever is missing from a public source.
export const ensureProven = async (tx, depth = 0, seen = new Set()) => {
  if (tx.merklePath) return
  if (depth > MAX_DEPTH) throw new Error(`Ancestry deeper than ${MAX_DEPTH} levels`)

  for (const input of tx.inputs) {
    const txid = input.sourceTXID ?? input.sourceTransaction?.id('hex')
    if (!txid) throw new Error('Input has no source txid')

    if (!input.sourceTransaction) {
      console.log(`${'  '.repeat(depth + 1)}fetching ${txid.slice(0, 16)} (depth ${depth + 1})`)
      input.sourceTransaction = await fetchBeef(txid)
    }

    if (!seen.has(txid)) {
      seen.add(txid)
      await ensureProven(input.sourceTransaction, depth + 1, seen)
    }
  }
}

export const buildCompleteBeef = async (walletTx) => {
  const parsed = Transaction.fromBEEF(walletTx)
  await ensureProven(parsed)
  return parsed.toBEEF()
}

export const submitToOverlay = async (overlay, topic, beef) => {
  const res = await fetch(`${overlay}/submit`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/octet-stream',
      'x-topics': JSON.stringify([topic])
    },
    body: new Uint8Array(beef)
  })
  return { status: res.status, body: await res.text() }
}
