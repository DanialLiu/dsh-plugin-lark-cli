/** QR code PNGs come from `lark-cli auth qrcode` (no extra dependency). The output path must be relative to the cwd. */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Deps } from './deps.ts'
import { QUIET_ENV } from './runner.ts'

/**
 * @param bin the lark-cli executable.
 * @param url the verification URL, passed through unchanged.
 * @param dir a private directory used as the cwd; the PNG is written there.
 * @returns the PNG as base64, or null when it could not be made (the link is still shown).
 */
export async function makeQr(deps: Deps, bin: string, url: string, dir: string, signal?: AbortSignal): Promise<string | null> {
  const result = await deps.runner.run(bin, ['auth', 'qrcode', url, '--output', 'qr.png'], {
    timeoutMs: deps.config().statusTimeoutMs, cwd: dir, signal, env: { ...QUIET_ENV, ...deps.env },
  })
  if (result.code !== 0) return null
  try { return (await readFile(join(dir, 'qr.png'))).toString('base64') } catch { return null }
}

/** First http(s) URL in a line of CLI output, unmodified. */
export function findUrl(line: string): string | null {
  const match = /https?:\/\/[^\s"'<>]+/.exec(line)
  return match === null ? null : match[0]
}
