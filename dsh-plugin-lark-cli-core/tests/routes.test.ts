import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { createHandler, ROUTE_PREFIX, type RequestFence } from '../src/routes.ts'
import { BOUND_SCRIPT, makeHarness, UNBOUND_SCRIPT, until, type Harness } from './helpers.ts'

let server: Server | undefined
afterEach(async () => { await new Promise<void>(resolve => server?.close(() => { resolve() })); server = undefined })

async function serve(h: Harness, fence?: RequestFence): Promise<string> {
  const handler = createHandler(h.core, undefined, fence)
  server = createServer((req, res) => { void handler(req, res) })
  await new Promise<void>(resolve => server?.listen(0, '127.0.0.1', resolve))
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}${ROUTE_PREFIX}`
}

const post = (url: string, body: unknown) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

describe('HTTP contract', () => {
  it('GET /status returns the snapshot', async () => {
    const base = await serve(makeHarness(BOUND_SCRIPT))
    const res = await fetch(`${base}/status`)
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    const body = await res.json() as { state: string, binding: { appId: string } }
    expect(body.state).toBe('ready')
    expect(body.binding.appId).toBe('cli_test0000000000')
  })

  it('install without confirm → 400 confirmation_required with what will happen', async () => {
    const h = makeHarness(UNBOUND_SCRIPT, {}, {}, false)
    const base = await serve(h)
    const res = await post(`${base}/install`, {})
    expect(res.status).toBe(400)
    const body = await res.json() as { error: { code: string }, details: { package: string, target: string } }
    expect(body.error.code).toBe('confirmation_required')
    expect(body.details).toMatchObject({ package: '@larksuite/cli', target: h.prefix })
  })

  it('maps typed errors to their status codes', async () => {
    const h = makeHarness(UNBOUND_SCRIPT, {}, {}, false)
    const base = await serve(h)
    expect((await post(`${base}/bind`, { mode: 'new' })).status).toBe(409) // not_installed
    expect((await post(`${base}/job/cancel`, {})).status).toBe(404) // no_job
  })

  it('job_in_progress comes back as 409 with the current job', async () => {
    const h = makeHarness({ ...UNBOUND_SCRIPT, 'config init --new --brand feishu': { hang: true } })
    const base = await serve(h)
    await h.core.getStatus()
    expect((await post(`${base}/bind`, { mode: 'new', brand: 'feishu' })).status).toBe(200)
    const res = await post(`${base}/bind`, { mode: 'new', brand: 'feishu' })
    expect(res.status).toBe(409)
    expect(((await res.json()) as { job: { kind: string } }).job.kind).toBe('bind-new')
    await h.core.cancel()
  })

  it('rejects bad bodies and unknown routes', async () => {
    const base = await serve(makeHarness(BOUND_SCRIPT))
    expect((await fetch(`${base}/status/refresh`, { method: 'POST', body: '{not json' })).status).toBe(400)
    expect((await fetch(`${base}/nope`)).status).toBe(404)
    expect((await post(`${base}/nope`, {})).status).toBe(404)
  })

  it('never echoes a submitted app secret in any response', async () => {
    const secret = 'S3cr3tValue-9f2c'
    const h = makeHarness({ ...UNBOUND_SCRIPT, 'config init --app-id cli_abc12345 --app-secret-stdin --brand feishu': { readStdin: true, stderr: `bad ${secret}\n`, code: 1 } })
    const base = await serve(h)
    await h.core.getStatus()
    const started = await post(`${base}/bind`, { mode: 'existing', appId: 'cli_abc12345', appSecret: secret, brand: 'feishu' })
    expect(JSON.stringify(await started.json())).not.toContain(secret)
    await until(() => h.core.job(), j => j !== null && j.phase !== 'running')
    for (const path of ['/job', '/status']) expect(await (await fetch(`${base}${path}`)).text()).not.toContain(secret)
  })

  it('refresh with checkUpdate re-runs the update check', async () => {
    const h = makeHarness(BOUND_SCRIPT)
    const base = await serve(h)
    expect((await post(`${base}/status/refresh`, { checkUpdate: true })).status).toBe(200)
    await until(() => h.fake.calls().filter(c => c.argv[0] === 'update').length, n => n >= 1)
  })

  it('the browser-trust fence guards every route, reads and writes, before any work happens', async () => {
    const h = makeHarness(BOUND_SCRIPT)
    const base = await serve(h, request => (request.headers.origin === 'https://evil.example' ? 403 : undefined))
    const evil = { origin: 'https://evil.example' }
    expect((await fetch(`${base}/status`, { headers: evil })).status).toBe(403)
    expect((await fetch(`${base}/job`, { headers: evil })).status).toBe(403)
    const callsBefore = h.fake.calls().length
    expect((await fetch(`${base}/logout`, { method: 'POST', headers: { ...evil, 'content-type': 'text/plain' }, body: '{}' })).status).toBe(403)
    expect((await fetch(`${base}/bind`, { method: 'POST', headers: evil, body: JSON.stringify({ mode: 'existing', appId: 'cli_abc12345', appSecret: 'whatever-secret' }) })).status).toBe(403)
    expect(h.fake.calls().length).toBe(callsBefore)
    expect((await fetch(`${base}/status`)).status).toBe(200)
  })
})
