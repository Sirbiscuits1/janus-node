import { PushDrop, Utils, Transaction } from '@bsv/sdk'
import { ensureProven } from './beef.js'

export const PROTOCOL_TAG = 'janus-compute-v2'
export const COMPUTE_PROTOCOL = [0, 'janus compute']
export const COMPUTE_KEY_ID = '1'

// Field order must match ComputeTopicManager on the overlay exactly.
export const buildListingFields = (listing) => [
  PROTOCOL_TAG,
  'inference',
  listing.model,
  String(listing.contextTokens),
  listing.quantization,
  String(listing.satsPerMInput),
  String(listing.satsPerMOutput),
  String(listing.maxOutputTokens),
  listing.region,
  listing.endpoint,
  listing.attestation,
  String(Date.now())
]

export const publishListing = async (wallet, listing, overlayUrl, topic) => {
  const pushdrop = new PushDrop(wallet)
  const fields = buildListingFields(listing).map((v) => Utils.toArray(v, 'utf8'))

  // forSelf must be true, or the locking key is the counterparty's and the
  // topic manager's signature check fails.
  const lockingScript = await pushdrop.lock(
    fields, COMPUTE_PROTOCOL, COMPUTE_KEY_ID, 'anyone', true
  )

  const { txid, tx } = await wallet.createAction({
    description: `List ${listing.model}`.slice(0, 50),
    outputs: [{
      lockingScript: lockingScript.toHex(),
      satoshis: 1,
      outputDescription: 'Compute listing'
    }],
    options: { randomizeOutputs: false, acceptDelayedBroadcast: false }
  })

  if (!tx) throw new Error('Wallet returned no BEEF')

  const parsed = Transaction.fromBEEF(tx)
  await ensureProven(parsed)
  const beef = parsed.toBEEF()

  const res = await fetch(`${overlayUrl}/submit`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/octet-stream',
      'x-topics': JSON.stringify([topic])
    },
    body: new Uint8Array(beef)
  })

  const body = await res.text()
  if (!res.ok) throw new Error(`Overlay rejected listing: HTTP ${res.status} ${body}`)
  return { txid, beefBytes: beef.length, response: body }
}

// Delisting means spending the listing UTXO. The topic manager sees the input
// consumed, does not retain it, and the lookup service drops it. Repricing is
// the same operation followed by a fresh publish.
export const delistListing = async (wallet, txid, outputIndex, overlayUrl, topic, fetchBeef) => {
  const { Script, OP } = await import('@bsv/sdk')

  const sourceTx = await fetchBeef(txid)
  const sourceOutput = sourceTx.outputs[outputIndex]
  if (!sourceOutput) throw new Error(`No output ${outputIndex} in ${txid}`)

  const unlocker = new PushDrop(wallet).unlock(
    COMPUTE_PROTOCOL, COMPUTE_KEY_ID, 'anyone', 'all', false,
    sourceOutput.satoshis, sourceOutput.lockingScript
  )

  const marker = new Script()
    .writeOpCode(OP.OP_FALSE)
    .writeOpCode(OP.OP_RETURN)
    .writeBin(Utils.toArray('janus-delist', 'utf8'))

  const { signableTransaction } = await wallet.createAction({
    description: 'Delist compute listing',
    inputBEEF: sourceTx.toBEEF(),
    inputs: [{
      outpoint: `${txid}.${outputIndex}`,
      unlockingScriptLength: await unlocker.estimateLength(),
      inputDescription: 'Compute listing being delisted'
    }],
    outputs: [{
      lockingScript: marker.toHex(),
      satoshis: 0,
      outputDescription: 'Delist marker'
    }],
    // Required. signAndProcess defaults to true, and left at the default the
    // wallet signs with empty spends, leaving the PushDrop input unsigned.
    options: { randomizeOutputs: false, acceptDelayedBroadcast: false, signAndProcess: false }
  })

  if (!signableTransaction) throw new Error('Wallet did not return a signable transaction')

  const partial = Transaction.fromBEEF(signableTransaction.tx)
  const unlockingScript = await unlocker.sign(partial, 0)

  const { txid: spendTxid, tx } = await wallet.signAction({
    reference: signableTransaction.reference,
    spends: { 0: { unlockingScript: unlockingScript.toHex() } }
  })

  if (!tx) throw new Error('Wallet returned no BEEF for the spend')

  const parsed = Transaction.fromBEEF(tx)
  await ensureProven(parsed)

  const res = await fetch(`${overlayUrl}/submit`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/octet-stream',
      'x-topics': JSON.stringify([topic])
    },
    body: new Uint8Array(parsed.toBEEF())
  })

  return { spendTxid, status: res.status, response: (await res.text()).slice(0, 200) }
}
