/**
 * Draft version display constants for the DevTools UI.
 *
 * Version detection and negotiation logic is in src/detect/draft-detect.ts.
 * This module provides only the display-oriented mappings.
 */

import type { SupportedDraft } from '../types/common';

/** Known draft version wire numbers for UI display */
export const DRAFT_VERSION_NUMBERS: Record<string, number> = {
  'draft-07': 0xff000007,
  'draft-08': 0xff000008,
  'draft-09': 0xff000009,
  'draft-10': 0xff00000a,
  'draft-11': 0xff00000b,
  'draft-12': 0xff00000c,
  'draft-13': 0xff00000d,
  'draft-14': 0xff00000e,
  'draft-15': 0xff00000f,
  'draft-16': 0xff000010,
  'draft-17': 0xff000011,
};

/** Map a version wire number to its human-readable draft name */
export const VERSION_DISPLAY_NAMES: Record<number, string> = {
  0xff000007: 'draft-07',
  0xff000008: 'draft-08',
  0xff000009: 'draft-09',
  0xff00000a: 'draft-10',
  0xff00000b: 'draft-11',
  0xff00000c: 'draft-12',
  0xff00000d: 'draft-13',
  0xff00000e: 'draft-14',
  0xff00000f: 'draft-15',
  0xff000010: 'draft-16',
  0xff000011: 'draft-17',
};

/** Map a SupportedDraft to the version wire number */
export const DRAFT_TO_VERSION: Record<SupportedDraft, number> = {
  '07': 0xff000007,
  '08': 0xff000008,
  '09': 0xff000009,
  '10': 0xff00000a,
  '11': 0xff00000b,
  '12': 0xff00000c,
  '13': 0xff00000d,
  '14': 0xff00000e,
  '15': 0xff00000f,
  '16': 0xff000010,
  '17': 0xff000011,
};
