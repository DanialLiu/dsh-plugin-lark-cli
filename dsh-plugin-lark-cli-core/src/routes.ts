/** HTTP surface. Parsing and error mapping only; behaviour lives in core.ts. */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { LarkCore } from './core.ts'
import { ApiError, ConfirmationRequired, JobFailure, type ErrorCode } from './types.ts'

export const ROUTE_PREFIX = '/api/lark-cli'

const STATUS: Partial<Record<ErrorCode, number>> = {
  job_in_progress: 409, not_installed: 409, already_installed: 409, not_bound: 409, no_update: 409, not_writable: 409,
  confirmation_required: 400, invalid_input: 400, bad_request: 400, cli_failed: 502, network_unreachable: 502, timeout: 504, no_job: 404,
}

function send(res: ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > 64 * 1024) throw new ApiError({ code: 'bad_request', message: 'request body too large' })
    chunks.push(chunk as Buffer)
  }
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (text.length === 0) return {}
  try {
    const parsed: unknown = JSON.parse(text)
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) return parsed as Record<string, unknown>
  } catch { /* fall through */ }
  throw new ApiError({ code: 'bad_request', message: 'body must be a JSON object' })
}

/**
 * Browser-trust fence: answers 401/403 for a request that a malicious web page (cross-site request, DNS rebinding) rather
 * than the app's own page could have sent, or undefined to let it through. The host's `connection` service provides it.
 */
export type RequestFence = (request: { readonly headers: IncomingMessage['headers'] }) => 401 | 403 | undefined

/** Build the request handler for the whole prefix; every route, reads included, sits behind the fence. */
export function createHandler(core: LarkCore, onError: (message: string) => void = () => {}, fence: RequestFence = () => undefined): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    const rejection = fence(req)
    if (rejection !== undefined) return send(res, rejection, { error: { code: 'bad_request', message: 'request refused' } })
    const method = req.method ?? 'GET'
    const path = ((req.url ?? '/').split('?')[0] ?? '').slice(ROUTE_PREFIX.length).replace(/\/+$/, '') || '/'
    try {
      if (method === 'GET' && path === '/status') return send(res, 200, await core.getStatus())
      if (method === 'GET' && path === '/job') return send(res, 200, { job: core.job() })
      if (method !== 'POST') return send(res, 404, { error: { code: 'bad_request', message: `unknown route ${method} ${path}` } })
      const body = await readJson(req)
      switch (path) {
        case '/status/refresh': return send(res, 200, await core.refresh(body.checkUpdate === true))
        case '/install': return send(res, 200, { job: await core.install(body.confirm) })
        case '/update': return send(res, 200, { job: await core.update(body.confirm) })
        case '/bind': return send(res, 200, { job: await core.bind(body) })
        case '/authorize': return send(res, 200, { job: await core.authorize(body.confirm) })
        case '/skills/sync': return send(res, 200, { job: await core.syncSkills() })
        case '/uninstall': return send(res, 200, await core.uninstall(body))
        case '/logout': return send(res, 200, await core.logout())
        case '/job/cancel': return send(res, 200, { job: await core.cancel() })
        default: return send(res, 404, { error: { code: 'bad_request', message: `unknown route ${method} ${path}` } })
      }
    } catch (error) {
      if (error instanceof ConfirmationRequired) {
        return send(res, 400, { error: { code: 'confirmation_required', message: error.message }, details: error.details })
      }
      if (error instanceof ApiError) {
        return send(res, STATUS[error.info.code] ?? 400, { error: error.info, ...error.extra })
      }
      if (error instanceof JobFailure) {
        return send(res, STATUS[error.info.code] ?? 502, { error: error.info })
      }
      const message = error instanceof Error ? error.message : String(error)
      onError(message)
      return send(res, 500, { error: { code: 'internal', message: 'unexpected error' } })
    }
  }
}
