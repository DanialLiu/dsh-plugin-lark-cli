/**
 * Folds the read-only lark-cli commands into one IntegrationStatus. Rules:
 *  - not found → not-installed; `config show` without an appId → installed-unbound;
 *  - appId and a ready bot identity → ready; appId without one → rebind-required;
 *  - the personal account is a separate dimension and never changes `state`;
 *  - anything that cannot be determined stays "unknown"/unverified instead of being shown as healthy.
 */
import { access, readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { installPrefixOf, type Deps } from './deps.ts'
import { compareVersions, locateCli, parseVersion, type LocatedCli } from './cli-locator.ts'
import { inspectSkills, type SkillsStatusHint } from './skills.ts'
import { jsonOf, QUIET_ENV } from './runner.ts'
import type { Binding, Brand, CliInfo, ErrorInfo, IntegrationStatus, Job, UpdateState, UserAuthorization } from './types.ts'

interface UpdateCache {
  state: Exclude<UpdateState, 'checking'>
  latest: string | null
  changelog: string | null
  checkedAt: number
  skills: SkillsStatusHint | null
}

type Json = Record<string, unknown>
const asObject = (value: unknown): Json | undefined => (typeof value === 'object' && value !== null ? value as Json : undefined)
const asString = (value: unknown): string | undefined => (typeof value === 'string' && value.length > 0 ? value : undefined)

/**
 * Is a third-party `dsh-plugin-lark` really installed in any profile?
 * Being a dependency of the profile is what counts: a leftover directory after an uninstall is not a conflict.
 */
export async function detectThirdPartyLark(dshHome: string): Promise<boolean> {
  try {
    const profiles = await readdir(join(dshHome, 'profiles'))
    for (const profile of profiles) {
      try {
        const manifest = JSON.parse(await readFile(join(dshHome, 'profiles', profile, 'package.json'), 'utf8')) as { dependencies?: Record<string, unknown> }
        if (manifest.dependencies !== undefined && 'dsh-plugin-lark' in manifest.dependencies) {
          await access(join(dshHome, 'profiles', profile, 'node_modules', 'dsh-plugin-lark'))
          return true
        }
      } catch { /* next */ }
    }
  } catch { /* no profiles */ }
  return false
}

export class StatusService {
  private cache: IntegrationStatus | null = null
  private inflight: Promise<IntegrationStatus> | null = null
  private update: UpdateCache | null = null
  private updating: Promise<void> | null = null
  private located: LocatedCli | null = null
  private disposed = false

  constructor(
    private readonly deps: Deps,
    private readonly getJob: () => Job | null,
    private readonly detectConflict: () => Promise<boolean> = () => detectThirdPartyLark(deps.dshHome),
  ) {}

  /** Last located lark-cli (from the most recent detection). */
  get cli(): LocatedCli | null { return this.located }

  /** Cached snapshot, detecting first when there is none. */
  async get(): Promise<IntegrationStatus> {
    if (this.cache === null) return this.refresh({ checkUpdate: false })
    // Self-heal: a cached answer that says "checking" while nothing is checking would never resolve.
    if (this.located !== null && this.update === null && this.updating === null) this.ensureUpdateCheck(this.located)
    return this.withJob(this.cache)
  }

  /**
   * Re-detect now.
   * @param options.checkUpdate force a fresh update check (otherwise the TTL-cached result is reused).
   */
  async refresh(options: { checkUpdate?: boolean } = {}): Promise<IntegrationStatus> {
    if (options.checkUpdate === true) {
      // Let an in-flight check finish first, otherwise the forced one would be skipped as "already running".
      await this.updating?.catch(() => undefined)
      this.update = null
    }
    this.inflight ??= this.detect().finally(() => { this.inflight = null })
    return this.withJob(await this.inflight)
  }

  /** Forget the update result (after an upgrade or install changes the version). */
  invalidateUpdate(): void { this.update = null }

  dispose(): void { this.disposed = true }

  private withJob(status: IntegrationStatus): IntegrationStatus {
    return { ...status, job: this.getJob() }
  }

  private env(): Record<string, string | undefined> { return { ...QUIET_ENV, ...this.deps.env } }

  private async probe(path: string): Promise<string | null> {
    const result = await this.deps.runner.run(path, ['--version'], { timeoutMs: this.deps.config().statusTimeoutMs, env: this.env() })
    if (result.code !== 0) return null
    return parseVersion(result.stdout + result.stderr)
  }

  private async json(path: string, args: string[], timeoutMs: number): Promise<{ parsed: Json | undefined, timedOut: boolean, failed: boolean }> {
    const result = await this.deps.runner.run(path, args, { timeoutMs, env: this.env() })
    return { parsed: asObject(jsonOf(result)), timedOut: result.timedOut, failed: result.spawnError !== null }
  }

  private async detect(): Promise<IntegrationStatus> {
    const { deps } = this
    const config = deps.config()
    const checkedAt = deps.now().toISOString()
    const conflict = (await this.detectConflict()) ? { with: 'dsh-plugin-lark' as const } : null
    const located = await locateCli({
      cliPath: config.cliPath, installPrefix: installPrefixOf(deps), env: deps.processEnv, home: deps.home, platform: deps.platform, commonDirs: deps.commonDirs,
      probe: path => this.probe(path),
    })
    this.located = located
    const noUser: UserAuthorization = { status: 'unauthorized', userName: null, expiresAt: null }
    if (located === null) {
      return this.store({
        state: 'not-installed', cli: null, binding: null, user: noUser,
        skills: { inSync: null, count: null, source: 'none' }, conflict, verified: false, checkedAt, error: null, job: null,
      })
    }

    const verifyTimeout = Math.min(config.statusTimeoutMs, 2_000)
    const [configShow, authVerified] = await Promise.all([
      this.json(located.path, ['config', 'show'], config.statusTimeoutMs),
      this.json(located.path, ['auth', 'status', '--json', '--verify'], verifyTimeout),
    ])
    let auth = authVerified
    let verified = authVerified.parsed !== undefined && !authVerified.timedOut && authVerified.parsed.ok !== false
    if (!verified) {
      auth = await this.json(located.path, ['auth', 'status', '--json'], config.statusTimeoutMs)
    }

    let error: ErrorInfo | null = null
    const appId = asString(configShow.parsed?.appId)
    let binding: Binding | null = null
    let state: IntegrationStatus['state']
    const identities = asObject(auth.parsed?.identities)
    const bot = asObject(identities?.bot)
    const botReady = bot !== undefined && (bot.status === 'ready' || bot.available === true)

    if (appId === undefined) {
      const subtype = asString(asObject(configShow.parsed?.error)?.subtype)
      if (configShow.parsed !== undefined && (subtype === 'not_configured' || configShow.parsed.ok === false)) {
        state = 'installed-unbound'
      } else {
        // Could not read the configuration at all: report it, keep the previous verdict instead of guessing.
        error = { code: configShow.timedOut ? 'timeout' : 'cli_failed', message: 'could not read the lark-cli configuration' }
        state = this.cache?.state ?? 'installed-unbound'
      }
    } else {
      const brand: Brand = configShow.parsed?.brand === 'lark' ? 'lark' : 'feishu'
      binding = { appId, appName: asString(configShow.parsed?.appName) ?? null, brand, botReady }
      if (auth.parsed === undefined) {
        error = { code: auth.timedOut ? 'timeout' : 'cli_failed', message: 'could not read the lark-cli identity status' }
        state = this.cache?.state === 'rebind-required' ? 'rebind-required' : 'ready'
        verified = false
      } else {
        state = botReady ? 'ready' : 'rebind-required'
      }
    }

    const user = this.userFrom(asObject(identities?.user), auth.parsed !== undefined)
    this.ensureUpdateCheck(located)
    const cli = this.cliInfo(located)
    const skills = await inspectSkills(deps, located.version, this.update?.skills ?? null)
    return this.store({ state, cli, binding, user, skills, conflict, verified, checkedAt, error, job: null })
  }

  private userFrom(user: Json | undefined, authKnown: boolean): UserAuthorization {
    if (user === undefined) return { status: authKnown ? 'unauthorized' : 'unknown', userName: null, expiresAt: null }
    const name = asString(user.userName) ?? null
    const expires = asString(user.expiresAt) ?? asString(user.expires_at) ?? null
    if (user.status === 'expired' || user.tokenStatus === 'expired') return { status: 'expired', userName: name, expiresAt: expires }
    if (user.available === true) return { status: 'authorized', userName: name, expiresAt: expires }
    if (user.status === 'missing') return { status: 'unauthorized', userName: null, expiresAt: null }
    return { status: 'unknown', userName: name, expiresAt: expires }
  }

  private cliInfo(located: LocatedCli): CliInfo {
    const cache = this.update
    const minVersion = this.deps.config().minCliVersion
    let update: UpdateState = 'checking'
    let latest: string | null = null
    if (cache !== null) { update = cache.state; latest = cache.latest }
    return {
      path: located.path, managed: located.managed, version: located.version,
      latestVersion: latest, update, updateCheckedAt: cache === null ? null : new Date(cache.checkedAt).toISOString(),
      minVersion, belowMinVersion: compareVersions(located.version, minVersion) < 0,
      changelogUrl: cache?.changelog ?? null,
    }
  }

  /** Start (at most one) background `update --check` when there is no fresh result. */
  private ensureUpdateCheck(located: LocatedCli): void {
    const ttl = this.deps.config().updateCheckTtlMs
    const cache = this.update
    const age = cache === null ? Infinity : this.deps.now().getTime() - cache.checkedAt
    const limit = cache?.state === 'unavailable' ? Math.min(ttl, 60_000) : ttl
    if (age < limit || this.updating !== null || this.disposed) return
    this.updating = this.checkUpdate(located).finally(() => { this.updating = null })
  }

  private async checkUpdate(located: LocatedCli): Promise<void> {
    const timeout = Math.max(this.deps.config().statusTimeoutMs, 15_000)
    const result = await this.json(located.path, ['update', '--check', '--json'], timeout)
    if (this.disposed) return
    const parsed = result.parsed
    const current = asString(parsed?.current_version) ?? located.version
    const latest = asString(parsed?.latest_version)
    const skillsStatus = asObject(parsed?.skills_status)
    const skills: SkillsStatusHint | null = skillsStatus === undefined ? null
      : { inSync: skillsStatus.in_sync === true, official: typeof skillsStatus.official === 'number' ? skillsStatus.official : 0 }
    if (parsed === undefined || parsed.ok === false || latest === undefined) {
      this.update = { state: 'unavailable', latest: null, changelog: null, checkedAt: this.deps.now().getTime(), skills: null }
    } else {
      this.update = {
        state: compareVersions(latest, current) > 0 ? 'available' : 'up-to-date', latest,
        changelog: asString(parsed.changelog) ?? null, checkedAt: this.deps.now().getTime(), skills,
      }
    }
    // Patch the cached snapshot so the next poll sees the answer without another detection.
    if (this.cache?.cli != null && this.cache.cli.path === located.path) {
      const skillsInfo = await inspectSkills(this.deps, located.version, this.update.skills)
      this.cache = { ...this.cache, cli: this.cliInfo(located), skills: skillsInfo }
    }
  }

  private store(status: IntegrationStatus): IntegrationStatus {
    this.cache = status
    return status
  }
}
