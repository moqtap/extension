import type { CliError } from '@/src/cli/messages'
import type { Link } from '@/src/cli/protocol'

export const LINK_LABELS: Record<Link, string> = {
  none: 'None',
  offline: 'Offline',
  '3g': '3G',
  '4g': '4G',
}

export const CLI_ERRORS: Record<CliError, string> = {
  scenario: 'This run plays a scenario, so its link is fixed. Restart moqtap intercept without -s to change it.',
  refused: 'The CLI refused the change. Update moqtap and try again.',
  unreachable: 'The CLI stopped answering. Check that moqtap intercept --bridge is still running.',
}
