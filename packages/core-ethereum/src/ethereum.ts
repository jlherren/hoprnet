import type { ContractTransaction } from 'ethers'
import type { Multiaddr } from 'multiaddr'
import type { HoprToken, HoprChannels } from './contracts'
import { providers, utils, errors, Wallet, BigNumber } from 'ethers'
import {
  Address,
  Ticket,
  AcknowledgedTicket,
  Balance,
  NativeBalance,
  Hash,
  PublicKey,
  durations,
  PromiseValue
} from '@hoprnet/hopr-utils'
import BN from 'bn.js'
import NonceTracker from './nonce-tracker'
import TransactionManager from './transaction-manager'
import { getNetworkGasPrice, getNetworkName } from './utils'
import Debug from 'debug'
import { Networks, getContracts } from '@hoprnet/hopr-ethereum'
import { HoprToken__factory, HoprChannels__factory } from './contracts'

const log = Debug('hopr:core-ethereum:chain-operations')
const abiCoder = new utils.AbiCoder()

export type Receipt = string

export async function createChainWrapper(providerURI: string, privateKey: Uint8Array) {
  const provider = providerURI.startsWith('http')
    ? new providers.JsonRpcProvider(providerURI)
    : new providers.WebSocketProvider(providerURI)
  const wallet = new Wallet(privateKey).connect(provider)
  const address = Address.fromString(wallet.address)
  const chainId = await provider.getNetwork().then((res) => res.chainId)
  const network = getNetworkName(chainId) as Networks
  const contracts = getContracts()?.[network]

  if (!contracts?.HoprToken?.address) {
    throw Error(`token contract address from network ${network} not found`)
  } else if (!contracts?.HoprChannels?.address) {
    throw Error(`channels contract address from network ${network} not found`)
  }
  const channels = HoprChannels__factory.connect(contracts.HoprChannels.address, wallet)
  const token = HoprToken__factory.connect(contracts.HoprToken.address, wallet)

  const transactions = new TransactionManager()
  const nonceTracker = new NonceTracker(
    {
      getLatestBlockNumber: async () => provider.getBlockNumber(),
      getTransactionCount: (address, blockNumber) => provider.getTransactionCount(address.toHex(), blockNumber),
      getConfirmedTransactions: (_addr) => Array.from(transactions.confirmed.values()),
      getPendingTransactions: (_addr) => Array.from(transactions.pending.values())
    },
    durations.minutes(15)
  )

  async function sendTransaction<T extends (...args: any) => Promise<ContractTransaction>>(
    method: T,
    ...rest: Parameters<T>
  ): Promise<ContractTransaction> {
    const gasLimit = 300e3
    const gasPrice = getNetworkGasPrice(network)
    const nonceLock = await nonceTracker.getNonceLock(address)
    const nonce = nonceLock.nextNonce
    let transaction: ContractTransaction

    log('Sending transaction %o', {
      gasLimit,
      gasPrice,
      nonce
    })

    try {
      // send transaction to our ethereum provider
      // TODO: better type this, make it less hacky
      transaction = await method(
        ...[
          ...rest,
          {
            gasLimit,
            gasPrice,
            nonce
          }
        ]
      )
    } catch (error) {
      log('Transaction with nonce %d failed to sent: %s', nonce, error)
      nonceLock.releaseLock()
      throw Error('Could not send transaction')
    }

    log('Transaction with nonce %d successfully sent %s, waiting for confimation', nonce, transaction.hash)
    transactions.addToPending(transaction.hash, { nonce })
    nonceLock.releaseLock()

    // monitor transaction, this is done asynchronously
    transaction
      .wait()
      .then(() => {
        log('Transaction with nonce %d and hash %s confirmed', nonce, transaction.hash)
        transactions.moveToConfirmed(transaction.hash)
      })
      .catch((error) => {
        const reverted = ([errors.CALL_EXCEPTION] as string[]).includes(error)

        if (reverted) {
          log('Transaction with nonce %d and hash %s reverted: %s', nonce, transaction.hash, error)

          // this transaction failed but was confirmed as reverted
          transactions.moveToConfirmed(transaction.hash)
        } else {
          log('Transaction with nonce %d failed to sent: %s', nonce, error)

          const alreadyKnown = ([errors.NONCE_EXPIRED, errors.REPLACEMENT_UNDERPRICED] as string[]).includes(error)
          // if this hash is already known and we already have it included in
          // pending we can safely ignore this
          if (alreadyKnown && transactions.pending.has(transaction.hash)) return

          // this transaction was not confirmed so we just remove it
          transactions.remove(transaction.hash)
        }
      })

    return transaction
  }

  async function announce(multiaddr: Multiaddr): Promise<string> {
    const transaction = await sendTransaction(channels.announce, multiaddr.bytes)
    await transaction.wait()
    return transaction.hash
  }

  async function withdraw(currency: 'NATIVE' | 'HOPR', recipient: string, amount: string): Promise<string> {
    if (currency === 'NATIVE') {
      const nonceLock = await nonceTracker.getNonceLock(address)
      try {
        const transaction = await wallet.sendTransaction({
          to: recipient,
          value: BigNumber.from(amount),
          nonce: BigNumber.from(nonceLock.nextNonce)
        })
        nonceLock.releaseLock()
        return transaction.hash
      } catch (err) {
        nonceLock.releaseLock()
        throw err
      }
    } else {
      const transaction = await sendTransaction(token.transfer, recipient, amount)
      return transaction.hash
    }
  }

  async function fundChannel(
    token: HoprToken,
    channels: HoprChannels,
    me: Address,
    counterparty: Address,
    myFund: Balance,
    counterpartyFund: Balance
  ): Promise<Receipt> {
    const totalFund = myFund.toBN().add(counterpartyFund.toBN())
    const transaction = await sendTransaction(
      token.send,
      channels.address,
      totalFund.toString(),
      abiCoder.encode(
        ['address', 'address', 'uint256', 'uint256'],
        [me.toHex(), counterparty.toHex(), myFund.toBN().toString(), counterpartyFund.toBN().toString()]
      )
    )
    await transaction.wait()
    return transaction.hash
  }

  async function openChannel(
    token: HoprToken,
    channels: HoprChannels,
    me: Address,
    counterparty: Address,
    amount: Balance
  ): Promise<Receipt> {
    const transaction = await sendTransaction(
      token.send,
      channels.address,
      amount.toBN().toString(),
      abiCoder.encode(
        ['address', 'address', 'uint256', 'uint256'],
        [me.toHex(), counterparty.toHex(), amount.toBN().toString(), '0']
      )
    )
    await transaction.wait()
    return transaction.hash
  }

  async function finalizeChannelClosure(channels: HoprChannels, counterparty: Address): Promise<Receipt> {
    const transaction = await sendTransaction(channels.finalizeChannelClosure, counterparty.toHex())
    await transaction.wait()
    return transaction.hash
    // TODO: catch race-condition
  }

  async function initiateChannelClosure(channels: HoprChannels, counterparty: Address): Promise<Receipt> {
    const transaction = await sendTransaction(channels.initiateChannelClosure, counterparty.toHex())
    await transaction.wait()
    return transaction.hash
    // TODO: catch race-condition
  }

  async function redeemTicket(
    channels: HoprChannels,
    counterparty: Address,
    ackTicket: AcknowledgedTicket,
    ticket: Ticket
  ): Promise<Receipt> {
    const transaction = await sendTransaction(
      channels.redeemTicket,
      counterparty.toHex(),
      ackTicket.preImage.toHex(),
      ackTicket.ticket.epoch.serialize(),
      ackTicket.ticket.index.serialize(),
      ackTicket.response.toHex(),
      ticket.amount.toBN().toString(),
      ticket.winProb.toBN().toString(),
      ticket.signature.serialize()
    )
    await transaction.wait()
    return transaction.hash
  }

  async function setCommitment(channels: HoprChannels, commitment: Hash): Promise<Receipt> {
    const transaction = await sendTransaction(channels.bumpCommitment, commitment.toHex())
    await transaction.wait()
    return transaction.hash
  }

  const api = {
    // TODO: use indexer when it's done syncing
    getBalance: (address: Address) =>
      token.balanceOf(address.toHex()).then((res) => new Balance(new BN(res.toString()))),
    getNativeBalance: (address) =>
      provider.getBalance(address.toHex()).then((res) => new NativeBalance(new BN(res.toString()))),
    announce,
    withdraw: (currency: 'NATIVE' | 'HOPR', recipient: string, amount: string) => withdraw(currency, recipient, amount),
    fundChannel: (me: Address, counterparty: Address, myTotal: Balance, theirTotal: Balance) =>
      fundChannel(token, channels, me, counterparty, myTotal, theirTotal),
    openChannel: (me, counterparty, amount) => openChannel(token, channels, me, counterparty, amount),
    finalizeChannelClosure: (counterparty) => finalizeChannelClosure(channels, counterparty),
    initiateChannelClosure: (counterparty) => initiateChannelClosure(channels, counterparty),
    redeemTicket: (counterparty, ackTicket, ticket) => redeemTicket(channels, counterparty, ackTicket, ticket),
    setCommitment: (comm: Hash) => setCommitment(channels, comm),
    getGenesisBlock: () => contracts?.HoprChannels?.deployedAt ?? 0,
    getWallet: () => wallet,
    waitUntilReady: async () => await provider.ready,
    getLatestBlockNumber: async () => provider.getBlockNumber(),
    subscribeBlock: (cb) => provider.on('block', cb),
    subscribeError: (cb) => {
      provider.on('error', cb)
      channels.on('error', cb)
    },
    subscribeChannelEvents: (cb) => channels.on('*', cb),
    unsubscribe: () => {
      provider.removeAllListeners()
      channels.removeAllListeners()
    },
    getChannels: () => channels,
    getPrivateKey: () => utils.arrayify(wallet.privateKey),
    getPublicKey: () => PublicKey.fromString(utils.computePublicKey(wallet.publicKey, true)),
    getInfo: () =>
      [
        `Running on: ${getNetworkName(chainId)}`,
        `HOPR Token: ${contracts.HoprToken.address}`,
        `HOPR Channels: ${contracts.HoprChannels.address}`
      ].join('\n')
  }

  return api
}

export type ChainWrapper = PromiseValue<ReturnType<typeof createChainWrapper>>
