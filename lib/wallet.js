import { KeyDeriver, PrivateKey } from '@bsv/sdk'
import {
  Wallet, WalletSigner, WalletStorageManager, StorageClient, Services
} from '@bsv/wallet-toolbox'

// @bsv/simple's ServerWallet is a convenience wrapper and does not expose the
// raw BRC-100 interface. PushDrop and the 402 primitives need getPublicKey,
// createAction, createSignature and internalizeAction, so build the underlying
// toolbox Wallet directly.
export const createServerWallet = async ({ privateKey, network = 'main', storageUrl }) => {
  const keyDeriver = new KeyDeriver(PrivateKey.fromHex(privateKey))
  const identityKey = keyDeriver.identityKey

  const storageManager = new WalletStorageManager(identityKey)
  const wallet = new Wallet(
    new WalletSigner(network, keyDeriver, storageManager),
    new Services(network)
  )

  const storage = new StorageClient(wallet, storageUrl ?? 'https://storage.babbage.systems')
  await storage.makeAvailable()
  await storageManager.addWalletStorageProvider(storage)

  return { wallet, identityKey }
}
