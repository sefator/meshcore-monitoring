declare module "@liamcottle/meshcore.js" {
  export type CompanionContact = {
    publicKey: Uint8Array;
    advName?: string;
    [key: string]: unknown;
  };

  export type CompanionStats = {
    batt_milli_volts: number;
    curr_tx_queue_len: number;
    noise_floor: number;
    last_rssi: number;
    n_packets_recv: number;
    n_packets_sent: number;
    total_air_time_secs: number;
    total_up_time_secs: number;
    n_sent_flood: number;
    n_sent_direct: number;
    n_recv_flood: number;
    n_recv_direct: number;
    err_events: number;
    last_snr: number;
    n_direct_dups: number;
    n_flood_dups: number;
  };

  export type MeshcoreNeighbour = {
    publicKeyPrefix: Uint8Array;
    heardSecondsAgo: number;
    snr: number;
  };

  export type MeshcoreNeighboursResponse = {
    totalNeighboursCount: number;
    neighbours: MeshcoreNeighbour[];
  };

  export type CompanionSelfInfo = {
    publicKey: Uint8Array;
    [key: string]: unknown;
  };

  export type CompanionPrivateKeyExport = {
    privateKey: Uint8Array;
  };

  export interface MeshcoreConnection {
    connect(): Promise<void>;
    sendCommandAppStart(): Promise<void>;
    getContacts(): Promise<CompanionContact[]>;
    getStatus(
      publicKey: Uint8Array,
      timeoutMs?: number,
    ): Promise<CompanionStats>;
    login(
      publicKey: Uint8Array,
      password: string,
      timeoutMs?: number,
    ): Promise<unknown>;
    getNeighbours(
      publicKey: Uint8Array,
      count?: number,
      offset?: number,
      orderBy?: number,
      pubKeyPrefixLength?: number,
    ): Promise<MeshcoreNeighboursResponse>;
    findContactByPublicKeyPrefix(
      prefix: Uint8Array | Buffer,
    ): Promise<CompanionContact | null>;
    getSelfInfo(timeoutMs?: number | null): Promise<CompanionSelfInfo>;
    exportPrivateKey(): Promise<CompanionPrivateKeyExport>;
    sign(data: Uint8Array): Promise<Uint8Array>;
  }

  export class TCPConnection implements MeshcoreConnection {
    constructor(host: string, port: number);
    connect(): Promise<void>;
    sendCommandAppStart(): Promise<void>;
    getContacts(): Promise<CompanionContact[]>;
    getStatus(
      publicKey: Uint8Array,
      timeoutMs?: number,
    ): Promise<CompanionStats>;
    login(
      publicKey: Uint8Array,
      password: string,
      timeoutMs?: number,
    ): Promise<unknown>;
    getNeighbours(
      publicKey: Uint8Array,
      count?: number,
      offset?: number,
      orderBy?: number,
      pubKeyPrefixLength?: number,
    ): Promise<MeshcoreNeighboursResponse>;
    findContactByPublicKeyPrefix(
      prefix: Uint8Array | Buffer,
    ): Promise<CompanionContact | null>;
    getSelfInfo(timeoutMs?: number | null): Promise<CompanionSelfInfo>;
    exportPrivateKey(): Promise<CompanionPrivateKeyExport>;
    sign(data: Uint8Array): Promise<Uint8Array>;
  }

  export class NodeJSSerialConnection implements MeshcoreConnection {
    constructor(path: string);
    connect(): Promise<void>;
    sendCommandAppStart(): Promise<void>;
    getContacts(): Promise<CompanionContact[]>;
    getStatus(
      publicKey: Uint8Array,
      timeoutMs?: number,
    ): Promise<CompanionStats>;
    login(
      publicKey: Uint8Array,
      password: string,
      timeoutMs?: number,
    ): Promise<unknown>;
    getNeighbours(
      publicKey: Uint8Array,
      count?: number,
      offset?: number,
      orderBy?: number,
      pubKeyPrefixLength?: number,
    ): Promise<MeshcoreNeighboursResponse>;
    findContactByPublicKeyPrefix(
      prefix: Uint8Array | Buffer,
    ): Promise<CompanionContact | null>;
    getSelfInfo(timeoutMs?: number | null): Promise<CompanionSelfInfo>;
    exportPrivateKey(): Promise<CompanionPrivateKeyExport>;
    sign(data: Uint8Array): Promise<Uint8Array>;
  }
}
