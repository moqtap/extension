/**
 * `v-truncated-title`: the element's text as its tooltip, only while the
 * text is cut off.
 */

import type { Directive } from 'vue'

function update(el: HTMLElement) {
  if (el.scrollWidth > el.clientWidth) el.title = el.textContent ?? ''
  else el.removeAttribute('title')
}

const handlers = new WeakMap<HTMLElement, () => void>()

export const vTruncatedTitle: Directive<HTMLElement> = {
  mounted(el) {
    const onEnter = () => update(el)
    handlers.set(el, onEnter)
    el.addEventListener('mouseenter', onEnter)
  },
  beforeUnmount(el) {
    const onEnter = handlers.get(el)
    if (onEnter) el.removeEventListener('mouseenter', onEnter)
  },
}
