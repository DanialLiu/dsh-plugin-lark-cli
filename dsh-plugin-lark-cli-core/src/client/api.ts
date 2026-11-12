/** Thin client for the host routes. The desktop shell forwards `/api/*` to the host with its own credentials. */
import type { ErrorInfo, IntegrationStatus, Job } from '../types.ts'

const BASE = '/api/lark-cli'

export interface ApiResult<T> {
  ok: boolean
  status: number
  data: T | null
  error: ErrorInfo | null
  /** `details` of a confirmation_required answer. */
  details: Record<string, unknown> | null
}

async function call<T>(method: 'GET' | 'POST', path: string, body?: Record<string, unknown>): Promise<ApiResult<T>> {
  try {
    const init: RequestInit = { method, cache: 'no-store' }
    if (method === 'POST') {
      init.headers = { 'content-type': 'application/json' }
      init.body = JSON.stringify(body ?? {})
    }
    const response = await fetch(`${BASE}${path}`, init)
    const json = await response.json().catch(() => null) as Record<string, unknown> | null
    if (response.ok) return { ok: true, status: response.status, data: json as T, error: null, details: null }
    const error = (json?.error ?? null) as ErrorInfo | null
    return {
      ok: false, status: response.status, data: null,
      error: error ?? { code: 'internal', message: `HTTP ${response.status}` },
      details: (json?.details ?? null) as Record<string, unknown> | null,
    }
  } catch (cause) {
    return { ok: false, status: 0, data: null, error: { code: 'internal', message: cause instanceof Error ? cause.message : 'network error' }, details: null }
  }
}

export const larkApi = {
  status: () => call<IntegrationStatus>('GET', '/status'),
  refresh: (checkUpdate: boolean) => call<IntegrationStatus>('POST', '/status/refresh', { checkUpdate }),
  install: (confirm: boolean) => call<{ job: Job }>('POST', '/install', { confirm }),
  update: (confirm: boolean) => call<{ job: Job }>('POST', '/update', { confirm }),
  bind: (body: Record<string, unknown>) => call<{ job: Job }>('POST', '/bind', body),
  authorize: (confirm: boolean) => call<{ job: Job }>('POST', '/authorize', { confirm }),
  uninstall: (purge: boolean) => call<IntegrationStatus>('POST', '/uninstall', { confirm: true, purge }),
  logout: () => call<IntegrationStatus>('POST', '/logout', {}),
  syncSkills: () => call<{ job: Job }>('POST', '/skills/sync', {}),
  cancel: () => call<{ job: Job }>('POST', '/job/cancel', {}),
}
