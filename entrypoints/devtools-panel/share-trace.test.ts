import { describe, expect, it } from 'vitest'
import { predatesDataCollection } from './share-trace'

describe('predatesDataCollection', () => {
  it('is true for the schema error of a Firefox before 140', () => {
    expect(
      predatesDataCollection(
        new Error('Type error for parameter permissions (Unexpected property "data_collection") for permissions.request.'),
      ),
    ).toBe(true)
  })

  it('is false for a request outside a user gesture', () => {
    expect(
      predatesDataCollection(new Error('permissions.request may only be called from a user input handler')),
    ).toBe(false)
  })

  it('is false for anything else', () => {
    expect(predatesDataCollection(new Error('denied'))).toBe(false)
    expect(predatesDataCollection(undefined)).toBe(false)
  })
})
