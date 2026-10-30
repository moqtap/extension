import {
  ArrowDown,
  ArrowLeftRight,
  ArrowUp,
  Ban,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  ChevronUp,
  Check,
  CircleUser,
  CircleX,
  Copy,
  Download,
  EllipsisVertical,
  Funnel,
  Gauge,
  Info,
  Settings,
  Share2,
  Terminal,
  TriangleAlert,
  Upload,
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
  arrowDown: sized(ArrowDown),
  arrowLeftRight: sized(ArrowLeftRight),
  arrowUp: sized(ArrowUp),
  ban: sized(Ban),
  check: sized(Check),
  chevronDown: sized(ChevronDown),
  chevronLeft: sized(ChevronLeft),
  chevronRight: sized(ChevronRight),
  chevronsLeft: sized(ChevronsLeft),
  chevronsRight: sized(ChevronsRight),
  chevronUp: sized(ChevronUp),
  copy: sized(Copy),
  error: sized(CircleX),
  filter: sized(Funnel),
  gauge: sized(Gauge),
  // Data in, an arrow into the tray; data out, an arrow out of it.
  export: sized(Upload),
  import: sized(Download),
  info: sized(Info),
  more: sized(EllipsisVertical),
  settings: sized(Settings),
  share: sized(Share2),
  terminal: sized(Terminal),
  user: sized(CircleUser),
  warning: sized(TriangleAlert),
  x: sized(X),
} as const

export type IconName = keyof typeof icons
