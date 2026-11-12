/**
 * Personal-account authorization = lark-cli's device flow, with lark-cli's default scope (the plugin never picks
 * domains). `auth login --no-wait --json` returns the link and a device code at once; a second, background
 * `--device-code` call completes it when the user is done in the browser.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Deps } from './deps.ts'
import type { LocatedCli } from './cli-locator.ts'
import type { JobContext } from './jobs.ts'
import { makeQr } from './qr.ts'
import { explainFailure, isArtLine, jsonOf, redact } from './runner.ts'
import { JobFailure } from './types.ts'

type Json = Record<string, unknown>
/** The page opens this link in a browser: only http(s) is acceptable (never `javascript:` or `file:`). */
const isWebUrl = (v: string | undefined): v is string => {
  if (v === undefined) return false
  try { return ['http:', 'https:'].includes(new URL(v).protocol) } catch { return false }
}
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.length > 0 ? v : undefined)

export async function runAuthorize(deps: Deps, ctx: JobContext, cli: LocatedCli): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-lark-cli-'))
  ctx.onCleanup(async () => { await rm(dir, { recursive: true, force: true }) })
  const started = await deps.runner.run(cli.path, ['auth', 'login', '--no-wait', '--json'], {
    timeoutMs: deps.config().statusTimeoutMs * 2, signal: ctx.signal, env: deps.env,
  })
  if (ctx.signal.aborted) throw new Error('aborted')
  const parsed = jsonOf(started) as Json | undefined
  const url = [parsed?.verification_url, parsed?.verification_uri_complete, parsed?.verification_uri].map(str).find(isWebUrl)
  const deviceCode = str(parsed?.device_code)
  if (started.code !== 0 || parsed === undefined || url === undefined || deviceCode === undefined) {
    ctx.log(redact(started.stderr || started.stdout))
    throw new JobFailure(explainFailure(`${started.stdout}\n${started.stderr}`.split('\n'), [deviceCode ?? '']))
  }
  const expiresIn = typeof parsed.expires_in === 'number' ? parsed.expires_in : null
  const qr = await makeQr(deps, cli.path, url, dir, ctx.signal)
  ctx.setHandoff({
    url, qrPngBase64: qr,
    expiresAt: expiresIn === null ? null : new Date(deps.now().getTime() + expiresIn * 1000).toISOString(),
  })
  ctx.setPhase('waiting-user')

  const tail: string[] = []
  const run = deps.runner.start(cli.path, ['auth', 'login', '--device-code', deviceCode], {
    timeoutMs: deps.config().bindTimeoutMs, signal: ctx.signal, env: deps.env,
    onLine: (line) => { if (isArtLine(line)) return; tail.push(line); if (tail.length > 20) tail.shift(); ctx.log(redact(line, [deviceCode])) },
  })
  ctx.onCleanup(() => { run.kill() })
  const result = await run.done
  if (ctx.signal.aborted) throw new Error('aborted')
  if (result.spawnError !== null || result.code !== 0) {
    // lark-cli exits non-zero when the organization restricts some of its default scopes even though the sign-in was
    // saved. What matters is whether the personal identity is usable, so ask lark-cli itself.
    if (result.spawnError === null && !ctx.signal.aborted && await userIdentityReady(deps, cli)) return
    throw new JobFailure(explainFailure(tail, [deviceCode]))
  }
}

export async function userIdentityReady(deps: Deps, cli: LocatedCli): Promise<boolean> {
  const check = await deps.runner.run(cli.path, ['auth', 'status'], { timeoutMs: deps.config().statusTimeoutMs * 2, env: deps.env })
  const identities = (jsonOf(check) as { identities?: { user?: { status?: unknown } } } | undefined)?.identities
  return identities?.user?.status === 'ready'
}

/** Clear the local sign-in only; the server-side grant is the user's to revoke in Feishu. */
export async function runLogout(deps: Deps, cli: LocatedCli): Promise<void> {
  const result = await deps.runner.run(cli.path, ['auth', 'logout', '--json'], { timeoutMs: deps.config().statusTimeoutMs * 2, env: deps.env })
  const parsed = jsonOf(result) as Json | undefined
  if (result.code !== 0 && parsed?.ok !== true) {
    throw new JobFailure({ code: 'cli_failed', message: 'could not sign out', hint: redact(result.stderr).slice(0, 200) })
  }
}
