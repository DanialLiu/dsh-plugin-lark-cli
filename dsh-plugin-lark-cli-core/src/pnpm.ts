/**
 * Find something that can install an npm package without the user having Node: the pnpm that ships inside the
 * desktop app (run with the app's own executable as Node), else LARK_CLI_PNPM (override), else pnpm/npm from PATH or the
 * usual locations.
 */
import { access } from 'node:fs/promises'
import { constants } from 'node:fs'
import { delimiter, dirname, join } from 'node:path'
import type { Deps } from './deps.ts'
import { QUIET_ENV } from './runner.ts'

export interface Installer {
  kind: 'pnpm' | 'npm'
  command: string
  /** Arguments that precede the subcommand (e.g. the pnpm.cjs path). */
  prefix: string[]
  env: Record<string, string | undefined>
  description: string
}

const exists = async (path: string, mode = constants.R_OK): Promise<boolean> => {
  try { await access(path, mode); return true } catch { return false }
}

/** `<App>/Contents/MacOS/<App name>` → `<App>/Contents/Resources/runtime/.../pnpm.cjs` (also Windows/Linux layouts). */
export async function findBundledPnpm(execPath: string): Promise<string | null> {
  const rel = ['runtime', 'primary-runtime', 'dependencies', 'pnpm', 'bin', 'pnpm.cjs']
  let dir = dirname(execPath)
  for (let i = 0; i < 4; i += 1) {
    for (const resources of ['Resources', 'resources']) {
      const candidate = join(dir, resources, ...rel)
      if (await exists(candidate)) return candidate
    }
    dir = dirname(dir)
  }
  return null
}

async function onPath(name: string, deps: Pick<Deps, 'processEnv' | 'home' | 'platform' | 'commonDirs'>): Promise<string | null> {
  const ext = deps.platform === 'win32' ? '.cmd' : ''
  const dirs = [
    ...(deps.processEnv.PATH ?? '').split(delimiter),
    ...(deps.commonDirs ?? [join(deps.home, '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin', join(deps.home, '.npm-global', 'bin')]),
  ].filter(Boolean)
  for (const dir of dirs) {
    const candidate = join(dir, name + ext)
    if (await exists(candidate, constants.X_OK)) return candidate
  }
  return null
}

/**
 * @param execPath the running executable (process.execPath).
 * @returns the installer to use, or null when none is available (the page then shows manual instructions).
 */
export async function resolveInstaller(deps: Deps, execPath: string = process.execPath, devPnpm: string | undefined = process.env.LARK_CLI_PNPM): Promise<Installer | null> {
  const bundled = await findBundledPnpm(execPath)
  if (bundled !== null) {
    return { kind: 'pnpm', command: execPath, prefix: [bundled], env: { ELECTRON_RUN_AS_NODE: '1', ...QUIET_ENV }, description: 'bundled pnpm' }
  }
  if (devPnpm !== undefined && devPnpm.trim().length > 0) {
    const [command, ...prefix] = devPnpm.trim().split(/\s+/)
    if (command !== undefined) return { kind: 'pnpm', command, prefix, env: {}, description: 'LARK_CLI_PNPM' }
  }
  const pnpm = await onPath('pnpm', deps)
  if (pnpm !== null) return { kind: 'pnpm', command: pnpm, prefix: [], env: {}, description: 'pnpm on PATH' }
  const npm = await onPath('npm', deps)
  if (npm !== null) return { kind: 'npm', command: npm, prefix: [], env: { PATH: `${dirname(npm)}${delimiter}${deps.processEnv.PATH ?? ''}` }, description: 'npm on PATH' }
  return null
}
