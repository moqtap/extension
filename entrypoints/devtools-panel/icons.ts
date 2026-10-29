import {
  Ban,
  ChevronLeft,
  ChevronRight,
  Copy,
  Download,
  Gauge,
  Import,
  LogIn,
  PanelLeftClose,
  PanelLeftOpen,
  Share,
  Terminal,
  X,
} from 'lucide-static'

// Lucide draws on a 24 grid; at 16px a 2.25 stroke renders as the design
// system's 1.5px line (Lucide's absoluteStrokeWidth).
function sized(svg: string): string {
  return svg
    .trim()
    .replace('width="24"', 'width="16"')
    .replace('height="24"', 'height="16"')
    .replace('stroke-width="2"', 'stroke-width="2.25" aria-hidden="true" focusable="false"')
}

export const icons = {
  ban: sized(Ban),
  chevronLeft: sized(ChevronLeft),
  chevronRight: sized(ChevronRight),
  copy: sized(Copy),
  download: sized(Download),
  gauge: sized(Gauge),
  import: sized(Import),
  logIn: sized(LogIn),
  panelLeftClose: sized(PanelLeftClose),
  panelLeftOpen: sized(PanelLeftOpen),
  share: sized(Share),
  terminal: sized(Terminal),
  x: sized(X),
} as const

export type IconName = keyof typeof icons
