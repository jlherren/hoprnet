import { PROTOCOL_STRING } from '../../constants'
import { Packet } from '../../messages'
import type HoprCoreEthereum from '@hoprnet/hopr-core-ethereum'
import type PeerId from 'peer-id'
import { durations, pubKeyToPeerId, HoprDB } from '@hoprnet/hopr-utils'
import { Mixer } from '../../mixer'
import { sendAcknowledgement } from './acknowledgement'

const FORWARD_TIMEOUT = durations.seconds(6)

export class PacketForwardInteraction {
  private mixer: Mixer

  constructor(
    private subscribe: any,
    private sendMessage: any,
    private privKey: PeerId,
    private chain: HoprCoreEthereum,
    private emitMessage: (msg: Uint8Array) => void,
    private db: HoprDB
  ) {
    this.mixer = new Mixer(this.handleMixedPacket.bind(this))
    this.subscribe(PROTOCOL_STRING, this.handlePacket.bind(this))
  }

  async interact(counterparty: PeerId, packet: Packet): Promise<void> {
    await this.sendMessage(counterparty, PROTOCOL_STRING, packet.serialize(), {
      timeout: FORWARD_TIMEOUT
    })
  }

  async handlePacket(msg: Uint8Array, remotePeer: PeerId) {
    const packet = Packet.deserialize(msg.slice(), this.privKey, remotePeer)

    this.mixer.push(packet)
  }

  async handleMixedPacket(packet: Packet) {
    await packet.checkPacketTag(this.db)

    if (packet.isReceiver) {
      this.emitMessage(packet.plaintext)
      return
    } else {
      await packet.storeUnacknowledgedTicket(this.db)
      await packet.forwardTransform(this.privKey, this.chain)

      await this.interact(pubKeyToPeerId(packet.nextHop), packet)
    }

    sendAcknowledgement(packet, pubKeyToPeerId(packet.previousHop), this.sendMessage, this.privKey)
  }
}
