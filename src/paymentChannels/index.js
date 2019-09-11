'use strict'

const EventEmitter = require('events')

const Web3 = require('web3')
const BN = require('bn.js')
const secp256k1 = require('secp256k1')
const pull = require('pull-stream')
const lp = require('pull-length-prefixed')
const chalk = require('chalk')

const { pubKeyToEthereumAddress, pubKeyToPeerId, sendTransaction, log, compileIfNecessary, isPartyA } = require('../utils')

const open = require('./rpc/open')
const close = require('./rpc/close')
const withdraw = require('./rpc/withdraw')

const closingListener = require('./eventListeners/close')
const openingListener = require('./eventListeners/open')

const transfer = require('./transfer')
const registerHandlers = require('./handlers')
const Transaction = require('../transaction')

const HASH_LENGTH = 32
const CHANNEL_ID_LENGTH = HASH_LENGTH
const CHALLENGE_LENGTH = 33
const PRIVATE_KEY_LENGTH = 32
const COMPRESSED_PUBLIC_KEY_LENGTH = 33

const PREFIX = Buffer.from('payments-')
const PREFIX_LENGTH = PREFIX.length

const CHANNEL_STATE_UNINITIALIZED = 0
const CHANNEL_STATE_FUNDED = 3
const CHANNEL_STATE_WITHDRAWABLE = 4

const { PROTOCOL_SETTLE_CHANNEL } = require('../constants')

const fs = require('fs')
const path = require('path')
const protons = require('protons')

const { SettlementRequest, SettlementResponse } = protons(fs.readFileSync(path.resolve(__dirname, 'protos/messages.proto')))
const { TransactionRecord, TransactionRecordState } = protons(fs.readFileSync(path.resolve(__dirname, 'protos/transactionRecord.proto')))

// payments
// -> channelId
// ---> challenges -> keyHalf
// -> signatureHash
// ---> channelId

class PaymentChannel extends EventEmitter {
    constructor(options) {
        super()

        this.nonce = options.nonce
        this.contract = options.contract
        this.contractAddress = process.env.CONTRACT_ADDRESS
        this.node = options.node
        this.web3 = options.web3

        this.open = open(this)
        this.closeChannel = close(this)
        this.withdraw = withdraw(this)

        this.closingListener = closingListener(this)
        this.openingListener = openingListener(this)

        this.transfer = transfer(this)

        this.subscriptions = new Map()
        this.closingSubscriptions = new Map()
        this.settleTimestamps = new Map()
    }

    get TransactionRecordState() {
        return TransactionRecordState
    }

    /**
     * Creates and initializes a new PaymentChannel instance.
     * It will check whether there is an up-to-date ABI of the contract
     * and compiles the contract if that isn't the case.
     *
     * @param {Hopr} node a libp2p node instance
     */
    static async create(node) {
        const web3 = new Web3(process.env.PROVIDER)

        const [nonce, compiledContract] = await Promise.all([
            web3.eth.getTransactionCount(pubKeyToEthereumAddress(node.peerInfo.id.pubKey.marshal()), 'latest'),
            compileIfNecessary([`${process.cwd()}/contracts/HoprChannel.sol`], [`${process.cwd()}/build/contracts/HoprChannel.json`])
        ])

        registerHandlers(node)

        const abi = require('../../build/contracts/HoprChannel.json').abi

        const paymentChannel = new PaymentChannel({
            node,
            nonce,
            contract: new web3.eth.Contract(abi, process.env.CONTRACT_ADDRESS, {
                from: pubKeyToEthereumAddress(node.peerInfo.id.pubKey.marshal())
            }),
            web3
        })

        await paymentChannel.registerEventListeners()

        return paymentChannel
    }

    State(channelId) {
        return Buffer.concat([PREFIX, Buffer.from('record-'), channelId], PREFIX_LENGTH + 7 + CHANNEL_ID_LENGTH)
    }

    async setState(channelId, newState) {
        let record = {}
        try {
            record = await this.state(channelId)
        } catch (err) {
            if (!err.notFound) throw err
        }

        Object.assign(record, newState)

        if (record.restoreTransaction) record.restoreTransaction = record.restoreTransaction.toBuffer()

        if (record.lastTransaction) record.lastTransaction = record.lastTransaction.toBuffer()

        console.log(chalk.blue(this.node.peerInfo.id.toB58String()), record)
        return this.node.db.put(this.State(channelId), TransactionRecord.encode(record))
    }

    async state(channelId, encodedRecord) {
        if (!encodedRecord) {
            try {
                encodedRecord = await this.node.db.get(this.State(channelId))
            } catch (err) {
                if (err.notFound) {
                    err = Error(`Couldn't find any record for channel ${chalk.yellow(channelId.toString('hex'))}`)

                    err.notFound = true
                }

                throw err
            }
        }

        const record = TransactionRecord.decode(encodedRecord)

        if (record.restoreTransaction) record.restoreTransaction = Transaction.fromBuffer(record.restoreTransaction)

        if (record.lastTransaction) record.lastTransaction = Transaction.fromBuffer(record.lastTransaction)

        return record
    }

    /**
     * Deletes all information in the database corresponding to the given payment channel id.
     *
     * @param {Buffer} channelId ID of the payment channel
     */
    deleteState(channelId) {
        return new Promise(async (resolve, reject) => {
            console.log(`Deleting record for channel ${chalk.yellow(channelId.toString('hex'))}`)

            let batch = this.node.db.batch().del(this.State(channelId))

            this.node.db
                .createKeyStream({
                    gt: this.Challenge(channelId, Buffer.alloc(COMPRESSED_PUBLIC_KEY_LENGTH, 0x00)),
                    lt: this.Challenge(channelId, Buffer.alloc(COMPRESSED_PUBLIC_KEY_LENGTH, 0xff))
                })
                .on('data', key => {
                    // console.log(key.toString())
                    batch = batch.del(key)
                })
                .on('end', () => resolve(batch.write({ sync: true })))
                .on('err', reject)
        })
    }

    /**
     * Registers listeners on-chain opening events and the closing events of all
     * payment channels found in the database.
     */
    async registerEventListeners() {
        return new Promise((resolve, reject) => {
            const settledChannels = []
            this.node.db
                .createReadStream({
                    gt: this.State(Buffer.alloc(CHANNEL_ID_LENGTH, 0x00)),
                    lt: this.State(Buffer.alloc(CHANNEL_ID_LENGTH, 0xff))
                })
                .on('data', ({ key, value }) => {
                    const record = TransactionRecord.decode(value)
                    const channelId = key.slice(key.length - CHANNEL_ID_LENGTH)

                    switch (record.state) {
                        case this.TransactionRecordState.OPENING:
                            this.registerOpeningListener(channelId)
                            break
                        case this.TransactionRecordState.OPEN:
                            this.registerSettlementListener(channelId)
                            break
                        case this.TransactionRecordState.SETTLING:
                        case this.TransactionRecordState.SETTLED:
                            settledChannels.push({
                                channelId,
                                state: record
                            })
                            break
                        default:
                            console.log(`Found record for channel ${channelId.toString('hex')} entry for with state set to '${record.state}'.`)
                    }
                })
                .on('error', reject)
                .on('end', () => {
                    if (settledChannels.length > 0) return resolve(Promise.all(settledChannels.map(this.handleClosedChannel.bind(this))))

                    resolve()
                })
        })
    }

    handleClosedChannel(settledChannel, autoWithdraw = false) {
        return this.contract.methods
            .channels(settledChannel.channelId)
            .call(
                {
                    from: pubKeyToEthereumAddress(this.node.peerInfo.id.pubKey.marshal())
                },
                'latest'
            )
            .then(channelState => {
                switch (parseInt(channelState.state)) {
                    case CHANNEL_STATE_UNINITIALIZED:
                        return this.deleteState(settledChannel.channelId)
                    case CHANNEL_STATE_WITHDRAWABLE:
                        if (autoWithdraw)
                            return this.withdraw(channelState, localState).then(() =>
                                this.setState(settledChannel.channelId, {
                                    state: this.TransactionRecordState.WITHDRAWABLE
                                })
                            )

                        return this.setState(settledChannel.channelId, {
                            state: this.TransactionRecordState.WITHDRAWABLE
                        })
                    default:
                        throw Error(`Invalid state. Got ${channelState.state}`)
                }
            })
    }
    /**
     * Registers a listener to the on-chain ClosedChannel event of a payment channel.
     *
     * @param {Buffer} channelId ID of the channel
     * @param {Function} listener function that is called whenever the `ClosedChannel` event
     * is fired.
     */
    registerSettlementListener(channelId, listener = this.closingListener) {
        if (!Buffer.isBuffer(channelId) || channelId.length !== CHANNEL_ID_LENGTH)
            throw Error(`Invalid input parameter. Expected a Buffer of size ${HASH_LENGTH} but got ${typeof channelId}.`)

        log(this.node.peerInfo.id, `Listening to close event of channel ${chalk.yellow(channelId.toString('hex'))}`)

        this.closingSubscriptions.set(
            channelId.toString('hex'),
            this.web3.eth.subscribe(
                'logs',
                {
                    topics: [this.web3.utils.sha3(`ClosedChannel(bytes32,bytes16,uint256)`), `0x${channelId.toString('hex')}`]
                },
                listener
            )
        )
    }

    /**
     * Registers a listener to the on-chain OpenedChannel event of a payment channel.
     *
     * @param {Buffer} channelId ID of the channel
     * @param {Function} listener function that is called whenever the `OpenedChannel` event
     * is fired.
     */
    registerOpeningListener(channelId, listener = this.openingListener) {
        if (typeof listener !== 'function')
            throw Error(`Please specify a function that is called when the close event is triggered. Got ${typeof listener} instead.`)

        if (!Buffer.isBuffer(channelId) || channelId.length !== CHANNEL_ID_LENGTH)
            throw Error(`Invalid input parameter. Expected a Buffer of size ${HASH_LENGTH} but got ${typeof channelId}.`)

        log(this.node.peerInfo.id, `Listening to opening event of channel ${chalk.yellow(channelId.toString('hex'))}`)

        this.contract.once(
            'OpenedChannel',
            {
                topics: [this.web3.utils.sha3(`OpenedChannel(bytes32,uint256,uint256)`), `0x${channelId.toString('hex')}`]
            },
            listener
        )
    }

    onceOpened(channelId, fn) {
        this.once(`opened ${channelId.toString('hex')}`, fn)
    }

    emitOpened(channelId) {
        this.emit(`opened ${channelId.toString('hex')}`)
    }

    onceClosed(channelId, fn) {
        this.once(`closed ${channelId.toString('hex')}`, fn)
    }

    emitClosed(channelId, receivedMoney) {
        this.emit(`closed ${channelId.toString('hex')}`, receivedMoney)
    }

    Challenge(channelId, challenge) {
        return Buffer.concat([PREFIX, Buffer.from('challenge-'), channelId, challenge], PREFIX_LENGTH + 10 + CHANNEL_ID_LENGTH + CHALLENGE_LENGTH)
    }

    ChannelId(signatureHash) {
        return Buffer.concat([PREFIX, Buffer.from('channelId-'), signatureHash], PREFIX_LENGTH, PREFIX_LENGTH + 10 + HASH_LENGTH)
    }

    /**
     * Fetches the previous challenges from the database and sum them up.
     *
     * @param {Buffer} channelId ID of the payment channel
     */
    async getPreviousChallenges(channelId) {
        let pubKeys = []

        return new Promise((resolve, reject) =>
            this.node.db
                .createReadStream({
                    gt: this.Challenge(channelId, Buffer.alloc(PRIVATE_KEY_LENGTH, 0x00)),
                    lt: this.Challenge(channelId, Buffer.alloc(PRIVATE_KEY_LENGTH, 0xff))
                })
                .on('data', ({ key, value }) => {
                    const challenge = key.slice(PREFIX_LENGTH + 10 + CHANNEL_ID_LENGTH, PREFIX_LENGTH + 10 + CHANNEL_ID_LENGTH + COMPRESSED_PUBLIC_KEY_LENGTH)
                    const ownKeyHalf = value

                    pubKeys.push(secp256k1.publicKeyCombine(challenge, secp256k1.publicKeyCreate(ownKeyHalf)))
                })
                .on('error', reject)
                .on('end', () => {
                    if (pubKeys.length > 0) return resolve(secp256k1.publicKeyCombine(pubKeys))

                    resolve()
                })
        )
    }

    /**
     * Computes the delta of funds that were received with the given transaction in relation to the
     * initial balance.
     *
     * @param {Transaction} receivedTx the transaction upon which the delta funds is computed
     * @param {PeerId} counterparty peerId of the counterparty that is used to decide which side of
     * payment channel we are, i. e. party A or party B.
     *
     * @param {Buffer} currentValue the currentValue of the payment channel.
     */
    getEmbeddedMoney(receivedTx, counterparty, currentValue) {
        currentValue = new BN(currentValue)
        const newValue = new BN(receivedTx.value)

        const self = pubKeyToEthereumAddress(this.node.peerInfo.id.pubKey.marshal())
        const otherParty = pubKeyToEthereumAddress(counterparty.pubKey.marshal())

        if (isPartyA(self, otherParty)) {
            return newValue.isub(currentValue)
        } else {
            return currentValue.isub(newValue)
        }
    }

    /**
     * Asks the counterparty of the given channelId to provide the latest transaction.
     *
     * @param {Object || Object[]} channels
     * @param {Buffer} channel.channelId
     * @param {Object} channel.state
     *
     * @returns {Promise} a promise that resolves with the latest transaction of the
     * counterparty and rejects if it is invalid and/or outdated.
     */
    getLatestTransactionFromCounterparty(channels) {
        if (!Array.isArray(channels)) channels = [channels]

        const queryNode = ({ channelId, state }) =>
            new Promise(async (resolve, reject) => {
                const counterparty = await pubKeyToPeerId(state.restoreTransaction.counterparty)

                log(this.node.peerInfo.id, `Asking node ${chalk.blue(counterparty.toB58String())} to send latest update transaction.`)

                let conn
                try {
                    conn = await this.node.peerRouting.findPeer(counterparty).then(peerInfo => this.node.dialProtocol(peerInfo, PROTOCOL_SETTLE_CHANNEL))
                } catch (err) {
                    return reject(chalk.red(err.message))
                }

                pull(
                    pull.once(
                        SettlementRequest.encode({
                            channelId
                        })
                    ),
                    lp.encode(),
                    conn,
                    lp.decode(),
                    pull.drain(buf => {
                        let response

                        try {
                            response = SettlementResponse.decode(buf)
                        } catch (err) {
                            reject(
                                Error(
                                    `Counterparty ${chalk.blue(counterparty.toB58String())} didn't send a valid response to close channel ${chalk.yellow(
                                        channelId.toString('hex')
                                    )}.`
                                )
                            )
                        }

                        const tx = Transaction.fromBuffer(response.transaction)

                        if (!tx.verify(counterparty)) return reject(Error(`Invalid transaction on channel ${chalk.yellow(channelId.toString('hex'))}.`))

                        // @TODO add some plausibility checks here

                        resolve({
                            channelId,
                            transaction: tx
                        })

                        // Closes the stream
                        return false
                    })
                )
            })

        return Promise.all(channels.map(queryNode))
    }

    closeChannels() {
        return new Promise((resolve, reject) => {
            const promises = []
            this.node.db
                .createReadStream({
                    gt: this.State(Buffer.alloc(CHANNEL_ID_LENGTH, 0x00)),
                    lt: this.State(Buffer.alloc(CHANNEL_ID_LENGTH, 0xff))
                })
                .on('error', err => reject(err))
                .on('data', ({ key, value }) => {
                    const channelId = key.slice(key.length - CHANNEL_ID_LENGTH)
                    promises.push(
                        this.state(channelId, value)
                            .then(state => this.closeChannel(channelId, state))
                            .catch(_ => new BN(0))
                    )
                })
                .on('end', () => {
                    if (promises.length > 0) {
                        return resolve(Promise.all(promises).then(results => results.reduce((acc, value) => acc.iadd(value))))
                    }

                    return resolve(new BN(0))
                })
        })
    }

    /**
     * Takes a transaction object generetad by web3.js and publishes it in the
     * network. It automatically determines the necessary amount of gas i
     *
     * @param {Object} txObject the txObject generated by web3.js
     * @param {String} value amount of Ether that is sent along with the transaction
     * @param {Function} cb the function to be called afterwards
     */
    async contractCall(txObject, value, cb) {
        if (typeof value === 'function') {
            cb = value
            value = '0'
        }

        if (!value) value = '0'

        const estimatedGas = await txObject.estimateGas({
            from: pubKeyToEthereumAddress(this.node.peerInfo.id.pubKey.marshal())
        })

        this.nonce = this.nonce + 1

        const promise = sendTransaction(
            {
                to: this.contractAddress,
                nonce: this.nonce - 1,
                gas: estimatedGas,
                data: txObject.encodeABI()
            },
            this.node.peerInfo.id,
            this.web3
        )

        if (typeof cb === 'function') {
            promise.then(receipt => cb(null, receipt)).catch(cb)
        } else {
            return promise
        }
    }
}

module.exports = PaymentChannel
