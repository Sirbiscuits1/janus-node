import { P2PKH, PublicKey, Utils, Random, Transaction } from '@bsv/sdk'
import { BRC29_PROTOCOL_ID } from '@bsv/402-pay'
import { ensureProven } from './beef.js'

// A refund is a BRC-29 payment in the opposite direction: the provider derives
// a one-time address from its own key plus the buyer's, pays it, and hands the
// buyer everything needed to internalize the output. Same mechanism the buyer
// used to pay in the first place, run backwards.
//
// Below this, the miner fee eats the refund and the transaction is waste.
export const DEFAULT_MIN_REFUND_SATS = 50

export const buildRefund = async ({ wallet, buyerIdentityKey, satoshis, reason }) => {
  if (!buyerIdentityKey) throw new Error('No buyer identity key to refund to')
  if (!Number.isInteger(satoshis) || satoshis <= 0) {
    throw new Error(`Invalid refund amount: ${satoshis}`)
  }

  const derivationPrefix = Utils.toBase64(Utils.toArray('refund', 'utf8'))
  const derivationSuffix = Utils.toBase64(Random(8))

  const { publicKey: derivedKey } = await wallet.getPublicKey({
    protocolID: BRC29_PROTOCOL_ID,
    keyID: `${derivationPrefix} ${derivationSuffix}`,
    counterparty: buyerIdentityKey,
    forSelf: false
  })

  const lockingScript = new P2PKH()
    .lock(PublicKey.fromString(derivedKey).toAddress())
    .toHex()

  const { txid, tx } = await wallet.createAction({
    description: (reason ?? `Refund ${satoshis} sat`).slice(0, 50),
    outputs: [{
      lockingScript,
      satoshis,
      outputDescription: 'Inference refund',
      customInstructions: JSON.stringify({
        derivationPrefix,
        derivationSuffix,
        payee: buyerIdentityKey
      })
    }],
    labels: ['refund'],
    options: { randomizeOutputs: false, acceptDelayedBroadcast: false }
  })

  if (!tx) throw new Error('Wallet returned no BEEF for the refund')

  // The buyer's wallet verifies the transaction on internalize, and BRC-100
  // wallets prune ancestry they trust, so repair it before handing it over.
  const parsed = Transaction.fromBEEF(tx)
  await ensureProven(parsed)

  const { publicKey: providerIdentityKey } = await wallet.getPublicKey({ identityKey: true })

  return {
    txid,
    satoshis,
    // Everything the buyer needs for internalizeAction.
    payment: {
      tx: Array.from(parsed.toAtomicBEEF()),
      outputIndex: 0,
      senderIdentityKey: providerIdentityKey,
      derivationPrefix,
      derivationSuffix
    }
  }
}

// Never let a refund failure take down a response the buyer already paid for.
export const tryRefund = async (args) => {
  try {
    const result = await buildRefund(args)
    console.log(`Refunded ${result.satoshis} sat to ${String(args.buyerIdentityKey).slice(0, 16)}... (${result.txid})`)
    return { ok: true, ...result }
  } catch (err) {
    console.error('REFUND FAILED', {
      buyer: args.buyerIdentityKey,
      satoshis: args.satoshis,
      error: err.message
    })
    return { ok: false, satoshis: args.satoshis, error: err.message }
  }
}
