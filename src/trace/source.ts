/**
 * The `source` string stamped into every .moqtrace file this extension writes.
 *
 * Read from the manifest rather than written by hand, so it follows the
 * released version on its own: wxt fills the manifest's version field from
 * package.json at build time, which is the same number the release tag
 * carries. Hardcoding it meant exported traces claimed 0.1.0 long after the
 * extension had moved on, which is worse than useless in a bug report.
 *
 * Outside an extension context there is no manifest to read — unit tests run
 * in a bare node environment where `browser` is not defined at all, so the
 * check is `typeof` rather than a property access. Those callers get `dev`,
 * which is at least honest about the trace not coming from a real build.
 */
export function traceSource(): string {
  const version =
    typeof browser !== 'undefined'
      ? browser.runtime?.getManifest?.().version
      : undefined
  return `moqtap-extension/${version ?? 'dev'}`
}
