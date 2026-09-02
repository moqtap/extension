/**
 * Draft-aware message table resolver.
 *
 * Each MoQT draft may assign different wire IDs to message types.
 * This module provides a synchronous lookup keyed by draft version, in both
 * directions: name to wire ID for encoding, wire ID to name for display.
 */

import {
  MESSAGE_ID_MAP as ID_MAP_07,
  MESSAGE_TYPE_MAP as TYPE_MAP_07,
} from '@moqtap/codec/draft07'
import {
  MESSAGE_ID_MAP as ID_MAP_08,
  MESSAGE_TYPE_MAP as TYPE_MAP_08,
} from '@moqtap/codec/draft08'
import {
  MESSAGE_ID_MAP as ID_MAP_09,
  MESSAGE_TYPE_MAP as TYPE_MAP_09,
} from '@moqtap/codec/draft09'
import {
  MESSAGE_ID_MAP as ID_MAP_10,
  MESSAGE_TYPE_MAP as TYPE_MAP_10,
} from '@moqtap/codec/draft10'
import {
  MESSAGE_ID_MAP as ID_MAP_11,
  MESSAGE_TYPE_MAP as TYPE_MAP_11,
} from '@moqtap/codec/draft11'
import {
  MESSAGE_ID_MAP as ID_MAP_12,
  MESSAGE_TYPE_MAP as TYPE_MAP_12,
} from '@moqtap/codec/draft12'
import {
  MESSAGE_ID_MAP as ID_MAP_13,
  MESSAGE_TYPE_MAP as TYPE_MAP_13,
} from '@moqtap/codec/draft13'
import {
  MESSAGE_ID_MAP as ID_MAP_14,
  MESSAGE_TYPE_MAP as TYPE_MAP_14,
} from '@moqtap/codec/draft14'
import {
  MESSAGE_ID_MAP as ID_MAP_15,
  MESSAGE_TYPE_MAP as TYPE_MAP_15,
} from '@moqtap/codec/draft15'
import {
  MESSAGE_ID_MAP as ID_MAP_16,
  MESSAGE_TYPE_MAP as TYPE_MAP_16,
} from '@moqtap/codec/draft16'
import {
  MESSAGE_ID_MAP as ID_MAP_17,
  MESSAGE_TYPE_MAP as TYPE_MAP_17,
} from '@moqtap/codec/draft17'
import {
  MESSAGE_ID_MAP as ID_MAP_18,
  MESSAGE_TYPE_MAP as TYPE_MAP_18,
} from '@moqtap/codec/draft18'
import {
  MESSAGE_ID_MAP as ID_MAP_19,
  MESSAGE_TYPE_MAP as TYPE_MAP_19,
} from '@moqtap/codec/draft19'
import type { SupportedDraft } from '../types/common'

type MessageIdMap = ReadonlyMap<string, bigint>
type MessageTypeMap = ReadonlyMap<bigint, string>

const idMaps: Record<SupportedDraft, MessageIdMap> = {
  '07': ID_MAP_07,
  '08': ID_MAP_08,
  '09': ID_MAP_09,
  '10': ID_MAP_10,
  '11': ID_MAP_11,
  '12': ID_MAP_12,
  '13': ID_MAP_13,
  '14': ID_MAP_14,
  '15': ID_MAP_15,
  '16': ID_MAP_16,
  '17': ID_MAP_17,
  '18': ID_MAP_18,
  '19': ID_MAP_19,
}

const typeMaps: Record<SupportedDraft, MessageTypeMap> = {
  '07': TYPE_MAP_07,
  '08': TYPE_MAP_08,
  '09': TYPE_MAP_09,
  '10': TYPE_MAP_10,
  '11': TYPE_MAP_11,
  '12': TYPE_MAP_12,
  '13': TYPE_MAP_13,
  '14': TYPE_MAP_14,
  '15': TYPE_MAP_15,
  '16': TYPE_MAP_16,
  '17': TYPE_MAP_17,
  '18': TYPE_MAP_18,
  '19': TYPE_MAP_19,
}

/** Get the MESSAGE_ID_MAP for a given draft. */
export function getMessageIdMap(draft: SupportedDraft): MessageIdMap {
  return idMaps[draft]
}

/** Get the MESSAGE_TYPE_MAP for a given draft. */
export function getMessageTypeMap(draft: SupportedDraft): MessageTypeMap {
  return typeMaps[draft]
}

/**
 * Whether a draft string is one the tables are keyed by.
 *
 * Both getters index a `Record` by draft, so a draft outside 07-19 hands back
 * `undefined` rather than an empty map — a caller holding a draft from outside
 * the type system, such as one read out of a trace header, has to narrow it
 * here or crash a line later.
 */
export function isSupportedDraft(draft: string): draft is SupportedDraft {
  return Object.hasOwn(typeMaps, draft)
}
