/**
 * Wire and state types shared by the host half and the browser half. These are the JSON bodies of the
 * `/api/lark-cli` routes.
 */

export type IntegrationState = 'checking' | 'not-installed' | 'installed-unbound' | 'ready' | 'rebind-required'
export type Brand = 'feishu' | 'lark'
export type UpdateState = 'checking' | 'up-to-date' | 'available' | 'unavailable'
export type UserAuthStatus = 'unauthorized' | 'authorized' | 'expired' | 'unknown'
export type JobKind = 'install' | 'update' | 'bind-new' | 'bind-existing' | 'authorize' | 'skills'
export type JobPhase = 'running' | 'waiting-user' | 'succeeded' | 'failed' | 'cancelled' | 'timed-out'

/** Closed set of error codes the browser localises. */
export type ErrorCode =
  | 'job_in_progress' | 'not_installed' | 'already_installed' | 'not_bound' | 'no_update'
  | 'confirmation_required' | 'invalid_input' | 'cli_failed' | 'timeout' | 'network_unreachable'
  | 'not_writable' | 'no_job' | 'no_installer' | 'install_failed' | 'self_check_failed' | 'bad_request' | 'internal'

export interface ErrorInfo {
  code: ErrorCode
  message: string
  hint?: string
  /** A command the user can copy and run themselves. */
  manualCommand?: string
}

export interface CliInfo {
  /** Real path of the executable, symbolic links resolved. */
  path: string
  /** True when it lives in the plugin's managed prefix. */
  managed: boolean
  version: string
  latestVersion: string | null
  update: UpdateState
  updateCheckedAt: string | null
  /** Features need at least this version; below it the page asks for an upgrade. */
  minVersion: string
  belowMinVersion: boolean
  changelogUrl: string | null
}

export interface Binding {
  appId: string
  appName: string | null
  brand: Brand
  botReady: boolean
}

export interface UserAuthorization {
  status: UserAuthStatus
  userName: string | null
  expiresAt: string | null
}

export interface SkillsInfo {
  /** null = could not be determined. */
  inSync: boolean | null
  count: number | null
  /** Where the skills the assistant sees come from. */
  source: 'agents' | 'managed' | 'none'
  reason?: string
}

export interface Handoff {
  url: string
  /** PNG, base64; null when no QR could be produced. */
  qrPngBase64: string | null
  expiresAt: string | null
}

export interface Job {
  id: string
  kind: JobKind
  phase: JobPhase
  /** True for a reconfigure (replace the current binding). */
  replace: boolean
  fromVersion: string | null
  toVersion: string | null
  log: string[]
  handoff: Handoff | null
  /** Which wizard step a chained job (bind → authorize) is on; null for single-step jobs. */
  stage: 'bind' | 'authorize' | null
  failure: ErrorInfo | null
  startedAt: string
  endedAt: string | null
}

export interface IntegrationStatus {
  state: IntegrationState
  cli: CliInfo | null
  binding: Binding | null
  user: UserAuthorization
  skills: SkillsInfo
  conflict: { with: 'dsh-plugin-lark' } | null
  /** Whether the bot identity was verified online; false = local result only. */
  verified: boolean
  checkedAt: string
  error: ErrorInfo | null
  job: Job | null
}

/** Terminal job phases. */
export const TERMINAL_PHASES: readonly JobPhase[] = ['succeeded', 'failed', 'cancelled', 'timed-out']
export const isActivePhase = (phase: JobPhase): boolean => phase === 'running' || phase === 'waiting-user'

/** Thrown by job work to report a typed failure. */
export class JobFailure extends Error {
  readonly info: ErrorInfo
  constructor(info: ErrorInfo) {
    super(info.message)
    this.name = 'JobFailure'
    this.info = info
  }
}

/** Thrown when an operation needs the user's confirmation first. */
export class ConfirmationRequired extends Error {
  readonly details: Record<string, unknown>
  constructor(message: string, details: Record<string, unknown> = {}) {
    super(message)
    this.name = 'ConfirmationRequired'
    this.details = details
  }
}

/** Thrown when a request is rejected with a typed code (maps to an HTTP status in routes). */
export class ApiError extends Error {
  readonly info: ErrorInfo
  readonly extra: Record<string, unknown>
  constructor(info: ErrorInfo, extra: Record<string, unknown> = {}) {
    super(info.message)
    this.name = 'ApiError'
    this.info = info
    this.extra = extra
  }
}
