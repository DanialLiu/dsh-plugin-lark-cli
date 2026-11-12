import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { managedBinary } from '../src/cli-locator.ts'
import type { Installer } from '../src/pnpm.ts'
import { alive, FAKE_PNPM, finished, freshCliScript, makeHarness, until, type Harness } from './helpers.ts'

function fakeInstaller(mode: string, tag = 'new'): () => Promise<Installer> {
  return async () => ({ kind: 'pnpm', command: process.execPath, prefix: [FAKE_PNPM], env: { FAKE_PNPM_MODE: mode, FAKE_TAG: tag }, description: 'fake pnpm' })
}

/** Nothing installed yet; the managed prefix is where an install lands. */
function fresh(script = freshCliScript(), mode = 'ok', tag = 'new'): Harness {
  return makeHarness(script, {}, { installerOverride: fakeInstaller(mode, tag) }, false)
}

describe('install', () => {
  it('asks for confirmation first and says what it will do', async () => {
    const h = fresh()
    await expect(h.core.install(false)).rejects.toMatchObject({ name: 'ConfirmationRequired', details: { package: '@larksuite/cli', target: h.prefix } })
    expect(existsSync(h.prefix)).toBe(false)
  })

  it('installs into the managed prefix, self-checks, exports skills, and the status turns installed', async () => {
    const h = fresh()
    await h.core.install(true)
    const job = await finished(h.core)
    expect(job.phase).toBe('succeeded')
    expect(job.toVersion).toBe('1.0.100')
    expect(existsSync(managedBinary(h.prefix))).toBe(true)
    const skills = join(h.home, 'dsh', 'skills')
    expect(readFileSync(join(skills, 'lark-calendar', 'SKILL.md'), 'utf8')).toBe('# calendar\n')
    expect(readFileSync(join(skills, 'lark-calendar', 'references', 'create.md'), 'utf8')).toBe('# create\n')
    expect(readFileSync(join(skills, '.lark-cli-managed'), 'utf8').trim()).toBe('1.0.100')
    const status = await until(() => h.core.getStatus(), s => s.cli !== null)
    expect(status.cli).toMatchObject({ managed: true, version: '1.0.100' })
    expect(status.skills).toMatchObject({ source: 'managed', inSync: true, count: 2 })
    // the background update check may still be finishing; nothing may stay alive after it
    await until(() => h.deps.runner.active, n => n === 0, 10_000)
  })

  it('refuses when already installed', async () => {
    const h = makeHarness(freshCliScript('1.0.98'), {}, { installerOverride: fakeInstaller('ok') })
    await expect(h.core.install(true)).rejects.toMatchObject({ info: { code: 'already_installed' } })
  })

  it('network failure: typed code, manual command, nothing left behind', async () => {
    const h = fresh(freshCliScript(), 'network')
    await h.core.install(true)
    const job = await finished(h.core)
    expect(job.phase).toBe('failed')
    expect(job.failure).toMatchObject({ code: 'network_unreachable', manualCommand: 'npm install -g @larksuite/cli' })
    expect(existsSync(h.prefix)).toBe(false)
    expect(readdirSync(join(h.home, 'dsh')).filter(n => n.includes('.new-'))).toEqual([])
  })

  it('a downloaded copy that does not run fails the self-check and is discarded', async () => {
    const h = fresh(freshCliScript(), 'broken')
    await h.core.install(true)
    const job = await finished(h.core)
    expect(job.failure?.code).toBe('self_check_failed')
    expect(existsSync(h.prefix)).toBe(false)
  })

  it('a failed upgrade keeps the previous working copy', async () => {
    const h = fresh(freshCliScript('1.0.98'), 'ok', 'old')
    await h.core.install(true)
    expect((await finished(h.core)).phase).toBe('succeeded')
    const before = readFileSync(managedBinary(h.prefix), 'utf8')
    expect(before).toContain('tag=old')
    // second run with a broken download
    const second = makeHarness(freshCliScript('1.0.100'), { installPrefix: h.prefix }, { installerOverride: fakeInstaller('broken', 'new') }, true)
    second.config.cliPath = managedBinary(h.prefix)
    await second.core.status.refresh({ checkUpdate: true })
    const job = await (async () => {
      const { installManaged } = await import('../src/installer.ts')
      const { JobManager } = await import('../src/jobs.ts')
      const jobs = new JobManager()
      jobs.start({ kind: 'update', timeoutMs: 20000 }, async (ctx) => { await installManaged(second.deps, ctx) })
      await jobs.settled()
      return jobs.snapshot()
    })()
    expect(job?.phase).toBe('failed')
    expect(readFileSync(managedBinary(h.prefix), 'utf8')).toBe(before)
    expect(readdirSync(join(h.home, 'dsh')).filter(n => n.includes('.new-') || n.includes('.old-'))).toEqual([])
  })

  it('skills sync failure does not fail the install and shows as not ready', async () => {
    const script = { '--version': { stdout: 'lark-cli version 1.0.100\n' } }
    const h = fresh(script as never)
    await h.core.install(true)
    const job = await finished(h.core)
    expect(job.phase).toBe('succeeded')
    expect(job.log.join('\n')).toContain('skills sync failed')
    const status = await until(() => h.core.getStatus(), s => s.cli !== null)
    expect(status.skills.inSync).toBe(false)
    // and the page can retry
    h.fake.setScript(freshCliScript())
    await h.core.syncSkills()
    expect((await finished(h.core)).phase).toBe('succeeded')
    expect((await h.core.refresh(false)).skills).toMatchObject({ source: 'managed', inSync: true })
  })

  it('never writes or deletes outside the skills root, whatever lark-cli lists', async () => {
    const h = fresh({
      ...freshCliScript(),
      'skills list': { stdout: JSON.stringify({ ok: true, skills: [{ name: 'lark-x/../../victim' }, { name: 'lark-shared' }] }) },
      'skills list lark-x/../../victim': { stdout: JSON.stringify({ ok: true, entries: [{ path: 'lark-x/../../victim/SKILL.md', is_dir: false }] }) },
      'skills read lark-x/../../victim/SKILL.md': { stdout: 'planted' },
      'skills list lark-shared': { stdout: JSON.stringify({ ok: true, entries: [{ path: 'lark-shared/../../../escaped.md', is_dir: false }] }) },
      'skills read lark-shared/../../../escaped.md': { stdout: 'planted' },
    } as never)
    const outside = join(h.home, 'dsh', 'victim') // what 'skills/lark-x/../../victim' resolves to
    mkdirSync(outside, { recursive: true })
    writeFileSync(join(outside, 'keep.txt'), 'keep')
    await h.core.install(true)
    const job = await finished(h.core)
    expect(job.log.join('\n')).toContain('skills sync failed')
    expect(readFileSync(join(outside, 'keep.txt'), 'utf8')).toBe('keep')
    expect(existsSync(join(outside, 'SKILL.md'))).toBe(false)
    expect(existsSync(join(h.home, 'dsh', 'escaped.md'))).toBe(false) // staging/lark-shared/../../../escaped.md
  })

  it('cancel stops the installer and leaves no staging directory or process', async () => {
    const h = fresh(freshCliScript(), 'hang')
    await h.core.install(true)
    await until(() => h.fake.dir && h.core.job(), j => j !== null && j.log.some(l => l.includes('installing')))
    const cancelled = await h.core.cancel()
    expect(cancelled.phase).toBe('cancelled')
    expect(readdirSync(join(h.home, 'dsh')).filter(n => n.includes('.new-'))).toEqual([])
    expect(h.deps.runner.active).toBe(0)
  })

  it('no installer available: typed error with a manual command', async () => {
    const h = makeHarness(freshCliScript(), {}, { installerOverride: async () => null }, false)
    await h.core.install(true)
    const job = await finished(h.core)
    expect(job.failure).toMatchObject({ code: 'no_installer', manualCommand: 'npm install -g @larksuite/cli' })
  })
})
