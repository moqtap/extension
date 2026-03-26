/**
 * Tests for draft version display constants.
 *
 * The version module provides lookup tables for UI display only;
 * actual version detection/negotiation is in src/detect/draft-detect.ts.
 */

import { describe, it, expect } from 'vitest';
import {
  DRAFT_VERSION_NUMBERS,
  VERSION_DISPLAY_NAMES,
  DRAFT_TO_VERSION,
} from './version';

// ═══════════════════════════════════════════════════════════════════════
// DRAFT_VERSION_NUMBERS
// ═══════════════════════════════════════════════════════════════════════

describe('DRAFT_VERSION_NUMBERS', () => {
  it('maps draft-14 to 0xff00000e', () => {
    expect(DRAFT_VERSION_NUMBERS['draft-14']).toBe(0xff00000e);
  });

  it('maps draft-07 to 0xff000007', () => {
    expect(DRAFT_VERSION_NUMBERS['draft-07']).toBe(0xff000007);
  });

  it('follows IETF pattern: 0xff000000 + draft number', () => {
    expect(DRAFT_VERSION_NUMBERS['draft-14']).toBe(0xff000000 + 14);
    expect(DRAFT_VERSION_NUMBERS['draft-07']).toBe(0xff000000 + 7);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// VERSION_DISPLAY_NAMES
// ═══════════════════════════════════════════════════════════════════════

describe('VERSION_DISPLAY_NAMES', () => {
  it('maps 0xff00000e to "draft-14"', () => {
    expect(VERSION_DISPLAY_NAMES[0xff00000e]).toBe('draft-14');
  });

  it('maps 0xff000007 to "draft-07"', () => {
    expect(VERSION_DISPLAY_NAMES[0xff000007]).toBe('draft-07');
  });

  it('returns undefined for unknown version numbers', () => {
    expect(VERSION_DISPLAY_NAMES[0xff000001]).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════
// DRAFT_TO_VERSION
// ═══════════════════════════════════════════════════════════════════════

describe('DRAFT_TO_VERSION', () => {
  it('maps "14" to 0xff00000e', () => {
    expect(DRAFT_TO_VERSION['14']).toBe(0xff00000e);
  });

  it('maps "07" to 0xff000007', () => {
    expect(DRAFT_TO_VERSION['07']).toBe(0xff000007);
  });

  it('is consistent with DRAFT_VERSION_NUMBERS', () => {
    expect(DRAFT_TO_VERSION['14']).toBe(DRAFT_VERSION_NUMBERS['draft-14']);
    expect(DRAFT_TO_VERSION['07']).toBe(DRAFT_VERSION_NUMBERS['draft-07']);
  });
});
