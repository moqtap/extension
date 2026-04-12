/**
 * V8 stack trace parser.
 *
 * Parses `Error().stack` strings into structured frames grouped by
 * async boundaries. Used by StackViewer to render navigable call stacks.
 */

export interface StackFrame {
  functionName: string
  url: string
  line: number
  column: number
  isNative: boolean
  /** Raw source line (fallback when regex doesn't match) */
  raw?: string
}

export interface StackGroup {
  /** True if this group starts at an async boundary */
  isAsync: boolean
  frames: StackFrame[]
}

// V8 stack frame format:
//   "    at [async] FunctionName (url:line:col)"
//   "    at [async] url:line:col"
//   "    at [async] FunctionName (native)"
const FRAME_RE =
  /^\s+at\s+(async\s+)?(?:(.+?)\s+\((.+):(\d+):(\d+)\)|(.+):(\d+):(\d+))$/
const NATIVE_RE = /^\s+at\s+(async\s+)?(.+?)\s+\(native\)$/

/** Frames from the extension's own hook code — strip these from the top */
const INTERNAL_PATTERNS = [
  'content-scripts/',
  'webtransport-hook',
  '__moqtap',
  'wrapWritableStream',
  'Object.write',
  'writer.write',
  'WritableStreamDefaultWriter.write',
]

function isInternalFrame(frame: StackFrame): boolean {
  return INTERNAL_PATTERNS.some(
    (p) => frame.url.includes(p) || frame.functionName.includes(p),
  )
}

export function parseStack(stack: string): StackGroup[] {
  const lines = stack.split('\n')
  const groups: StackGroup[] = []
  let currentGroup: StackGroup = { isAsync: false, frames: [] }

  // Skip the first line (Error message)
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]
    if (!line.trim()) continue

    // Check for native frame
    const nativeMatch = line.match(NATIVE_RE)
    if (nativeMatch) {
      const isAsync = !!nativeMatch[1]
      if (isAsync && currentGroup.frames.length > 0) {
        groups.push(currentGroup)
        currentGroup = { isAsync: true, frames: [] }
      }
      currentGroup.frames.push({
        functionName: nativeMatch[2],
        url: '',
        line: 0,
        column: 0,
        isNative: true,
      })
      continue
    }

    const match = line.match(FRAME_RE)
    if (!match) {
      // Unparseable line — show as raw fallback
      if (line.trim().startsWith('at ') || line.trim().startsWith('async ')) {
        currentGroup.frames.push({
          functionName: '',
          url: '',
          line: 0,
          column: 0,
          isNative: false,
          raw: line.trim(),
        })
      }
      continue
    }

    const isAsync = !!match[1]

    // Start a new group at async boundaries
    if (isAsync && currentGroup.frames.length > 0) {
      groups.push(currentGroup)
      currentGroup = { isAsync: true, frames: [] }
    }

    if (match[2] != null) {
      // "FunctionName (url:line:col)"
      currentGroup.frames.push({
        functionName: match[2],
        url: match[3],
        line: Number(match[4]),
        column: Number(match[5]),
        isNative: false,
      })
    } else {
      // "url:line:col" (anonymous)
      currentGroup.frames.push({
        functionName: '(anonymous)',
        url: match[6],
        line: Number(match[7]),
        column: Number(match[8]),
        isNative: false,
      })
    }
  }

  if (currentGroup.frames.length > 0) {
    groups.push(currentGroup)
  }

  // Strip internal (extension hook) frames from the top of the first group
  if (groups.length > 0) {
    const first = groups[0]
    while (first.frames.length > 0 && isInternalFrame(first.frames[0])) {
      first.frames.shift()
    }
    if (first.frames.length === 0) {
      groups.shift()
    }
  }

  return groups
}

/** Extract just the filename from a URL */
export function shortUrl(url: string): string {
  try {
    const u = new URL(url)
    const path = u.pathname
    const lastSlash = path.lastIndexOf('/')
    return lastSlash >= 0 ? path.substring(lastSlash + 1) : path
  } catch {
    // Not a valid URL — return last segment
    const lastSlash = url.lastIndexOf('/')
    return lastSlash >= 0 ? url.substring(lastSlash + 1) : url
  }
}
