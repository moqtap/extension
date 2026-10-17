import { describe, expect, it } from 'vitest'
import { applyTheme, themeFor } from './theme'

describe('theme', () => {
  it('maps Chrome and Firefox theme names', () => {
    expect(themeFor('default')).toBe('light')
    expect(themeFor('light')).toBe('light')
    expect(themeFor('dark')).toBe('dark')
    expect(themeFor('none')).toBeNull()
    expect(themeFor(undefined)).toBeNull()
  })

  it('sets data-theme, or removes it to follow the system', () => {
    const root = { dataset: {} as DOMStringMap } as HTMLElement
    applyTheme(root, 'dark')
    expect(root.dataset.theme).toBe('dark')
    applyTheme(root, 'none')
    expect(root.dataset.theme).toBeUndefined()
  })
})
