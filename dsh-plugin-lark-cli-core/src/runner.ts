/**
 * Single place that starts child processes. Every command gets a timeout, an AbortSignal, bounded output and
 * redaction before anything reaches a log or a response. Raw stdout is returned for the caller to parse; only
 * `redact()`ed text may be shown or stored.
 */
import { spawn, type ChildProcess } from 'node:child_process'

export interface RunOptions {
  timeoutMs: number
  signal?: AbortSignal | undefined
  /** Written to stdin then closed (secrets go here, never in argv). */
  stdin?: string | undefined
  env?: Record<string, string | undefined> | undefined
  cwd?: string | undefined
  /** Per-stream capture cap in bytes. */
  maxOutputBytes?: number | undefined
}

export interface RunResult {
  code: number | null
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
  timedOut: boolean
  aborted: boolean
  /** Spawn itself failed (ENOENT, EACCES…). */
  spawnError: string | null
}

export interface LongRun {
  readonly done: Promise<RunResult>
  kill(): void
}

export interface LongRunOptions extends RunOptions {
  /** Called for each complete stdout/stderr line (raw; redact before showing). */
  onLine?: (line: string, stream: 'stdout' | 'stderr') => void
}

const DEFAULT_MAX = 256 * 1024
const KILL_GRACE_MS = 2_000

/** Environment that keeps lark-cli output stable and free of notices. */
export const QUIET_ENV: Record<string, string> = {
  LARKSUITE_CLI_NO_UPDATE_NOTIFIER: '1',
  LARKSUITE_CLI_NO_SKILLS_NOTIFIER: '1',
}

/** Agent-context variables that make `lark-cli config init` refuse to run; never pass them on. */
const STRIP_ENV = ['OPENCLAW_HOME', 'HERMES_HOME', 'LARK_CHANNEL'] as const

function childEnv(extra: Record<string, string | undefined> | undefined): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...QUIET_ENV, ...extra }
  for (const key of STRIP_ENV) delete env[key]
  for (const key of Object.keys(env)) if (env[key] === undefined) delete env[key]
  return env
}

const SECRET_KEY = /("?(?:app_?secret|client_?secret|secret|access_?token|refresh_?token|id_?token|token|password|device_?code)"?\s*[:=]\s*)("(?:[^"\\]|\\.)*"|[^\s,}\]]+)/gi

/**
 * Mask secret-looking values in text that may be shown or stored.
 * @param text Raw text.
 * @param literals Extra exact values to mask (for example an appSecret the user typed).
 */
export function redact(text: string, literals: readonly string[] = []): string {
  let out = text.replace(SECRET_KEY, (_m, key: string, value: string) => `${key}${value.startsWith('"') ? '"***"' : '***'}`)
  for (const literal of literals) {
    if (literal.length >= 4) out = out.split(literal).join('***')
  }
  return out
}

/**
 * Pull the first complete JSON object out of text that may have a prefix or trailer (lark-cli prints a
 * "Config file path:" line after `config show`).
 * @returns the parsed value, or undefined when none is found.
 */
export function parseFirstJson(text: string): unknown {
  const start = text.indexOf('{')
  if (start < 0) return undefined
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) {
        try { return JSON.parse(text.slice(start, i + 1)) } catch { return undefined }
      }
    }
  }
  return undefined
}

/** A line of ASCII-art QR code (lark-cli prints one to stderr); never useful in a log. */
export const isArtLine = (line: string): boolean => /^[\s█▄▀▌▐░▒▓■□]+$/u.test(line)

const NETWORK_TEXT = /TLS handshake|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNRESET|ECONNREFUSED|dial tcp|no such host|i\/o timeout|network is unreachable|connection (?:refused|reset)/i

/**
 * Turn what a failed lark-cli printed into a typed error with a one-line human reason (never raw JSON).
 * @param lines the last lines of output.
 * @param literals exact secrets to mask.
 */
export function explainFailure(lines: readonly string[], literals: readonly string[] = []): { code: 'network_unreachable' | 'cli_failed', message: string, hint: string } {
  const text = lines.filter(l => !isArtLine(l)).join('\n')
  const envelope = parseFirstJson(text) as { error?: { type?: string, message?: string } } | undefined
  const reason = envelope?.error?.message ?? text.split('\n').map(l => l.trim()).filter(l => l.length > 0 && !/^[{}\[\],]+$/.test(l)).at(-1) ?? ''
  const network = envelope?.error?.type === 'network' || NETWORK_TEXT.test(text)
  return {
    code: network ? 'network_unreachable' : 'cli_failed',
    message: network ? 'could not reach Feishu' : 'lark-cli could not finish',
    hint: redact(reason, literals).slice(0, 240),
  }
}

/** The JSON envelope of a finished command: lark-cli prints success on stdout and error envelopes on stderr. */
export function jsonOf(result: Pick<RunResult, 'stdout' | 'stderr'>): unknown {
  return parseFirstJson(result.stdout) ?? parseFirstJson(result.stderr)
}

export class Runner {
  private readonly children = new Set<ChildProcess>()
  private disposed = false
  /** If the process exits while children are alive (app quit, crash of the caller), none may be left behind. */
  private readonly onExit = (): void => {
    for (const child of this.children) {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    }
  }

  constructor() { process.once('exit', this.onExit) }

  /** Run to completion. Never rejects: failures are reported in the result. */
  run(command: string, args: readonly string[], options: RunOptions): Promise<RunResult> {
    return this.start(command, args, options).done
  }

  /** Start a possibly long process and stream its lines. */
  start(command: string, args: readonly string[], options: LongRunOptions): LongRun {
    const max = options.maxOutputBytes ?? DEFAULT_MAX
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let aborted = false
    let child: ChildProcess | undefined
    let killTimer: NodeJS.Timeout | undefined

    const done = new Promise<RunResult>((resolve) => {
      const finish = (result: Partial<RunResult>): void => {
        resolve({ code: null, signal: null, stdout, stderr, timedOut, aborted, spawnError: null, ...result })
      }
      if (this.disposed) { finish({ spawnError: 'runner disposed' }); return }
      if (options.signal?.aborted === true) { aborted = true; finish({}); return }
      try {
        child = spawn(command, [...args], {
          cwd: options.cwd,
          env: childEnv(options.env),
          stdio: ['pipe', 'pipe', 'pipe'],
        })
      } catch (error) {
        finish({ spawnError: error instanceof Error ? error.message : String(error) })
        return
      }
      const proc = child
      this.children.add(proc)
      const lines = { stdout: '', stderr: '' }
      const feed = (stream: 'stdout' | 'stderr', chunk: Buffer): void => {
        const text = chunk.toString('utf8')
        if (stream === 'stdout') { if (stdout.length < max) stdout += text.slice(0, max - stdout.length) }
        else if (stderr.length < max) stderr += text.slice(0, max - stderr.length)
        if (options.onLine === undefined) return
        lines[stream] += text
        let index = lines[stream].indexOf('\n')
        while (index >= 0) {
          const line = lines[stream].slice(0, index).replace(/\r$/, '')
          lines[stream] = lines[stream].slice(index + 1)
          if (line.length > 0) options.onLine(line, stream)
          index = lines[stream].indexOf('\n')
        }
      }
      proc.stdout?.on('data', (chunk: Buffer) => { feed('stdout', chunk) })
      proc.stderr?.on('data', (chunk: Buffer) => { feed('stderr', chunk) })
      const terminate = (): void => {
        if (proc.exitCode !== null || proc.signalCode !== null) return
        proc.kill('SIGTERM')
        killTimer = setTimeout(() => { if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL') }, KILL_GRACE_MS)
        killTimer.unref()
      }
      const timer = setTimeout(() => { timedOut = true; terminate() }, options.timeoutMs)
      timer.unref()
      const onAbort = (): void => { aborted = true; terminate() }
      options.signal?.addEventListener('abort', onAbort, { once: true })
      proc.once('error', (error) => {
        clearTimeout(timer)
        if (killTimer !== undefined) clearTimeout(killTimer)
        options.signal?.removeEventListener('abort', onAbort)
        this.children.delete(proc)
        finish({ spawnError: error.message })
      })
      proc.once('close', (code, signal) => {
        clearTimeout(timer)
        if (killTimer !== undefined) clearTimeout(killTimer)
        options.signal?.removeEventListener('abort', onAbort)
        this.children.delete(proc)
        if (options.onLine !== undefined) {
          for (const stream of ['stdout', 'stderr'] as const) {
            const rest = lines[stream].replace(/\r$/, '')
            if (rest.length > 0) options.onLine(rest, stream)
          }
        }
        finish({ code, signal })
      })
      proc.stdin?.on('error', () => { /* the child may exit before reading stdin */ })
      if (options.stdin !== undefined) proc.stdin?.end(options.stdin)
      else proc.stdin?.end()
    })

    return {
      done,
      kill: () => {
        aborted = true
        if (child === undefined || child.exitCode !== null || child.signalCode !== null) return
        child.kill('SIGTERM')
        const proc = child
        setTimeout(() => { if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL') }, KILL_GRACE_MS).unref()
      },
    }
  }

  /** Number of live children (for tests and the leak assertions). */
  get active(): number { return this.children.size }

  /** Kill everything and refuse new work. */
  dispose(): void {
    this.disposed = true
    process.removeListener('exit', this.onExit)
    for (const child of this.children) {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    }
    this.children.clear()
  }
}
