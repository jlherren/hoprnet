import type BN from 'bn.js'
import type HoprEthereum from '..'
import { u8aConcat, u8aToNumber } from '@hoprnet/hopr-utils'
import { Public, ChannelEntry, Snapshot } from '../types'
import { LatestBlockNumber, LatestConfirmedSnapshot } from '../dbKeys'

const SMALLEST_PUBLIC_KEY = new Public(u8aConcat(new Uint8Array([0x02]), new Uint8Array(32).fill(0x00)))
const BIGGEST_PUBLIC_KEY = new Public(u8aConcat(new Uint8Array([0x03]), new Uint8Array(32).fill(0xff)))
const LATEST_BLOCK_KEY = LatestBlockNumber()
const LATEST_CONFIRMED_SNAPSHOT = LatestConfirmedSnapshot()

/**
 * Compares the two snapshots provided.
 * @param snapA
 * @param snapB
 * @returns 0 if they're equal, negative if `a` goes up, positive if `b` goes up
 */
export const snapshotComparator = (
  snapA: { blockNumber: BN; transactionIndex: BN; logIndex: BN },
  snapB: {
    blockNumber: BN
    transactionIndex: BN
    logIndex: BN
  }
): number => {
  if (!snapA.blockNumber.eq(snapB.blockNumber)) {
    return snapA.blockNumber.sub(snapB.blockNumber).toNumber()
  } else if (!snapA.transactionIndex.eq(snapB.transactionIndex)) {
    return snapA.transactionIndex.sub(snapB.transactionIndex).toNumber()
  } else {
    return snapA.logIndex.sub(snapB.logIndex).toNumber()
  }
}

/**
 * Compares blockNumber and onChainBlockNumber and returns `true`
 * if blockNumber is considered confirmed.
 * @returns boolean
 */
export const isConfirmedBlock = (
  blockNumber: number,
  onChainBlockNumber: number,
  maxConfirmations: number
): boolean => {
  return blockNumber + maxConfirmations <= onChainBlockNumber
}

/**
 * Queries the database to find the latest known block number.
 * @param connector
 * @returns promise that resolves to a number
 */
export const getLatestBlockNumber = async (connector: HoprEthereum): Promise<number> => {
  const { db } = connector

  try {
    return u8aToNumber(await db.get(Buffer.from(LATEST_BLOCK_KEY))) as number
  } catch (err) {
    if (err.notFound) {
      return 0
    }

    throw err
  }
}

/**
 * Updates the database with the latest known block number.
 * @param connector
 * @param blockNumber
 */
export const updateLatestBlockNumber = async (connector: HoprEthereum, blockNumber: BN): Promise<void> => {
  const { db } = connector

  await db.put(Buffer.from(LATEST_BLOCK_KEY), blockNumber.toBuffer())
}

/**
 * Queries the database to find the latest confirmed snapshot.
 * @param connector
 * @returns promise that resolves to a snapshot
 */
export const getLatestConfirmedSnapshot = async (connector: HoprEthereum): Promise<Snapshot | undefined> => {
  const { db } = connector

  try {
    const result = (await db.get(Buffer.from(LATEST_CONFIRMED_SNAPSHOT))) as Uint8Array
    return new Snapshot({
      bytes: result,
      offset: result.byteOffset
    })
  } catch (err) {
    if (err.notFound) {
      return undefined
    }

    throw err
  }
}

/**
 * Queries the database to find the channel entry
 * @param connector
 * @param partyA
 * @param partyB
 */
export const getChannelEntry = async (
  connector: HoprEthereum,
  partyA: Public,
  partyB: Public
): Promise<ChannelEntry | undefined> => {
  const { db, dbKeys } = connector

  let channel: Uint8Array | undefined
  try {
    channel = (await db.get(Buffer.from(dbKeys.ChannelEntry(partyA, partyB)))) as Uint8Array
  } catch (err) {
    if (err.notFound) {
      return undefined
    }

    throw err
  }

  if (channel == null || channel.length == 0) {
    return undefined
  }

  const channelEntry = new ChannelEntry({
    bytes: channel,
    offset: channel.byteOffset
  })

  return channelEntry
}

/**
 * Get all stored channel entries, if party is provided,
 * it will return the channel entries of the given party.
 * @param connector
 * @param partyA
 * @param filter optional filter
 * @returns promise that resolves to a list of channel entries
 */
export const getChannelEntries = async (
  connector: HoprEthereum,
  party?: Public,
  filter?: (node: Public) => boolean
): Promise<
  {
    partyA: Public
    partyB: Public
    channelEntry: ChannelEntry
  }[]
> => {
  const { dbKeys, db } = connector
  const results: {
    partyA: Public
    partyB: Public
    channelEntry: ChannelEntry
  }[] = []

  return await new Promise((resolve, reject) => {
    db.createReadStream({
      gte: Buffer.from(dbKeys.ChannelEntry(SMALLEST_PUBLIC_KEY, SMALLEST_PUBLIC_KEY)),
      lte: Buffer.from(dbKeys.ChannelEntry(BIGGEST_PUBLIC_KEY, BIGGEST_PUBLIC_KEY))
    })
      .on('error', (err) => reject(err))
      .on('data', ({ key, value }: { key: Buffer; value: Buffer }) => {
        const [partyA, partyB] = dbKeys.ChannelEntryParse(key)

        if (
          (party != null && !(party.eq(partyA) || party.eq(partyB))) ||
          (filter != null && !(filter(partyA) && filter(partyB)))
        ) {
          return
        }

        const channelEntry = new ChannelEntry({
          bytes: value,
          offset: value.byteOffset
        })

        results.push({
          partyA,
          partyB,
          channelEntry
        })
      })
      .on('end', () => resolve(results))
  })
}

/**
 * Adds or updates the channel entry in the database.
 * Adds or updates latest confirmed snapshot.
 * @param connector
 * @param partyA
 * @param partyB
 * @param channelEntry
 */
export const updateChannelEntry = async (
  connector: HoprEthereum,
  partyA: Public,
  partyB: Public,
  channelEntry: ChannelEntry
): Promise<void> => {
  const { dbKeys, db } = connector

  const snapshot = new Snapshot(undefined, {
    blockNumber: channelEntry.blockNumber,
    transactionIndex: channelEntry.transactionIndex,
    logIndex: channelEntry.logIndex
  })

  await db.batch([
    {
      type: 'put',
      key: Buffer.from(dbKeys.ChannelEntry(partyA, partyB)),
      value: Buffer.from(channelEntry)
    },
    {
      type: 'put',
      key: Buffer.from(LATEST_CONFIRMED_SNAPSHOT),
      value: Buffer.from(snapshot)
    }
  ])
}
