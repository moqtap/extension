import { describe, expect, it } from 'vitest'
import { objectContentText, objectStatusName } from './object-status'

const bytes = (n: number) => `${n} B`

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

  it('names nothing without a draft', () => {
    expect(objectStatusName(3, undefined)).toBeNull()
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
