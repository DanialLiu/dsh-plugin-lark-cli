import { describe, expect, it } from 'vitest'
import { JobManager } from '../src/jobs.ts'
import { ApiError, JobFailure, type Job } from '../src/types.ts'
import { sleep } from './helpers.ts'

const never = (ctx: { signal: AbortSignal }): Promise<void> => new Promise((_, reject) => { ctx.signal.addEventListener('abort', () => { reject(new Error('aborted')) }) })

describe('JobManager', () => {
  it('runs a job to success and settles once', async () => {
    const settled: Job[] = []
    const jobs = new JobManager({ onSettled: (j) => { settled.push(j) } })
    const job = jobs.start({ kind: 'install', timeoutMs: 5000 }, async (ctx) => { ctx.log('hello') })
    expect(job.phase).toBe('running')
    await jobs.settled()
    expect(jobs.snapshot()?.phase).toBe('succeeded')
    expect(jobs.snapshot()?.log).toEqual(['hello'])
    expect(settled).toHaveLength(1)
    expect(jobs.active).toBe(false)
  })
  it('re-detects before the job reads as finished (a poller never sees "done" next to a stale status)', async () => {
    let seen: string | undefined
    const jobs = new JobManager({ onSettled: async () => { await sleep(20); seen = jobs.snapshot()?.phase } })
    jobs.start({ kind: 'install', timeoutMs: 5000 }, async () => {})
    await jobs.settled()
    expect(seen).toBe('running')
    expect(jobs.snapshot()?.phase).toBe('succeeded')
  })
  it('rejects a second start with job_in_progress and the current job', async () => {
    const jobs = new JobManager()
    jobs.start({ kind: 'install', timeoutMs: 5000 }, never)
    let error: unknown
    try { jobs.start({ kind: 'bind-new', timeoutMs: 5000 }, never) } catch (e) { error = e }
    expect(error).toBeInstanceOf(ApiError)
    expect((error as ApiError).info.code).toBe('job_in_progress')
    expect(((error as ApiError).extra.job as Job).kind).toBe('install')
    await jobs.dispose()
  })
  it('cancel aborts, runs cleanups and ends cancelled', async () => {
    const cleaned: string[] = []
    const jobs = new JobManager()
    jobs.start({ kind: 'bind-new', timeoutMs: 5000 }, async (ctx) => {
      ctx.onCleanup(() => { cleaned.push('tmp') })
      ctx.setPhase('waiting-user')
      ctx.setHandoff({ url: 'https://x', qrPngBase64: null, expiresAt: null })
      await never(ctx)
    })
    expect(jobs.snapshot()?.phase).toBe('waiting-user')
    const job = await jobs.cancel()
    expect(job.phase).toBe('cancelled')
    expect(job.handoff).toBeNull()
    expect(cleaned).toEqual(['tmp'])
    expect(jobs.active).toBe(false)
  })
  it('times out', async () => {
    const jobs = new JobManager()
    jobs.start({ kind: 'authorize', timeoutMs: 100 }, never)
    await jobs.settled()
    const job = jobs.snapshot()
    expect(job?.phase).toBe('timed-out')
    expect(job?.failure?.code).toBe('timeout')
  })
  it('records a typed failure', async () => {
    const jobs = new JobManager()
    jobs.start({ kind: 'install', timeoutMs: 5000 }, async () => { throw new JobFailure({ code: 'install_failed', message: 'boom', manualCommand: 'npm i -g x' }) })
    await jobs.settled()
    expect(jobs.snapshot()?.phase).toBe('failed')
    expect(jobs.snapshot()?.failure?.manualCommand).toBe('npm i -g x')
  })
  it('allows a new job after a terminal one and keeps the last result readable', async () => {
    const jobs = new JobManager()
    jobs.start({ kind: 'install', timeoutMs: 5000 }, async () => { throw new Error('x') })
    await jobs.settled()
    expect(jobs.snapshot()?.phase).toBe('failed')
    jobs.start({ kind: 'update', timeoutMs: 5000 }, async () => { await sleep(10) })
    expect(jobs.snapshot()?.kind).toBe('update')
    await jobs.settled()
  })
  it('caps the log', async () => {
    const jobs = new JobManager()
    jobs.start({ kind: 'install', timeoutMs: 5000 }, async (ctx) => { for (let i = 0; i < 500; i += 1) ctx.log(`line ${i}`) })
    await jobs.settled()
    const log = jobs.snapshot()?.log ?? []
    expect(log.length).toBeLessThanOrEqual(200)
    expect(log.at(-1)).toBe('line 499')
  })
  it('dispose cancels the active job and refuses new ones', async () => {
    const cleaned: string[] = []
    const jobs = new JobManager()
    jobs.start({ kind: 'install', timeoutMs: 5000 }, async (ctx) => { ctx.onCleanup(() => { cleaned.push('c') }); await never(ctx) })
    await jobs.dispose()
    expect(cleaned).toEqual(['c'])
    expect(() => jobs.start({ kind: 'install', timeoutMs: 5000 }, never)).toThrow()
  })
  it('cancel with no job reports no_job', async () => {
    await expect(new JobManager().cancel()).rejects.toMatchObject({ info: { code: 'no_job' } })
  })
})
