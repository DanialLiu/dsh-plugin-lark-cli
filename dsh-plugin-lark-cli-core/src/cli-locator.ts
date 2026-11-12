/**
 * Find lark-cli. A desktop app started from the Dock does not inherit the user's shell PATH, so PATH alone is
 * not enough: the configured path, the plugin's managed prefix, PATH and the usual install locations are all tried.
 */
import { access, realpath } from 'node:fs/promises'
import { constants } from 'node:fs'
import { delimiter, join, resolve, sep } from 'node:path'

export type CliSource = 'config' | 'managed' | 'path' | 'common'

export interface CliCandidate { path: string, source: CliSource }

export interface LocatedCli {
  /** Real path, symbolic links resolved. */
  path: string
  managed: boolean
  source: CliSource
  version: string
}

export interface LocateOptions {
  cliPath: string
  installPrefix: string
  env: NodeJS.ProcessEnv
  home: string
  platform?: NodeJS.Platform
  /** Override the usual install locations (tests; default depends on the platform). */
  commonDirs?: string[] | undefined
  /** Run `--version`; return the version or null when the file is not a working lark-cli. */
  probe: (path: string) => Promise<string | null>
}

/** The real executable inside the managed prefix (not the node-dependent `.bin` shim). */
export function managedBinary(prefix: string, platform: NodeJS.Platform = process.platform): string {
  return join(prefix, 'node_modules', '@larksuite', 'cli', 'bin', platform === 'win32' ? 'lark-cli.exe' : 'lark-cli')
}

/** Ordered, de-duplicated places to look. */
export function candidatePaths(options: Omit<LocateOptions, 'probe'>): CliCandidate[] {
  const platform = options.platform ?? process.platform
  const exe = platform === 'win32' ? 'lark-cli.exe' : 'lark-cli'
  const out: CliCandidate[] = []
  const seen = new Set<string>()
  const add = (path: string, source: CliSource): void => {
    if (path.length === 0 || seen.has(path)) return
    seen.add(path)
    out.push({ path, source })
  }
  if (options.cliPath.length > 0) add(options.cliPath, 'config')
  if (options.installPrefix.length > 0) add(managedBinary(options.installPrefix, platform), 'managed')
  for (const dir of (options.env.PATH ?? options.env.Path ?? '').split(delimiter)) {
    if (dir.length > 0) add(join(dir, exe), 'path')
  }
  const common = options.commonDirs ?? (platform === 'win32'
    ? []
    : [join(options.home, '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin', join(options.home, '.npm-global', 'bin'), join(options.home, 'bin')])
  for (const dir of common) add(join(dir, exe), 'common')
  return out
}

async function isExecutable(path: string): Promise<boolean> {
  try { await access(path, constants.X_OK); return true } catch { return false }
}

async function realOrSelf(path: string): Promise<string> {
  try { return await realpath(path) } catch { return resolve(path) }
}

/**
 * Locate a working lark-cli. A configured path that does not work is reported as "not found" rather than
 * silently falling back, so a wrong override is visible.
 * @returns the first candidate whose `--version` works, or null.
 */
export async function locateCli(options: LocateOptions): Promise<LocatedCli | null> {
  const candidates = candidatePaths(options)
  const prefix = options.installPrefix.length > 0 ? await realOrSelf(options.installPrefix) : ''
  for (const candidate of candidates) {
    if (!(await isExecutable(candidate.path))) continue
    const real = await realOrSelf(candidate.path)
    const version = await options.probe(real)
    if (version === null) {
      if (candidate.source === 'config') return null
      continue
    }
    const managed = candidate.source === 'managed' || (prefix.length > 0 && (real === prefix || real.startsWith(prefix + sep)))
    // A managed install is shown (and run) by its stable path, not by pnpm's internal link target.
    return { path: candidate.source === 'managed' ? candidate.path : real, managed, source: managed ? 'managed' : candidate.source, version }
  }
  return null
}

/** `lark-cli version 1.0.99` → `1.0.99`. */
export function parseVersion(output: string): string | null {
  const match = /(\d+\.\d+\.\d+(?:[-+][\w.]+)?)/.exec(output)
  return match?.[1] ?? null
}

/** Compare dotted versions; ignores pre-release tails. Returns negative, zero or positive. */
export function compareVersions(a: string, b: string): number {
  const pa = (a.split(/[-+]/)[0] ?? '').split('.').map(Number)
  const pb = (b.split(/[-+]/)[0] ?? '').split('.').map(Number)
  for (let i = 0; i < 3; i += 1) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d !== 0) return d
  }
  return 0
}
