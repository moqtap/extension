/**
 * Object Status names, as each draft assigns them: drafts 07-10 have five
 * code points, 11-15 drop End of Subgroup and rename 0x4 End of Track, and
 * 16 on drop Object Does Not Exist.
 */
const STATUS_07: Record<number, string> = {
  0x0: 'Normal',
  0x1: 'Object Does Not Exist',
  0x3: 'End of Group',
  0x4: 'End of Track and Group',
  0x5: 'End of Subgroup',
}
const STATUS_11: Record<number, string> = {
  0x0: 'Normal',
  0x1: 'Object Does Not Exist',
  0x3: 'End of Group',
  0x4: 'End of Track',
}
const STATUS_16: Record<number, string> = {
  0x0: 'Normal',
  0x3: 'End of Group',
  0x4: 'End of Track',
}

/** The status's name in `draft`, or null when the draft assigns none. */
export function objectStatusName(
  status: number,
  draft: string | null | undefined,
): string | null {
  const n = Number(draft)
  if (!Number.isInteger(n) || n < 7 || n > 22) return null
  const table = n <= 10 ? STATUS_07 : n <= 15 ? STATUS_11 : STATUS_16
  return table[status] ?? null
}

/**
 * What an object holds, for its row or divider: its payload size, or for an
 * empty object that marks something, the status by name.
 */
export function objectContentText(
  obj: { payloadLength: number; status?: number },
  draft: string | null | undefined,
  formatBytes: (n: number) => string,
): string {
  if (obj.payloadLength > 0 || obj.status === undefined || obj.status === 0)
    return formatBytes(obj.payloadLength)
  return objectStatusName(obj.status, draft) ?? `Status ${obj.status}`
}
