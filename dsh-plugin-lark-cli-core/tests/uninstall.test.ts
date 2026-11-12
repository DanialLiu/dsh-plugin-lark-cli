import { chmodSync, copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { managedBinary } from '../src/cli-locator.ts'
import { ConfirmationRequired } from '../src/types.ts'
import { BOUND_SCRIPT, makeHarness } from './helpers.ts'

/** A harness whose only lark-cli is a copy inside the managed prefix. */
function managedHarness() {
  const h = makeHarness(BOUND_SCRIPT, { cliPath: '' })
  const bin = managedBinary(h.prefix)
  mkdirSync(dirname(bin), { recursive: true })
  copyFileSync(h.fake.bin, bin)
  chmodSync(bin, 0o755)
  return { h, bin }
}

describe('uninstall', () => {
  it('asks for confirmation first and deletes nothing', async () => {
    const { h, bin } = managedHarness()
    await expect(h.core.uninstall({})).rejects.toBeInstanceOf(ConfirmationRequired)
    expect(existsSync(bin)).toBe(true)
  })
  it('removes the managed program and keeps lark-cli settings by default', async () => {
    const { h, bin } = managedHarness()
    mkdirSync(join(h.home, '.lark-cli'), { recursive: true })
    writeFileSync(join(h.home, '.lark-cli', 'config.json'), '{}')
    const status = await h.core.uninstall({ confirm: true })
    expect(existsSync(bin)).toBe(false)
    expect(existsSync(join(h.home, '.lark-cli', 'config.json'))).toBe(true)
    expect(status.state).toBe('not-installed')
  })
  it('with purge also deletes the settings directory', async () => {
    const { h } = managedHarness()
    mkdirSync(join(h.home, '.lark-cli'), { recursive: true })
    writeFileSync(join(h.home, '.lark-cli', 'config.json'), '{}')
    await h.core.uninstall({ confirm: true, purge: true })
    expect(existsSync(join(h.home, '.lark-cli'))).toBe(false)
  })
  it('is allowed while a task is running: the task is cancelled first', async () => {
    const { h, bin } = managedHarness()
    h.core.jobs.start({ kind: 'authorize', timeoutMs: 60_000 }, ctx => new Promise((_, reject) => { ctx.signal.addEventListener('abort', () => { reject(new Error('aborted')) }) }))
    const status = await h.core.uninstall({ confirm: true })
    expect(existsSync(bin)).toBe(false)
    expect(status.job?.phase).toBe('cancelled')
  })
  it('refuses a lark-cli this page did not install', async () => {
    const h = makeHarness(BOUND_SCRIPT)
    await expect(h.core.uninstall({ confirm: true })).rejects.toMatchObject({ info: { code: 'not_writable' } })
    expect(existsSync(h.fake.bin)).toBe(true)
  })
  it('never removes an install prefix that contains the home, DSH home or agents directory', async () => {
    for (const where of ['home', 'dshHome', 'agentsHome'] as const) {
      const { h, bin } = managedHarness()
      // a protected directory lives inside the prefix (as when installPrefix is configured as an ancestor of it)
      h.core.deps[where] = join(h.prefix, 'inside')
      await expect(h.core.uninstall({ confirm: true })).rejects.toMatchObject({ info: { code: 'not_writable' } })
      expect(existsSync(bin)).toBe(true)
    }
  })
})
