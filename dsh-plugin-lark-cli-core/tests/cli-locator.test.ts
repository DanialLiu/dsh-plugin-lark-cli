import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { candidatePaths, compareVersions, locateCli, managedBinary, parseVersion } from '../src/cli-locator.ts'

const probeOk = async (): Promise<string | null> => '1.0.99'

function exe(path: string): void {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, '#!/bin/sh\n')
  chmodSync(path, 0o755)
}

describe('versions', () => {
  it('parses lark-cli output', () => { expect(parseVersion('lark-cli version 1.0.99\n')).toBe('1.0.99') })
  it('returns null without a version', () => { expect(parseVersion('command not found')).toBeNull() })
  it('compares dotted versions', () => {
    expect(compareVersions('1.0.100', '1.0.99')).toBeGreaterThan(0)
    expect(compareVersions('1.0.49', '1.0.49')).toBe(0)
    expect(compareVersions('1.0.9', '1.1.0')).toBeLessThan(0)
  })
})

describe('candidatePaths', () => {
  it('orders config, managed, PATH, common and de-duplicates', () => {
    const list = candidatePaths({ cliPath: '/x/lark-cli', installPrefix: '/p', env: { PATH: '/a:/usr/local/bin' }, home: '/h', platform: 'darwin' })
    expect(list.map(c => c.source)).toEqual(['config', 'managed', 'path', 'path', 'common', 'common', 'common', 'common'])
    expect(list[1].path).toBe(managedBinary('/p', 'darwin'))
    expect(list.filter(c => c.path === '/usr/local/bin/lark-cli')).toHaveLength(1)
  })
})

describe('locateCli', () => {
  it('finds a binary outside PATH via a common location and resolves the symlink (the Dock-launch case)', async () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-lark-cli-home-'))
    const real = join(home, 'elsewhere', 'node', 'lib', 'run.js')
    exe(real)
    mkdirSync(join(home, '.local', 'bin'), { recursive: true })
    symlinkSync(real, join(home, '.local', 'bin', 'lark-cli'))
    const found = await locateCli({ cliPath: '', installPrefix: join(home, 'managed'), env: { PATH: '/usr/bin' }, home, probe: probeOk })
    expect(found?.source).toBe('common')
    expect(found?.path.endsWith('elsewhere/node/lib/run.js')).toBe(true)
    expect(found?.managed).toBe(false)
  })
  it('prefers the managed binary and marks it managed', async () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-lark-cli-home-'))
    const prefix = join(home, 'managed')
    exe(managedBinary(prefix))
    exe(join(home, '.local', 'bin', 'lark-cli'))
    const found = await locateCli({ cliPath: '', installPrefix: prefix, env: { PATH: '' }, home, probe: probeOk })
    expect(found?.managed).toBe(true)
  })
  it('does not fall back when the configured path is not a working lark-cli', async () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-lark-cli-home-'))
    const bad = join(home, 'bad', 'lark-cli')
    exe(bad)
    exe(join(home, '.local', 'bin', 'lark-cli'))
    const probe = async (p: string): Promise<string | null> => (p.includes('/bad/') ? null : '1.0.99')
    expect(await locateCli({ cliPath: bad, installPrefix: '', env: { PATH: '' }, home, probe })).toBeNull()
  })
  it('skips non-working candidates and returns null when nothing works', async () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-lark-cli-home-'))
    exe(join(home, '.local', 'bin', 'lark-cli'))
    expect(await locateCli({ cliPath: '', installPrefix: '', env: { PATH: '' }, home, probe: async () => null })).toBeNull()
  })
})
