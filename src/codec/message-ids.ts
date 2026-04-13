/**
 * Draft-aware MESSAGE_ID_MAP resolver.
 *
 * Each MoQT draft may assign different wire IDs to message types.
 * This module provides a synchronous lookup keyed by draft version.
 */

import { MESSAGE_ID_MAP as MAP_07 } from '@moqtap/codec/draft07'
import { MESSAGE_ID_MAP as MAP_08 } from '@moqtap/codec/draft08'
import { MESSAGE_ID_MAP as MAP_09 } from '@moqtap/codec/draft09'
import { MESSAGE_ID_MAP as MAP_10 } from '@moqtap/codec/draft10'
import { MESSAGE_ID_MAP as MAP_11 } from '@moqtap/codec/draft11'
import { MESSAGE_ID_MAP as MAP_12 } from '@moqtap/codec/draft12'
import { MESSAGE_ID_MAP as MAP_13 } from '@moqtap/codec/draft13'
import { MESSAGE_ID_MAP as MAP_14 } from '@moqtap/codec/draft14'
import { MESSAGE_ID_MAP as MAP_15 } from '@moqtap/codec/draft15'
import { MESSAGE_ID_MAP as MAP_16 } from '@moqtap/codec/draft16'
import { MESSAGE_ID_MAP as MAP_17 } from '@moqtap/codec/draft17'
import type { SupportedDraft } from '../types/common'

type MessageIdMap = ReadonlyMap<string, bigint>

const maps: Record<SupportedDraft, MessageIdMap> = {
  '07': MAP_07,
  '08': MAP_08,
  '09': MAP_09,
  '10': MAP_10,
  '11': MAP_11,
  '12': MAP_12,
  '13': MAP_13,
  '14': MAP_14,
  '15': MAP_15,
  '16': MAP_16,
  '17': MAP_17,
}

/** Get the MESSAGE_ID_MAP for a given draft. */
export function getMessageIdMap(draft: SupportedDraft): MessageIdMap {
  return maps[draft]
}
