import { describe, expect, it } from 'vitest'
import { applyHost, type Host } from './host'

function rootFor(host: Host) {
  const classes: string[] = []
  const props: Record<string, string> = {}
  const root = {
    classList: { add: (...c: string[]) => classes.push(...c) },
    style: { setProperty: (k: string, v: string) => (props[k] = v) },
  }
  applyHost(root as unknown as HTMLElement, host)
  return { classes, props }
}

describe('applyHost', () => {
  it('Chrome: 12px text, 21px rows, 26px toolbar, 28px connection rows', () => {
    expect(rootFor('chrome')).toEqual({
      classes: ['host', 'host--chrome'],
      props: { '--host-text': '12px', '--row-tool': '21px', '--header-tool': '26px', '--row-side': '28px' },
    })
  })

  it('Firefox: 11px text, 24px rows, 28px toolbar, 30px connection rows', () => {
    expect(rootFor('firefox')).toEqual({
      classes: ['host', 'host--firefox'],
      props: { '--host-text': '11px', '--row-tool': '24px', '--header-tool': '28px', '--row-side': '30px' },
    })
  })
})
