import { describe, expect, it } from 'vitest'
import { BOUND_SCRIPT, finished, fixture, makeHarness, until } from './helpers.ts'

async function ready(h: ReturnType<typeof makeHarness>): Promise<void> {
  await h.core.getStatus()
  await until(() => h.core.getStatus(), s => s.cli?.update !== 'checking')
}

describe('upgrade (not managed by the plugin)', () => {
  it('needs confirmation and shows from → to', async () => {
    const h = makeHarness(BOUND_SCRIPT)
    await ready(h)
    await expect(h.core.update(false)).rejects.toMatchObject({ name: 'ConfirmationRequired', details: { from: '1.0.98', to: '1.0.100', managed: false } })
    expect(h.core.job()).toBeNull()
  })

  it('delegates to lark-cli update and keeps the binding', async () => {
    const h = makeHarness({ ...BOUND_SCRIPT, 'update --json': { lines: [{ text: 'updating' }] } })
    await ready(h)
    await h.core.update(true)
    const job = await finished(h.core)
    expect(job.phase).toBe('succeeded')
    expect(job.fromVersion).toBe('1.0.98')
    expect(job.toVersion).toBe('1.0.100')
    expect((await h.core.refresh(false)).binding?.appId).toBe('cli_test0000000000')
  })

  it('the high-risk gate (exit 10) is retried with the flag the CLI asks for, only after the page confirmed', async () => {
    const h = makeHarness({ ...BOUND_SCRIPT, 'update --json': { code: 10, stdout: '{"ok":false,"risk":"high-risk-write","hint":"re-run with --yes"}' }, 'update --json --yes': { stdout: 'ok\n' } })
    await ready(h)
    await h.core.update(true)
    const job = await finished(h.core)
    expect(job.phase).toBe('succeeded')
    const argvs = h.fake.calls().map(c => c.argv.join(' '))
    expect(argvs.indexOf('update --json')).toBeLessThan(argvs.indexOf('update --json --yes'))
  })

  it('cannot write: says why and gives the manual command', async () => {
    const h = makeHarness({ ...BOUND_SCRIPT, 'update --json': { code: 1, stderr: 'npm ERR! EACCES: permission denied, mkdir /usr/local/lib\n' } })
    await ready(h)
    await h.core.update(true)
    const job = await finished(h.core)
    expect(job.failure).toMatchObject({ code: 'not_writable', manualCommand: 'npm install -g @larksuite/cli@latest' })
  })

  it('no update available', async () => {
    const h = makeHarness({ ...BOUND_SCRIPT, 'update --check --json': { stdout: fixture('update-up-to-date.json') } })
    await ready(h)
    await expect(h.core.update(true)).rejects.toMatchObject({ info: { code: 'no_update' } })
  })
})

describe('update check', () => {
  it('unreachable update source is "unavailable", not "latest"', async () => {
    const h = makeHarness({ ...BOUND_SCRIPT, 'update --check --json': { code: 1, stdout: '{"ok":false,"error":{"type":"network"}}' } })
    await ready(h)
    expect((await h.core.getStatus()).cli?.update).toBe('unavailable')
  })

  it('results are reused within the TTL; "Check for updates" forces a new one', async () => {
    const h = makeHarness(BOUND_SCRIPT, { updateCheckTtlMs: 3_600_000 })
    await ready(h)
    const count = () => h.fake.calls().filter(c => c.argv[0] === 'update').length
    expect(count()).toBe(1)
    await h.core.refresh(false)
    await h.core.refresh(false)
    expect(count()).toBe(1)
    await h.core.refresh(true)
    await until(() => count(), n => n === 2)
  })

  it('below the minimum version asks for an upgrade', async () => {
    const h = makeHarness({ ...BOUND_SCRIPT, '--version': { stdout: 'lark-cli version 1.0.30\n' } })
    expect((await h.core.getStatus()).cli?.belowMinVersion).toBe(true)
  })
})
