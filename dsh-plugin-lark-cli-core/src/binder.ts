/**
 * Binding = lark-cli's own `config init`. `--new` blocks until the user finishes in the browser and prints the
 * link we show (and turn into a QR); the existing-app flow takes the secret on stdin only. Without `--name`,
 * `config init` replaces the current configuration, which is exactly "reconfigure".
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Deps } from './deps.ts'
import type { LocatedCli } from './cli-locator.ts'
import type { JobContext } from './jobs.ts'
import { findUrl, makeQr } from './qr.ts'
import { explainFailure, isArtLine, redact } from './runner.ts'
import { ApiError, JobFailure, type Brand } from './types.ts'

const APP_ID = /^[A-Za-z0-9_-]{6,64}$/

export function validateExisting(input: { appId?: unknown, appSecret?: unknown, brand?: unknown }): { appId: string, appSecret: string, brand: Brand } {
  const brand = input.brand === 'lark' ? 'lark' : 'feishu'
  if (typeof input.appId !== 'string' || !APP_ID.test(input.appId.trim())) {
    throw new ApiError({ code: 'invalid_input', message: 'App ID looks wrong' })
  }
  if (typeof input.appSecret !== 'string' || input.appSecret.length < 8 || /[\r\n]/.test(input.appSecret)) {
    throw new ApiError({ code: 'invalid_input', message: 'App Secret looks wrong' })
  }
  return { appId: input.appId.trim(), appSecret: input.appSecret, brand }
}

function failure(lines: string[], literals: string[]): JobFailure {
  return new JobFailure(explainFailure(lines, literals))
}

/** Create a new bot (the user finishes in the browser). */
export async function runBindNew(deps: Deps, ctx: JobContext, cli: LocatedCli, options: { brand: Brand }): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-lark-cli-'))
  ctx.onCleanup(async () => { await rm(dir, { recursive: true, force: true }) })
  const tail: string[] = []
  let handedOff = false
  const run = deps.runner.start(cli.path, ['config', 'init', '--new', '--brand', options.brand], {
    timeoutMs: deps.config().bindTimeoutMs, signal: ctx.signal, cwd: dir, env: deps.env,
    onLine: (line) => {
      if (isArtLine(line)) return // the ASCII QR lark-cli prints; the page shows a real QR instead
      tail.push(line)
      if (tail.length > 40) tail.shift()
      ctx.log(redact(line))
      const url = handedOff ? null : findUrl(line)
      if (url !== null) {
        handedOff = true
        void makeQr(deps, cli.path, url, dir, ctx.signal).then((qr) => {
          ctx.setHandoff({ url, qrPngBase64: qr, expiresAt: new Date(deps.now().getTime() + deps.config().bindTimeoutMs).toISOString() })
          ctx.setPhase('waiting-user')
        })
      }
    },
  })
  ctx.onCleanup(() => { run.kill() })
  const result = await run.done
  if (ctx.signal.aborted) throw new Error('aborted')
  if (result.spawnError !== null) throw failure([result.spawnError], [])
  if (result.code !== 0) throw failure(tail, [])
}

/** Bind an app the user already has; the secret only ever travels on stdin. */
export async function runBindExisting(deps: Deps, ctx: JobContext, cli: LocatedCli, input: { appId: string, appSecret: string, brand: Brand }): Promise<void> {
  const tail: string[] = []
  const result = await deps.runner.run(cli.path, ['config', 'init', '--app-id', input.appId, '--app-secret-stdin', '--brand', input.brand], {
    timeoutMs: deps.config().statusTimeoutMs * 3, signal: ctx.signal, env: deps.env, stdin: `${input.appSecret}\n`,
  })
  for (const line of `${result.stdout}\n${result.stderr}`.split('\n')) {
    if (line.trim().length > 0) { tail.push(line); ctx.log(redact(line, [input.appSecret])) }
  }
  if (ctx.signal.aborted) throw new Error('aborted')
  if (result.spawnError !== null) throw failure([result.spawnError], [input.appSecret])
  if (result.code !== 0) throw failure(tail, [input.appSecret])
}
