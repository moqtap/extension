/**
 * Generic types for MoQT data stream framing — shared across all drafts.
 */

export interface StreamObject {
  /** Byte offset of the object framing (objectId varint) in the stream */
  offset: number
  /** Byte offset where payload begins */
  payloadOffset: number
  /** Payload length in bytes */
  payloadLength: number
  /** Object ID from the framing */
  objectId: number
  /**
   * Object Status, when the object carried one.
   *
   * Only a zero-length object has one, and it is the difference between an
   * object that carried no bytes and an object that marked the end of a group
   * or a track. Dropping it made those indistinguishable in an exported trace.
   */
  status?: number
  /**
   * Group ID, when the object carries its own rather than inheriting the
   * stream's. Fetch objects do; subgroup objects do not.
   */
  groupId?: number
  /** Subgroup ID, on the same terms as `groupId`. */
  subgroupId?: number
  /** Publisher Priority, on the same terms as `groupId`. */
  publisherPriority?: number
}

export interface ParsedStreamFraming {
  /** High-level stream kind */
  streamType: 'subgroup' | 'fetch' | 'datagram' | null
  /** Byte offset where the stream header ends (first object starts) */
  headerEnd: number
  /** Parsed header fields for display — draft-specific keys, generic values */
  headerFields: Record<string, number>
  /** Parsed objects within the stream */
  objects: StreamObject[]
  /** Human-readable tags extracted from the header (for UI badges) */
  tags: HeaderTag[]
}

export interface HeaderTag {
  label: string
  value: string
  /** Optional category for styling */
  kind?: 'track' | 'group' | 'priority' | 'info'
}

export type DraftParser = (data: Uint8Array) => ParsedStreamFraming | null
