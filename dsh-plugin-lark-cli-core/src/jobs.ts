/**
 * Single-flight job manager. At most one state-changing job (install, update, bind, authorize) is active; a
 * second start is rejected with the current job. Every job gets an AbortSignal, a timeout and a cleanup list,
 * and every terminal phase triggers one status refresh.
 */
import { randomUUID } from 'node:crypto'
import { ApiError, isActivePhase, JobFailure, type ErrorInfo, type Handoff, type Job, type JobKind, type JobPhase } from './types.ts'

export const MAX_LOG_LINES = 200
export const MAX_LOG_BYTES = 64 * 1024

export interface JobContext {
  readonly signal: AbortSignal
  /** Append one (already redacted) line to the job log. */
  log(line: string): void
  setPhase(phase: Extract<JobPhase, 'running' | 'waiting-user'>): void
  setHandoff(handoff: Handoff | null): void
  setStage(stage: 'bind' | 'authorize' | null): void
  setVersions(from: string | null, to: string | null): void
  /** Register something to undo when the job ends, whatever the outcome (temp files, child processes). */
  onCleanup(fn: () => void | Promise<void>): void
}

export interface StartOptions {
  kind: JobKind
  timeoutMs: number
  replace?: boolean
  fromVersion?: string | null
  toVersion?: string | null
}

export interface JobManagerDeps {
  now?: () => Date
  /** Called once after a job reaches a terminal phase (status re-detection). Errors are swallowed. */
  onSettled?: (job: Job) => void | Promise<void>
}

interface Active {
  job: Job
  controller: AbortController
  cleanups: Array<() => void | Promise<void>>
  timer: NodeJS.Timeout
  reason: 'cancel' | 'timeout' | null
  settled: Promise<void>
  logBytes: number
}

export class JobManager {
  private current: Active | null = null
  private last: Job | null = null
  private disposed = false
  private readonly now: () => Date

  constructor(private readonly deps: JobManagerDeps = {}) {
    this.now = deps.now ?? (() => new Date())
  }

  /** Snapshot of the active job, else the most recent finished one. */
  snapshot(): Job | null {
    const job = this.current?.job ?? this.last
    return job === null ? null : { ...job, log: [...job.log] }
  }

  get active(): boolean {
    return this.current !== null && isActivePhase(this.current.job.phase)
  }

  /**
   * Start a job. Throws `ApiError(job_in_progress)` when one is already active.
   * @returns the new job's snapshot; the work continues in the background.
   */
  start(options: StartOptions, work: (ctx: JobContext) => Promise<void>): Job {
    if (this.disposed) throw new ApiError({ code: 'internal', message: 'plugin is shutting down' })
    if (this.current !== null && isActivePhase(this.current.job.phase)) {
      throw new ApiError({ code: 'job_in_progress', message: 'another task is already running' }, { job: this.snapshot() })
    }
    const controller = new AbortController()
    const job: Job = {
      id: randomUUID(), kind: options.kind, phase: 'running', replace: options.replace === true,
      fromVersion: options.fromVersion ?? null, toVersion: options.toVersion ?? null,
      log: [], handoff: null, stage: null, failure: null, startedAt: this.now().toISOString(), endedAt: null,
    }
    const active: Active = {
      job, controller, cleanups: [], reason: null, logBytes: 0,
      timer: setTimeout(() => { active.reason = 'timeout'; controller.abort() }, options.timeoutMs),
      settled: Promise.resolve(),
    }
    active.timer.unref()
    this.current = active
    const ctx: JobContext = {
      signal: controller.signal,
      log: (line) => {
        if (isTerminal(job.phase)) return
        active.logBytes += line.length + 1
        job.log.push(line)
        while (job.log.length > MAX_LOG_LINES || active.logBytes > MAX_LOG_BYTES) {
          const dropped = job.log.shift()
          if (dropped === undefined) break
          active.logBytes -= dropped.length + 1
        }
      },
      setPhase: (phase) => { if (!isTerminal(job.phase)) job.phase = phase },
      setHandoff: (handoff) => { if (!isTerminal(job.phase)) job.handoff = handoff },
      setStage: (stage) => { if (!isTerminal(job.phase)) job.stage = stage },
      setVersions: (from, to) => { job.fromVersion = from; job.toVersion = to },
      onCleanup: (fn) => { active.cleanups.push(fn) },
    }
    active.settled = this.run(active, ctx, work)
    return this.snapshot() as Job
  }

  /** Cancel the active job and wait for its cleanup. Throws `no_job` when none is active. */
  async cancel(): Promise<Job> {
    const active = this.current
    if (active === null || !isActivePhase(active.job.phase)) throw new ApiError({ code: 'no_job', message: 'no task to cancel' })
    active.reason = 'cancel'
    active.controller.abort()
    await active.settled
    return this.snapshot() as Job
  }

  /** Wait for the active job (tests, shutdown). */
  async settled(): Promise<void> {
    await this.current?.settled
  }

  /** Abort the active job, run cleanups, refuse new work. */
  async dispose(): Promise<void> {
    this.disposed = true
    const active = this.current
    if (active !== null && isActivePhase(active.job.phase)) {
      active.reason = 'cancel'
      active.controller.abort()
      await active.settled
    }
  }

  private async run(active: Active, ctx: JobContext, work: (ctx: JobContext) => Promise<void>): Promise<void> {
    const { job } = active
    let phase: JobPhase = 'succeeded'
    let failure: ErrorInfo | null = null
    try {
      await work(ctx)
      if (active.controller.signal.aborted) phase = active.reason === 'timeout' ? 'timed-out' : 'cancelled'
    } catch (error) {
      if (active.controller.signal.aborted) {
        phase = active.reason === 'timeout' ? 'timed-out' : 'cancelled'
      } else {
        phase = 'failed'
        failure = error instanceof JobFailure
          ? error.info
          : { code: 'internal', message: error instanceof Error ? error.message : String(error) }
      }
    }
    if (phase === 'timed-out') failure = { code: 'timeout', message: 'the task took too long and was stopped' }
    clearTimeout(active.timer)
    for (const cleanup of active.cleanups.splice(0).reverse()) {
      try { await cleanup() } catch { /* best effort */ }
    }
    job.failure = failure
    job.handoff = null
    // Re-detect while the job still reads as active: a poller must never see "finished" next to a stale status.
    try { await this.deps.onSettled?.({ ...job, phase, failure, log: [...job.log] }) } catch { /* status refresh failures are reported by the status itself */ }
    job.phase = phase
    job.endedAt = this.now().toISOString()
    this.last = job
    if (this.current === active) this.current = null
  }
}

function isTerminal(phase: JobPhase): boolean { return !isActivePhase(phase) }
