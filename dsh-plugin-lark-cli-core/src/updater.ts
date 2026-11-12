/**
 * Upgrading. A managed install is rebuilt by the installer (verified before it replaces the old copy). Any other
 * install is upgraded by lark-cli itself (`lark-cli update`, which recognises npm/pnpm/manual installs); if that
 * cannot write, the page says why and shows how to do it by hand.
 */
import type { Deps } from './deps.ts'
import type { LocatedCli } from './cli-locator.ts'
import { parseVersion } from './cli-locator.ts'
import { installManaged, MANUAL_INSTALL } from './installer.ts'
import type { JobContext } from './jobs.ts'
import { jsonOf, redact, QUIET_ENV } from './runner.ts'
import { JobFailure } from './types.ts'

const NOT_WRITABLE = /EACCES|EPERM|permission denied|operation not permitted/i
const NETWORK = /ENOTFOUND|ETIMEDOUT|ECONNRESET|EAI_AGAIN|network|getaddrinfo|fetch failed/i
const MANUAL_UPGRADE = 'npm install -g @larksuite/cli@latest'

/** @returns the version after the upgrade. */
export async function runUpgrade(deps: Deps, ctx: JobContext, cli: LocatedCli, toVersion: string | null): Promise<string> {
  if (cli.managed) return installManaged(deps, ctx, { version: toVersion ?? undefined })

  const tail: string[] = []
  const exec = async (args: string[]) => {
    const run = deps.runner.start(cli.path, args, {
      timeoutMs: deps.config().installTimeoutMs, signal: ctx.signal, env: { ...QUIET_ENV, ...deps.env },
      onLine: (line) => { const safe = redact(line); tail.push(safe); if (tail.length > 40) tail.shift(); ctx.log(safe) },
    })
    ctx.onCleanup(() => { run.kill() })
    return run.done
  }
  let result = await exec(['update', '--json'])
  if (result.code === 10) {
    // High-risk-write gate: the user already confirmed in the page, so add the flag the CLI asks for and retry.
    const hint = (jsonOf(result) as { hint?: string } | undefined)?.hint ?? ''
    const flag = /--[a-z][a-z-]*/.exec(hint)?.[0] ?? '--yes'
    ctx.log(`confirmed in the page; retrying with ${flag}`)
    result = await exec(['update', '--json', flag])
  }
  if (ctx.signal.aborted) throw new Error('aborted')
  if (result.spawnError !== null || result.code !== 0) {
    const text = tail.join('\n') + result.stderr
    throw new JobFailure({
      code: NOT_WRITABLE.test(text) ? 'not_writable' : NETWORK.test(text) ? 'network_unreachable' : 'cli_failed',
      message: NOT_WRITABLE.test(text) ? 'this lark-cli was installed somewhere that cannot be written to' : 'lark-cli could not update itself',
      hint: tail.slice(-3).join(' | '), manualCommand: MANUAL_UPGRADE,
    })
  }
  const check = await deps.runner.run(cli.path, ['--version'], { timeoutMs: deps.config().statusTimeoutMs, env: { ...QUIET_ENV, ...deps.env } })
  const version = parseVersion(check.stdout + check.stderr)
  if (version === null) throw new JobFailure({ code: 'self_check_failed', message: 'lark-cli does not run after the update', manualCommand: MANUAL_INSTALL })
  return version
}
