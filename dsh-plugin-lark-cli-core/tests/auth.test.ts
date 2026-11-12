import { describe, expect, it } from 'vitest'
import { BOUND_SCRIPT, finished, fixture, makeHarness, UNBOUND_SCRIPT, until } from './helpers.ts'

const LOGIN = 'https://accounts.feishu.cn/oauth/device?user_code=WXYZ-9876'
const base = {
  ...BOUND_SCRIPT,
  'auth login --no-wait --json': { stdout: JSON.stringify({ ok: true, verification_url: LOGIN, device_code: 'dc-secret-123', expires_in: 600 }) },
  [`auth qrcode ${LOGIN} --output qr.png`]: { writeFile: ['qr.png', 'QR'] as [string, string] },
}

describe('authorize the personal account', () => {
  it('needs confirmation and says it uses the default scope', async () => {
    const h = makeHarness(base)
    await h.core.getStatus()
    await expect(h.core.authorize(false)).rejects.toMatchObject({ name: 'ConfirmationRequired', details: { scope: 'lark-cli-default' } })
  })

  it('refuses when no app is bound', async () => {
    const h = makeHarness(UNBOUND_SCRIPT)
    await h.core.getStatus()
    await expect(h.core.authorize(true)).rejects.toMatchObject({ info: { code: 'not_bound' } })
  })

  it('refuses a verification link that is not http(s), so the page never opens javascript: or file: URLs', async () => {
    const h = makeHarness({ ...base, 'auth login --no-wait --json': { stdout: JSON.stringify({ ok: true, verification_url: 'javascript:alert(1)', device_code: 'dc-secret-123', expires_in: 600 }) } })
    await h.core.getStatus()
    await h.core.authorize(true)
    const job = await finished(h.core)
    expect(job.phase).toBe('failed')
    expect(job.handoff).toBeFalsy()
  })

  it('uses lark-cli\'s default scope: no --domain, --scope or --recommend', async () => {
    const h = makeHarness({ ...base, 'auth login --device-code dc-secret-123': { delayMs: 300 } })
    await h.core.getStatus()
    await h.core.authorize(true)
    await finished(h.core)
    const login = h.fake.calls().find(c => c.argv.includes('--no-wait'))
    expect(login?.argv).toEqual(['auth', 'login', '--no-wait', '--json'])
  })

  it('shows link + QR while waiting, then the account becomes authorized', async () => {
    const h = makeHarness({ ...base, 'auth login --device-code dc-secret-123': { delayMs: 800, lines: [{ text: 'waiting for authorization' }] } })
    await h.core.getStatus()
    await h.core.authorize(true)
    const waiting = await until(() => h.core.job(), j => j?.phase === 'waiting-user')
    expect(waiting?.handoff?.url).toBe(LOGIN)
    expect(waiting?.handoff?.qrPngBase64).toBe(Buffer.from('QR').toString('base64'))
    expect(waiting?.handoff?.expiresAt).not.toBeNull()
    h.fake.setScript({ ...base, 'auth status --json --verify': { stdout: fixture('auth-status-user-ok.json') }, 'auth status --json': { stdout: fixture('auth-status-user-ok.json') }, 'auth login --device-code dc-secret-123': { delayMs: 200 } })
    const job = await finished(h.core)
    expect(job.phase).toBe('succeeded')
    const status = await until(() => h.core.getStatus(), s => s.user.status === 'authorized')
    expect(status.user.userName).toBe('测试用户')
    expect(status.state).toBe('ready')
    expect(JSON.stringify(job)).not.toContain('dc-secret-123')
  })

  it('cancel stops the wait', async () => {
    const h = makeHarness({ ...base, 'auth login --device-code dc-secret-123': { hang: true } })
    await h.core.getStatus()
    await h.core.authorize(true)
    await until(() => h.core.job(), j => j?.phase === 'waiting-user')
    expect((await h.core.cancel()).phase).toBe('cancelled')
    expect(h.deps.runner.active).toBe(0)
  })

  it('expired or refused authorization is a failure with a retry', async () => {
    const h = makeHarness({ ...base, 'auth login --device-code dc-secret-123': { stderr: 'authorization expired\n', code: 1 } })
    await h.core.getStatus()
    await h.core.authorize(true)
    const job = await finished(h.core)
    expect(job.phase).toBe('failed')
    expect(job.failure?.code).toBe('cli_failed')
  })
})

describe('authorization that lark-cli saved but reported as restricted', () => {
  it('counts as success when the personal identity is ready afterwards', async () => {
    const h = makeHarness({
      ...base,
      'auth login --device-code dc-secret-123': { stderr: '[Restricted] organization admin restricted these permissions: vc:meeting.realtime:read\n', code: 1 },
      'auth status': { stdout: '{"identities":{"user":{"status":"ready"}}}' },
    })
    await h.core.getStatus()
    await h.core.authorize(true)
    expect((await finished(h.core)).phase).toBe('succeeded')
  })
})

describe('sign out', () => {
  it('clears only the local sign-in; the binding stays', async () => {
    const h = makeHarness({ ...BOUND_SCRIPT, 'auth status --json --verify': { stdout: fixture('auth-status-user-ok.json') }, 'auth logout --json': { stdout: '{"ok":true,"loggedOut":true}' } })
    expect((await h.core.getStatus()).user.status).toBe('authorized')
    h.fake.setScript({ ...BOUND_SCRIPT, 'auth logout --json': { stdout: '{"ok":true,"loggedOut":true}' } })
    const status = await h.core.logout()
    expect(status.user.status).toBe('unauthorized')
    expect(status.binding?.appId).toBe('cli_test0000000000')
    expect(h.fake.calls().map(c => c.argv.join(' '))).toContain('auth logout --json')
  })
})
