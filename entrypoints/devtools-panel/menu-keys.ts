import type { InjectionKey, Ref } from 'vue'

/** What a key does in a menu, given where the focus is. */
export type MenuKeyAction =
  | { readonly kind: 'focus'; readonly index: number }
  /** Open the focused item's submenu, its first item focused. */
  | { readonly kind: 'open-sub' }
  /** Close this submenu, back to the item that opened it. */
  | { readonly kind: 'close-sub' }
  /** Close every menu and return the focus to what opened them. */
  | { readonly kind: 'close' }
  /** Close every menu and let the focus move on. */
  | { readonly kind: 'leave' }

export interface MenuKeyState {
  /** The focused item among the enabled ones; -1 when none is. */
  readonly index: number
  readonly count: number
  /** The focused item opens a submenu. */
  readonly onTrigger: boolean
  /** This menu is a submenu. */
  readonly nested: boolean
}

/**
 * Arrow keys, Home and End move; ArrowRight, Enter and Space open a submenu;
 * ArrowLeft and Escape close one, Escape closes a top-level menu; Tab leaves.
 */
export function menuKey(key: string, s: MenuKeyState): MenuKeyAction | null {
  const { index: i, count: n } = s
  switch (key) {
    case 'ArrowDown':
      return n > 0 ? { kind: 'focus', index: i < 0 ? 0 : (i + 1) % n } : null
    case 'ArrowUp':
      return n > 0 ? { kind: 'focus', index: i < 0 ? n - 1 : (i - 1 + n) % n } : null
    case 'Home':
      return n > 0 ? { kind: 'focus', index: 0 } : null
    case 'End':
      return n > 0 ? { kind: 'focus', index: n - 1 } : null
    case 'ArrowRight':
    case 'Enter':
    case ' ':
      return s.onTrigger ? { kind: 'open-sub' } : null
    case 'ArrowLeft':
      return s.nested ? { kind: 'close-sub' } : null
    case 'Escape':
      return s.nested ? { kind: 'close-sub' } : { kind: 'close' }
    case 'Tab':
      return { kind: 'leave' }
    default:
      return null
  }
}

/** Shared by a menu and every submenu opened from it. */
export interface MenuRoot {
  /** Every open menu's element, so a click in any of them is inside. */
  readonly menus: Set<HTMLElement>
  closeAll(refocus?: boolean): void
}

/** One menu's own state, shared by the submenu items in it. */
export interface MenuLevel {
  /** The submenu item whose submenu is open. */
  readonly open: Ref<symbol | null>
}

export const MENU_ROOT: InjectionKey<MenuRoot> = Symbol('menu-root')
export const MENU_LEVEL: InjectionKey<MenuLevel> = Symbol('menu-level')

/** The DOM event a menu sends the focused submenu item to open it from the keyboard. */
export const OPEN_SUB_EVENT = 'menu-open-sub'
