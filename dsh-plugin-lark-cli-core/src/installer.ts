/**
 * Managed install/upgrade of lark-cli into the plugin's managed prefix. The new copy is built in a sibling directory,
 * self-checked, and only then swapped in, so a failed or interrupted run leaves the previous working version
 * untouched. Skills are exported afterwards; a skills failure never undoes a good install.
 */
import { mkdir, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { installPrefixOf, type Deps } from './deps.ts'
import { managedBinary, parseVersion } from './cli-locator.ts'
import type { JobContext } from './jobs.ts'
import { resolveInstaller, type Installer } from './pnpm.ts'
import { redact, QUIET_ENV } from './runner.ts'
import { syncSkills } from './skills.ts'
import { JobFailure, type ErrorInfo } from './types.ts'

export const PACKAGE = '@larksuite/cli'
export const MANUAL_INSTALL = `npm install -g ${PACKAGE}`
export const MANUAL_ALT = `npx ${PACKAGE}@latest install`

const NETWORK = /ENOTFOUND|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|network|getaddrinfo|socket hang up|fetch failed/i

export function manualInstallError(message: string, code: ErrorInfo['code'] = 'install_failed'): JobFailure {
  return new JobFailure({ code, message, manualCommand: MANUAL_INSTALL })
}

export interface InstallPlan {
  /** Exact version to install; undefined = latest. */
  version?: string | undefined
}

async function installPackage(deps: Deps, installer: Installer, dir: string, version: string | undefined, ctx: JobContext): Promise<void> {
  const spec = version === undefined ? `${PACKAGE}@latest` : `${PACKAGE}@${version}`
  const registry = deps.config().registry
  await writeFile(join(dir, 'package.json'), `${JSON.stringify({ name: 'lark-cli-managed', private: true }, null, 2)}\n`)
  const args = installer.kind === 'pnpm'
    ? [...installer.prefix, 'add', '--dir', dir, spec, ...(registry ? ['--registry', registry] : [])]
    : [...installer.prefix, 'install', '--prefix', dir, spec, ...(registry ? ['--registry', registry] : [])]
  if (installer.kind === 'pnpm') {
    // pnpm refuses dependency build scripts by default; lark-cli's postinstall is what downloads its binary.
    // The tree is built in a staging directory and renamed into place, so it must be relocatable: pnpm's default
    // layout uses absolute-path junctions on Windows, which dangle after the rename. `hoisted` makes real directories.
    await writeFile(join(dir, 'pnpm-workspace.yaml'), `nodeLinker: hoisted\nallowBuilds:\n  "${PACKAGE}": true\n`)
  }
  ctx.log(`installing ${spec} (${installer.description}); this downloads the program and can take a minute or two`)
  const tail: string[] = []
  const run = deps.runner.start(installer.command, args, {
    timeoutMs: deps.config().installTimeoutMs, signal: ctx.signal, cwd: dir, env: { ...installer.env, ...deps.env },
    onLine: (line) => { const safe = redact(line); tail.push(safe); if (tail.length > 40) tail.shift(); ctx.log(safe) },
  })
  ctx.onCleanup(() => { run.kill() })
  const result = await run.done
  if (ctx.signal.aborted) throw new Error('aborted')
  if (result.spawnError !== null) throw manualInstallError(`could not start the installer: ${redact(result.spawnError)}`)
  if (result.code !== 0) {
    const text = tail.join('\n')
    throw new JobFailure({
      code: NETWORK.test(text) ? 'network_unreachable' : 'install_failed',
      message: NETWORK.test(text) ? 'could not reach the package registry' : 'installing lark-cli failed',
      hint: tail.slice(-3).join(' | '), manualCommand: MANUAL_INSTALL,
    })
  }
}

async function selfCheck(deps: Deps, binary: string, ctx: JobContext): Promise<string> {
  const result = await deps.runner.run(binary, ['--version'], { timeoutMs: deps.config().statusTimeoutMs * 2, signal: ctx.signal, env: { ...QUIET_ENV, ...deps.env } })
  const version = result.code === 0 ? parseVersion(result.stdout + result.stderr) : null
  if (version === null) throw new JobFailure({ code: 'self_check_failed', message: 'the downloaded lark-cli does not run', manualCommand: MANUAL_INSTALL })
  return version
}

/**
 * Install or upgrade lark-cli in the managed prefix, then export its skills.
 * @returns the installed version.
 */
export async function installManaged(deps: Deps, ctx: JobContext, plan: InstallPlan = {}): Promise<string> {
  const prefix = installPrefixOf(deps)
  const installer = deps.installerOverride !== undefined ? await deps.installerOverride() : await resolveInstaller(deps)
  if (installer === null) {
    throw new JobFailure({ code: 'no_installer', message: 'no installer is available on this machine', hint: 'install-manually', manualCommand: MANUAL_INSTALL })
  }
  await mkdir(join(prefix, '..'), { recursive: true })
  const tag = randomBytes(4).toString('hex')
  const staging = `${prefix}.new-${tag}`
  const backup = `${prefix}.old-${tag}`
  ctx.onCleanup(async () => { await rm(staging, { recursive: true, force: true }) })
  await mkdir(staging, { recursive: true })

  await installPackage(deps, installer, staging, plan.version, ctx)
  const candidate = await selfCheck(deps, managedBinary(staging, deps.platform), ctx)
  ctx.log(`downloaded lark-cli ${candidate}`)

  // Swap: keep the old copy until the new one proves itself in its final place.
  let hadOld = false
  try { await readdir(prefix); hadOld = true } catch { /* first install */ }
  if (hadOld) await rename(prefix, backup)
  let version: string
  try {
    await rename(staging, prefix)
    version = await selfCheck(deps, managedBinary(prefix, deps.platform), ctx)
  } catch (error) {
    // Restore the previous copy so the user is never left without a working lark-cli.
    await rm(prefix, { recursive: true, force: true })
    if (hadOld) await rename(backup, prefix)
    throw error
  }
  if (hadOld) await rm(backup, { recursive: true, force: true })
  ctx.log(`installed lark-cli ${version} at ${prefix}`)
  await exportSkills(deps, managedBinary(prefix, deps.platform), version, ctx)
  return version
}

/** Export embedded skills; a failure is logged and surfaces as "skills not ready", never as a failed install. */
export async function exportSkills(deps: Deps, binary: string, version: string, ctx: JobContext): Promise<boolean> {
  try {
    const count = await syncSkills(deps, binary, version, { signal: ctx.signal, log: line => { ctx.log(line) } })
    ctx.log(`skills ready (${count})`)
    return true
  } catch (error) {
    if (ctx.signal.aborted) throw error
    ctx.log(`skills sync failed: ${error instanceof Error ? redact(error.message) : 'unknown error'}`)
    return false
  }
}
