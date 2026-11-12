import { describe, expect, it } from 'vitest'
import { en, zh } from '../../src/client/locales.ts'
import { needsPolling } from '../../src/client/polling.ts'
import type { IntegrationStatus, Job } from '../../src/types.ts'

const base: IntegrationStatus = {
  state: 'ready', cli: { path: '/x', managed: false, version: '1.0.98', latestVersion: '1.0.100', update: 'available', updateCheckedAt: null, minVersion: '1.0.49', belowMinVersion: false, changelogUrl: null },
  binding: null, user: { status: 'unauthorized', userName: null, expiresAt: null }, skills: { inSync: true, count: 1, source: 'agents' },
  conflict: null, verified: true, checkedAt: '2026-11-11T00:00:00Z', error: null, job: null,
}
const job = (phase: Job['phase']): Job => ({ id: '1', kind: 'install', phase, replace: false, fromVersion: null, toVersion: null, log: [], handoff: null, stage: null, failure: null, startedAt: '', endedAt: null })

describe('polling (only while something moves)', () => {
  it('idle: no polling', () => { expect(needsPolling(base)).toBe(false) })
  it('before the first answer: no polling (the first load does its own request)', () => { expect(needsPolling(null)).toBe(false) })
  it('active job: poll', () => {
    expect(needsPolling({ ...base, job: job('running') })).toBe(true)
    expect(needsPolling({ ...base, job: job('waiting-user') })).toBe(true)
  })
  it('finished job: stop', () => {
    for (const phase of ['succeeded', 'failed', 'cancelled', 'timed-out'] as const) expect(needsPolling({ ...base, job: job(phase) })).toBe(false)
  })
  it('first detection or an update check in flight: poll', () => {
    expect(needsPolling({ ...base, state: 'checking' })).toBe(true)
    expect(needsPolling({ ...base, cli: { ...base.cli!, update: 'checking' } })).toBe(true)
  })
})

describe('copy', () => {
  it('Chinese and English have exactly the same keys', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort())
  })
  it('placeholders match between languages', () => {
    const holes = (s: string): string[] => (s.match(/\{\w+\}/g) ?? []).sort()
    for (const key of Object.keys(zh) as Array<keyof typeof zh>) expect(holes(en[key])).toEqual(holes(zh[key]))
  })
  it('every error code the host can return has a message', () => {
    for (const code of ['job_in_progress', 'not_installed', 'already_installed', 'not_bound', 'no_update', 'invalid_input', 'cli_failed', 'timeout', 'network_unreachable', 'not_writable', 'install_failed', 'self_check_failed', 'no_installer', 'internal']) {
      expect(zh).toHaveProperty(`err_${code}`)
    }
  })
})
