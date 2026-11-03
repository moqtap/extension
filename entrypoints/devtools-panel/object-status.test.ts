import { describe, expect, it } from 'vitest'
import { SUPPORTED_DRAFTS } from '@/src/types/common'
import { objectContentText, objectStatusName } from './object-status'

const bytes = (n: number) => `${n} B`

/** The draft after the last supported one, unsupported by construction. */
const BEYOND = String(Number(SUPPORTED_DRAFTS[SUPPORTED_DRAFTS.length - 1]) + 1)

describe('objectStatusName', () => {
  it('names each draft generation its own way', () => {
    expect(objectStatusName(3, '22')).toBe('End of Group')
    expect(objectStatusName(4, '22')).toBe('End of Track')
    expect(objectStatusName(1, '22')).toBeNull()
    expect(objectStatusName(1, '14')).toBe('Object Does Not Exist')
    expect(objectStatusName(4, '10')).toBe('End of Track and Group')
    expect(objectStatusName(5, '07')).toBe('End of Subgroup')
    expect(objectStatusName(5, '11')).toBeNull()
  })

  it('names draft-23 statuses as Section 16.9 does, with no Object Does Not Exist', () => {
    expect(objectStatusName(0, '23')).toBe('Normal')
    expect(objectStatusName(3, '23')).toBe('End of Group')
    expect(objectStatusName(4, '23')).toBe('End of Track')
    expect(objectStatusName(1, '23')).toBeNull()
  })

  it('names nothing without a draft, or for one this build does not know', () => {
    expect(objectStatusName(3, undefined)).toBeNull()
    expect(objectStatusName(3, BEYOND)).toBeNull()
  })
})

describe('objectContentText', () => {
  it('names the status of an empty object that marks something', () => {
    expect(objectContentText({ payloadLength: 0, status: 3 }, '22', bytes)).toBe('End of Group')
  })

  it('gives the size of anything else', () => {
    expect(objectContentText({ payloadLength: 515 }, '22', bytes)).toBe('515 B')
    expect(objectContentText({ payloadLength: 0, status: 0 }, '22', bytes)).toBe('0 B')
    expect(objectContentText({ payloadLength: 0 }, '22', bytes)).toBe('0 B')
  })

  it('shows a status the draft does not name by its number', () => {
    expect(objectContentText({ payloadLength: 0, status: 9 }, '22', bytes)).toBe('Status 9')
  })
})
