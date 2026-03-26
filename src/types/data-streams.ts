/**
 * Data stream types re-exported from @moqtap/codec/draft14.
 * Data streams (subgroup, fetch, datagram) are draft-14 concepts.
 */

export type {
  SubgroupStream,
  SubgroupStreamHeader,
  FetchStream,
  FetchStreamHeader,
  DatagramObject,
  DataStreamEvent,
  DataStreamHeader,
  Draft14DataStream,
  ObjectPayload,
} from '@moqtap/codec/draft14';

// ─── Display-only constants for DevTools UI ─────────────────────────

/** Unidirectional stream type IDs (draft-14 §10, Table 4) */
export enum StreamType {
  FETCH_HEADER = 0x05,
}

/** SUBGROUP_HEADER types (draft-14 §10.4.2, Table 7) */
export enum SubgroupHeaderType {
  T_0x10 = 0x10,
  T_0x11 = 0x11,
  T_0x12 = 0x12,
  T_0x13 = 0x13,
  T_0x14 = 0x14,
  T_0x15 = 0x15,
  T_0x18 = 0x18,
  T_0x19 = 0x19,
  T_0x1A = 0x1a,
  T_0x1B = 0x1b,
  T_0x1C = 0x1c,
  T_0x1D = 0x1d,
}

/** OBJECT_DATAGRAM types (draft-14 §10.3.1, Table 6) */
export enum DatagramType {
  T_0x00 = 0x00,
  T_0x01 = 0x01,
  T_0x02 = 0x02,
  T_0x03 = 0x03,
  T_0x04 = 0x04,
  T_0x05 = 0x05,
  T_0x06 = 0x06,
  T_0x07 = 0x07,
  T_0x20 = 0x20,
  T_0x21 = 0x21,
}

/** Data Stream Reset Error Codes (draft-14 §10.4.3, Table 15) */
export enum DataStreamResetCode {
  INTERNAL_ERROR = 0x0,
  CANCELLED = 0x1,
  DELIVERY_TIMEOUT = 0x2,
  SESSION_CLOSED = 0x3,
}
