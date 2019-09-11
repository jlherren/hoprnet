'use strict'

const BN = require('bn.js')

const { isPartyA, pubKeyToEthereumAddress, log } = require('../../utils')

const Transaction = require('../../transaction')

module.exports = self => {
    const getCurrentOnchainBalance = (state, isPartyA, newBalance) => {
        const initialBalance = new BN(state.initialBalance)
        const currentBalance = isPartyA ? newBalance.sub(initialBalance) : initialBalance.sub(newBalance)

        return currentBalance.toBuffer('be', Transaction.VALUE_LENGTH)
    }

    /**
     *
     * @param {BN} newBalance current onchain balance of payment channel
     * @param {BN} newIndex current onchain index of payment channel
     * @param {Object} state current offchain state from database
     * @param {boolean} partyA must be true iff this node is PartyA of the payment channel
     */
    const hasBetterTransaction = (newBalance, newIndex, state, partyA) => {
        return (
            newIndex.lt(new BN(state.lastTransaction.index)) &&
            (partyA ? new BN(state.lastTransaction.value).gt(newBalance) : newBalance.gt(new BN(state.lastTransaction.value)))
        )
    }

    /**
     * Derives the required information from the on-chain event
     *
     * @param {Event} event onchain event
     */
    const decodeEventData = event => {
        const result = {
            channelId: Buffer.from(event.topics[1].replace(/0x/, ''), 'hex')
        }

        Object.assign(
            result,
            self.web3.eth.abi.decodeParameters(
                [
                    {
                        type: 'bytes16',
                        name: 'onchainIndex'
                    },
                    {
                        type: 'uint256',
                        name: 'amountA'
                    }
                ],
                event.data
            )
        )

        return result
    }

    return async (err, event) => {
        if (err) {
            console.log(err)
            return
        }

        const { onchainIndex, channelId, amountA } = decodeEventData(event)

        const state = await self.state(channelId)

        const partyA = isPartyA(
            /* prettier-ignore */
            pubKeyToEthereumAddress(self.node.peerInfo.id.pubKey.marshal()),
            pubKeyToEthereumAddress(state.restoreTransaction.counterparty)
        )

        state.currentOnchainBalance = getCurrentOnchainBalance(channelId, partyA, new BN(amountA))
        state.currentIndex = onchainIndex

        if (hasBetterTransaction(new BN(amountA), new BN(onchainIndex, 'hex'), state, partyA)) {
            log(self.node.peerInfo.id, `Found better transaction for payment channel ${channelId.toString('hex')}.`)

            // @TODO database might be outdated when the event comes back

            state.state = self.TransactionRecordState.SETTLING

            self.setState(channelId, state)
            self.submitSettlementTransaction(channelId, state.lastTransaction)
        } else {
            state.state = self.TransactionRecordState.SETTLED

            const [networkState] = await Promise.all([
                self.contract.methods.channels(channelId).call(
                    {
                        from: pubKeyToEthereumAddress(self.node.peerInfo.id.pubKey.marshal())
                    },
                    'latest'
                ),
                self.setState(channelId, state)
            ])

            self.settleTimestamps.set(channelId.toString('hex'), new BN(networkState.settleTimestamp))
            self.emitClosed(channelId)
        }
    }
}
