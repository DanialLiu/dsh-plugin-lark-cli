/** Operations behind the HTTP routes: validation, confirmation gates, job start. No HTTP here, so it tests cleanly. */
import { rm } from 'node:fs/promises'
import { join, sep } from 'node:path'
import type { Deps } from './deps.ts'
import { installPrefixOf } from './deps.ts'
import { runAuthorize, runLogout, userIdentityReady } from './auth.ts'
import { runBindExisting, runBindNew, validateExisting } from './binder.ts'
import type { LocatedCli } from './cli-locator.ts'
import { exportSkills, installManaged, PACKAGE } from './installer.ts'
import { JobManager, type JobContext } from './jobs.ts'
import { StatusService } from './status.ts'
import { ApiError, ConfirmationRequired, JobFailure, type Brand, type IntegrationStatus, type Job } from './types.ts'
import { runUpgrade } from './updater.ts'

export interface BindBody {
  mode?: unknown
  brand?: unknown
  appId?: unknown
  appSecret?: unknown
  replace?: unknown
  confirm?: unknown
}

export class LarkCore {
  readonly jobs: JobManager
  readonly status: StatusService

  constructor(readonly deps: Deps) {
    this.jobs = new JobManager({ now: deps.now, onSettled: async () => { await this.status.refresh({ checkUpdate: false }) } })
    this.status = new StatusService(deps, () => this.jobs.snapshot())
  }

  async dispose(): Promise<void> {
    this.status.dispose()
    await this.jobs.dispose()
    this.deps.runner.dispose()
  }

  private async requireCli(): Promise<LocatedCli> {
    await this.status.refresh()
    const cli = this.status.cli
    if (cli === null) throw new ApiError({ code: 'not_installed', message: 'lark-cli is not installed' })
    return cli
  }

  getStatus(): Promise<IntegrationStatus> { return this.status.get() }
  refresh(checkUpdate: boolean): Promise<IntegrationStatus> { return this.status.refresh({ checkUpdate }) }
  job(): Job | null { return this.jobs.snapshot() }
  cancel(): Promise<Job> { return this.jobs.cancel() }

  async install(confirm: unknown): Promise<Job> {
    const current = await this.status.refresh()
    if (current.cli !== null) throw new ApiError({ code: 'already_installed', message: 'lark-cli is already installed' })
    if (confirm !== true) {
      throw new ConfirmationRequired('installing lark-cli needs your confirmation', { source: 'npm', package: PACKAGE, target: installPrefixOf(this.deps) })
    }
    return this.jobs.start({ kind: 'install', timeoutMs: this.deps.config().installTimeoutMs }, async (ctx) => {
      const version = await installManaged(this.deps, ctx)
      ctx.setVersions(null, version)
      this.status.invalidateUpdate()
    })
  }

  async update(confirm: unknown): Promise<Job> {
    const cli = await this.requireCli()
    const current = await this.status.get()
    const info = current.cli
    if (info === null || info.update !== 'available' || info.latestVersion === null) {
      throw new ApiError({ code: 'no_update', message: 'lark-cli is already up to date' })
    }
    if (confirm !== true) {
      throw new ConfirmationRequired('upgrading lark-cli needs your confirmation', { from: info.version, to: info.latestVersion, source: 'npm', managed: info.managed })
    }
    const to = info.latestVersion
    return this.jobs.start({ kind: 'update', timeoutMs: this.deps.config().installTimeoutMs, fromVersion: info.version, toVersion: to }, async (ctx) => {
      await runUpgrade(this.deps, ctx, cli, to)
      this.status.invalidateUpdate()
    })
  }

  async bind(body: BindBody): Promise<Job> {
    const cli = await this.requireCli()
    const replace = body.replace === true
    const current = await this.status.get()
    if (replace) {
      if (current.state === 'installed-unbound') throw new ApiError({ code: 'invalid_input', message: 'nothing to replace: lark-cli is not bound yet' })
      if (body.confirm !== true) {
        throw new ConfirmationRequired('this replaces the current binding and signs out the personal account', {
          appId: current.binding?.appId ?? null, replacesUser: current.user.status === 'authorized',
        })
      }
    }
    const brand: Brand = body.brand === 'lark' ? 'lark' : 'feishu'
    if (body.mode === 'new') {
      return this.jobs.start({ kind: 'bind-new', replace, timeoutMs: this.deps.config().bindTimeoutMs }, async (ctx) => { ctx.setStage('bind'); await runBindNew(this.deps, ctx, cli, { brand }); await this.authorizeAfterBind(ctx, cli) })
    }
    if (body.mode === 'existing') {
      const input = validateExisting(body)
      return this.jobs.start({ kind: 'bind-existing', replace, timeoutMs: this.deps.config().statusTimeoutMs * 6 }, async (ctx) => { ctx.setStage('bind'); await runBindExisting(this.deps, ctx, cli, input); await this.authorizeAfterBind(ctx, cli) })
    }
    throw new ApiError({ code: 'invalid_input', message: 'mode must be "new" or "existing"' })
  }

  /** Binding is followed by the personal-account step of the same flow (a rebind signs the account out). */
  private async authorizeAfterBind(ctx: JobContext, cli: LocatedCli): Promise<void> {
    if (ctx.signal.aborted) return
    // Show the finished bind (step 2 done, step 3 appears) while the authorization is still waiting for the user.
    await this.status.refresh()
    if (await userIdentityReady(this.deps, cli)) return
    ctx.setStage('authorize')
    ctx.log('app bound; starting personal-account authorization')
    await runAuthorize(this.deps, ctx, cli)
  }

  async authorize(confirm: unknown): Promise<Job> {
    const cli = await this.requireCli()
    const current = await this.status.get()
    if (current.binding === null) throw new ApiError({ code: 'not_bound', message: 'bind a Feishu app first' })
    if (confirm !== true) {
      throw new ConfirmationRequired('this signs in as you, with lark-cli\'s default scope', { scope: 'lark-cli-default' })
    }
    return this.jobs.start({ kind: 'authorize', timeoutMs: this.deps.config().bindTimeoutMs }, ctx => runAuthorize(this.deps, ctx, cli))
  }

  /** Re-export the skills embedded in the installed lark-cli ("skills not ready" can be retried). */
  async syncSkills(): Promise<Job> {
    const cli = await this.requireCli()
    return this.jobs.start({ kind: 'skills', timeoutMs: this.deps.config().installTimeoutMs, toVersion: cli.version }, async (ctx) => {
      const ok = await exportSkills(this.deps, cli.path, cli.version, ctx)
      if (!ok) throw new JobFailure({ code: 'cli_failed', message: 'skills could not be synced', hint: 'skills-sync' })
    })
  }

  /**
   * Remove the lark-cli this plugin installed (the managed prefix only: a copy installed another way is never touched).
   * With `purge`, the personal account is signed out and lark-cli's own settings directory (binding, login) is deleted too.
   */
  async uninstall(body: { confirm?: unknown, purge?: unknown }): Promise<IntegrationStatus> {
    const cli = await this.requireCli()
    const prefix = installPrefixOf(this.deps)
    if (!cli.managed || prefix.length === 0 || !cli.path.startsWith(prefix + sep)) {
      throw new ApiError({ code: 'not_writable', message: 'this lark-cli was not installed by this page' })
    }
    const purge = body.purge === true
    if (body.confirm !== true) {
      throw new ConfirmationRequired('uninstalling lark-cli needs your confirmation', { target: prefix, purge })
    }
    // Uninstalling is always allowed: a task still running (e.g. waiting for the browser) is stopped first.
    if (this.jobs.active) await this.jobs.cancel()
    if (purge) {
      try { await runLogout(this.deps, cli) } catch { /* signing out is best effort: the settings are deleted next anyway */ }
      await rm(join(this.deps.home, '.lark-cli'), { recursive: true, force: true })
    }
    await rm(prefix, { recursive: true, force: true })
    this.status.invalidateUpdate()
    return this.status.refresh()
  }

  async logout(): Promise<IntegrationStatus> {
    const cli = await this.requireCli()
    if (this.jobs.active) throw new ApiError({ code: 'job_in_progress', message: 'another task is running' }, { job: this.jobs.snapshot() })
    await runLogout(this.deps, cli)
    return this.status.refresh()
  }
}
