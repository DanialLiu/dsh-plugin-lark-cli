import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CONFIG_DEFAULTS, type LarkConfig } from '../src/config-defaults.ts'
import type { Deps } from '../src/deps.ts'
import { Runner } from '../src/runner.ts'
import { StatusService } from '../src/status.ts'
import { fixture, makeFake, sleep, type ScriptEntry } from './helpers.ts'

const runners: Runner[] = []
afterEach(() => { for (const runner of runners.splice(0)) runner.dispose() })

const V = { stdout: 'lark-cli version 1.0.98\n' }

function setup(script: Record<string, ScriptEntry>, overrides: Partial<LarkConfig> = {}, noCli = false) {
  const fake = makeFake(script)
  const home = mkdtempSync(join(tmpdir(), 'dsh-lark-cli-st-'))
  const config: LarkConfig = { ...CONFIG_DEFAULTS, cliPath: noCli ? join(home, 'missing', 'lark-cli') : fake.bin, installPrefix: join(home, 'managed'), ...overrides }
  const deps: Deps = {
    runner: (() => { const r = new Runner(); runners.push(r); return r })(), config: () => config, dshHome: join(home, 'dsh'), agentsHome: join(home, 'agents'), home,
    env: fake.env, platform: process.platform, now: () => new Date(), processEnv: { PATH: '' }, commonDirs: [], log: { info() {}, warn() {} },
  }
  const service = new StatusService(deps, () => null, async () => false)
  return { fake, deps, service, home }
}

const BOUND = {
  '--version': V,
  'config show': { stdout: fixture('config-show-bound.txt') },
  'auth status --json --verify': { stdout: fixture('auth-status-bot-ready.json') },
  'auth status --json': { stdout: fixture('auth-status-bot-ready.json') },
  'update --check --json': { stdout: fixture('update-available.json') },
}

describe('StatusService', () => {
  it('not installed when no lark-cli is found', async () => {
    const { service } = setup(BOUND, {}, true)
    const s = await service.get()
    expect(s.state).toBe('not-installed')
    expect(s.cli).toBeNull()
    expect(s.binding).toBeNull()
  })

  it('installed-unbound when config show says not_configured (real output)', async () => {
    const { service } = setup({ '--version': V, 'config show': { stdout: fixture('not-configured.json'), code: 2 }, _default: { stdout: fixture('not-configured.json'), code: 2 } })
    const s = await service.get()
    expect(s.state).toBe('installed-unbound')
    expect(s.cli?.version).toBe('1.0.98')
    expect(s.binding).toBeNull()
    expect(s.error).toBeNull()
  })

  it('installed-unbound also when lark-cli prints the not_configured envelope on stderr (what it really does)', async () => {
    const stderrOnly = { stderr: fixture('not-configured.json'), code: 3 }
    const { service } = setup({ '--version': V, 'config show': stderrOnly, _default: stderrOnly })
    const s = await service.get()
    expect(s.state).toBe('installed-unbound')
    expect(s.error).toBeNull()
  })

  it('ready when bound with a ready bot; personal account is a separate, unauthorized dimension', async () => {
    const { service } = setup(BOUND)
    const s = await service.get()
    expect(s.state).toBe('ready')
    expect(s.binding).toMatchObject({ appId: 'cli_test0000000000', brand: 'feishu', botReady: true })
    expect(s.user.status).toBe('unauthorized')
    expect(s.verified).toBe(true)
  })

  it('personal account authorized does not change state', async () => {
    const { service } = setup({ ...BOUND, 'auth status --json --verify': { stdout: fixture('auth-status-user-ok.json') } })
    const s = await service.get()
    expect(s.state).toBe('ready')
    expect(s.user).toMatchObject({ status: 'authorized', userName: '测试用户' })
  })

  it('rebind-required when the app exists but the bot identity fails', async () => {
    const { service } = setup({ ...BOUND, 'auth status --json --verify': { stdout: fixture('auth-status-bot-broken.json') } })
    const s = await service.get()
    expect(s.state).toBe('rebind-required')
    expect(s.binding?.botReady).toBe(false)
  })

  it('degrades to the local result (verified:false) when online verification times out, not to a false verdict', async () => {
    const { service } = setup({ ...BOUND, 'auth status --json --verify': { hang: true } }, { statusTimeoutMs: 4000 })
    const s = await service.get()
    expect(s.state).toBe('ready')
    expect(s.verified).toBe(false)
  }, 20_000)

  it('cold start is bounded by the verify timeout (2s) even when verification and the update check hang', async () => {
    const { service } = setup({ ...BOUND, 'auth status --json --verify': { hang: true }, 'update --check --json': { hang: true } })
    const t0 = Date.now()
    const s = await service.get()
    expect(s.state).toBe('ready')
    // 2s verify timeout + a few process spawns; generous margin because the suite runs in parallel
    expect(Date.now() - t0).toBeLessThan(5_500)
  }, 20_000)

  it('update check runs in the background: first answer is checking, later available with versions', async () => {
    const { service } = setup(BOUND)
    const first = await service.get()
    expect(first.cli?.update).toBe('checking')
    await sleep(900)
    const later = await service.get()
    expect(later.cli).toMatchObject({ update: 'available', latestVersion: '1.0.100', version: '1.0.98', belowMinVersion: false })
  })

  it('unreachable update source is "unavailable", never "up-to-date"', async () => {
    const { service } = setup({ ...BOUND, 'update --check --json': { stdout: '{"ok":false,"error":{"type":"network"}}', code: 1 } })
    await service.get()
    await sleep(900)
    expect((await service.get()).cli?.update).toBe('unavailable')
  })

  it('flags a version below the minimum', async () => {
    const { service } = setup({ ...BOUND, '--version': { stdout: 'lark-cli version 1.0.30\n' } })
    expect((await service.get()).cli?.belowMinVersion).toBe(true)
  })

  it('refresh({checkUpdate}) forgets the cached update result', async () => {
    const { service, fake } = setup(BOUND)
    await service.get()
    await sleep(900)
    const before = fake.calls().filter(c => c.argv[0] === 'update').length
    await service.refresh({ checkUpdate: true })
    await sleep(900)
    expect(fake.calls().filter(c => c.argv[0] === 'update').length).toBe(before + 1)
  })

  it('reports skills as not installed, then in sync from agents, then from the managed export', async () => {
    const { service, deps, home } = setup(BOUND)
    expect((await service.get()).skills).toMatchObject({ source: 'none', inSync: false })
    mkdirSync(join(home, 'agents', 'skills', 'lark-calendar'), { recursive: true })
    writeFileSync(join(home, 'agents', 'skills', 'lark-calendar', 'SKILL.md'), '# x')
    await sleep(900)
    const s = await service.refresh()
    expect(s.skills).toMatchObject({ source: 'agents', count: 1 })
    expect(deps.dshHome).toBeTruthy()
  })

  it('reports a third-party lark plugin as a conflict', async () => {
    const fake = makeFake(BOUND)
    const home = mkdtempSync(join(tmpdir(), 'dsh-lark-cli-st-'))
    const deps: Deps = { runner: (() => { const r = new Runner(); runners.push(r); return r })(), config: () => ({ ...CONFIG_DEFAULTS, cliPath: fake.bin }), dshHome: home, agentsHome: home, home, env: fake.env, platform: process.platform, now: () => new Date(), processEnv: { PATH: '' }, commonDirs: [], log: { info() {}, warn() {} } }
    mkdirSync(join(home, 'profiles', 'desktop', 'node_modules', 'dsh-plugin-lark'), { recursive: true })
    const { StatusService: S } = await import('../src/status.ts')
    // a leftover directory with no dependency entry (what an uninstall can leave behind) is NOT a conflict
    writeFileSync(join(home, 'profiles', 'desktop', 'package.json'), JSON.stringify({ name: 'p', dependencies: {} }))
    expect((await new S(deps, () => null).get()).conflict).toBeNull()
    writeFileSync(join(home, 'profiles', 'desktop', 'package.json'), JSON.stringify({ name: 'p', dependencies: { 'dsh-plugin-lark': 'github:x/y' } }))
    expect((await new S(deps, () => null).get()).conflict).toEqual({ with: 'dsh-plugin-lark' })
  })
})
