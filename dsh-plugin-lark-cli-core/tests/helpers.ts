import { afterEach, vi } from 'vitest'
import { chmodSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// These tests spawn real child processes; on a loaded machine the 5s default is too tight.
vi.setConfig({ testTimeout: 30_000 })

const HERE = dirname(fileURLToPath(import.meta.url))
export const FIXTURES = join(HERE, 'fixtures')
export const FAKE_CLI = join(FIXTURES, 'fake-lark-cli.mjs')

export function fixture(name: string): string {
  return readFileSync(join(FIXTURES, 'real', name), 'utf8')
}

export interface ScriptEntry {
  stdout?: string
  stderr?: string
  code?: number
  delayMs?: number
  hang?: boolean
  readStdin?: boolean
  lines?: Array<{ text: string, delayMs?: number }>
  writeFile?: [string, string]
}

export interface Fake {
  dir: string
  /** Executable standing in for lark-cli. */
  bin: string
  env: Record<string, string>
  calls(): Array<{ argv: string[], stdin: string, pid: number }>
  setScript(script: Record<string, ScriptEntry>): void
}

/** A fake lark-cli whose answers come from `script` (see fixtures/fake-lark-cli.mjs). */
export function makeFake(script: Record<string, ScriptEntry>, name = 'lark-cli'): Fake {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-lark-cli-test-'))
  const scriptPath = join(dir, 'script.json')
  const logPath = join(dir, 'calls.jsonl')
  writeFileSync(scriptPath, JSON.stringify(script))
  // A tiny shell wrapper so the file is directly executable regardless of how the repo was checked out.
  const bin = join(dir, name)
  writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${FAKE_CLI}" "$@"\n`)
  chmodSync(bin, 0o755)
  return {
    dir, bin,
    env: { LARK_FAKE_SCRIPT: scriptPath, LARK_FAKE_LOG: logPath },
    calls: () => existsSync(logPath)
      ? readFileSync(logPath, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l) as { argv: string[], stdin: string, pid: number })
      : [],
    setScript: (next) => { writeFileSync(scriptPath, JSON.stringify(next)) },
  }
}

export function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch { return false }
}

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms) })

export const FAKE_PNPM = join(FIXTURES, 'fake-pnpm.mjs')

/** The fake lark-cli answers for a freshly installed copy (version + embedded skills). */
export function freshCliScript(version = '1.0.100'): Record<string, ScriptEntry> {
  return {
    '--version': { stdout: `lark-cli version ${version}\n` },
    'skills list': { stdout: JSON.stringify({ ok: true, skills: [{ name: 'lark-calendar' }, { name: 'lark-shared' }] }) },
    'skills list lark-calendar': { stdout: JSON.stringify({ ok: true, entries: [{ path: 'lark-calendar/SKILL.md', is_dir: false }, { path: 'lark-calendar/references', is_dir: true }] }) },
    'skills list lark-calendar/references': { stdout: JSON.stringify({ ok: true, entries: [{ path: 'lark-calendar/references/create.md', is_dir: false }] }) },
    'skills list lark-shared': { stdout: JSON.stringify({ ok: true, entries: [{ path: 'lark-shared/SKILL.md', is_dir: false }] }) },
    'skills read lark-calendar/SKILL.md': { stdout: '# calendar\n' },
    'skills read lark-calendar/references/create.md': { stdout: '# create\n' },
    'skills read lark-shared/SKILL.md': { stdout: '# shared\n' },
  }
}

import { mkdirSync } from 'node:fs'
import { CONFIG_DEFAULTS, type LarkConfig } from '../src/config-defaults.ts'
import { LarkCore } from '../src/core.ts'
import type { Deps } from '../src/deps.ts'
import { Runner } from '../src/runner.ts'
import type { Job } from '../src/types.ts'

const harnesses: LarkCore[] = []
afterEach(async () => { await Promise.all(harnesses.splice(0).map(core => core.dispose())) })

export interface Harness {
  core: LarkCore
  deps: Deps
  fake: Fake
  home: string
  prefix: string
  config: LarkConfig
}

export const BOUND_SCRIPT: Record<string, ScriptEntry> = {
  '--version': { stdout: 'lark-cli version 1.0.98\n' },
  'config show': { stdout: fixture('config-show-bound.txt') },
  'auth status --json --verify': { stdout: fixture('auth-status-bot-ready.json') },
  'auth status --json': { stdout: fixture('auth-status-bot-ready.json') },
  'update --check --json': { stdout: fixture('update-available.json') },
}

export const UNBOUND_SCRIPT: Record<string, ScriptEntry> = {
  '--version': { stdout: 'lark-cli version 1.0.98\n' },
  'update --check --json': { stdout: fixture('update-managed-no-skills.json') },
  _default: { stdout: fixture('not-configured.json'), code: 2 },
}

/** A LarkCore wired to a fake lark-cli (as an unmanaged, already installed copy) and a temp home. */
export function makeHarness(script: Record<string, ScriptEntry>, overrides: Partial<LarkConfig> = {}, extra: Partial<Deps> = {}, installed = true): Harness {
  const fake = makeFake(script)
  const home = mkdtempSync(join(tmpdir(), 'dsh-lark-cli-h-'))
  const prefix = join(home, 'dsh', 'lark-cli')
  mkdirSync(join(home, 'dsh'), { recursive: true })
  const config: LarkConfig = {
    ...CONFIG_DEFAULTS,
    cliPath: installed ? fake.bin : join(home, 'missing', 'lark-cli'),
    installPrefix: prefix, statusTimeoutMs: 4000, ...overrides,
  }
  const deps: Deps = {
    runner: new Runner(), config: () => config, dshHome: join(home, 'dsh'), agentsHome: join(home, 'agents'), home,
    env: { ...fake.env, FAKE_NODE: process.execPath, FAKE_CLI: FAKE_CLI }, platform: process.platform, now: () => new Date(), processEnv: { PATH: '' }, commonDirs: [],
    log: { info() {}, warn() {} }, ...extra,
  }
  const core = new LarkCore(deps)
  harnesses.push(core)
  return { core, deps, fake, home, prefix, config }
}

/** Wait until `predicate` holds (polling), failing after `ms`. */
export async function until<T>(read: () => T | Promise<T>, predicate: (value: T) => boolean, ms = 8000): Promise<T> {
  const deadline = Date.now() + ms
  let value = await read()
  while (!predicate(value)) {
    if (Date.now() > deadline) throw new Error(`condition not met in ${ms}ms; last value: ${JSON.stringify(value)?.slice(0, 400)}`)
    await sleep(50)
    value = await read()
  }
  return value
}

export const finished = (core: LarkCore): Promise<Job> => until(() => core.job() as Job, j => j !== null && !['running', 'waiting-user'].includes(j.phase))
