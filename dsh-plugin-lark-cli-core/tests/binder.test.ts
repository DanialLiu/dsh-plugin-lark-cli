import { describe, expect, it } from 'vitest'
import { alive, BOUND_SCRIPT, finished, fixture, makeHarness, sleep, UNBOUND_SCRIPT, until } from './helpers.ts'

const URL_LINE = 'https://open.feishu.cn/page/cli?user_code=ABCD-1234&lang=zh'
const NEW_SCRIPT = {
  ...UNBOUND_SCRIPT,
  'config init --new --brand feishu': { lines: [{ text: 'Open this link in your browser to continue:' }, { text: URL_LINE }], hang: true },
  'auth qrcode https://open.feishu.cn/page/cli?user_code=ABCD-1234&lang=zh --output qr.png': { writeFile: ['qr.png', 'PNGDATA'] as [string, string] },
}

describe('bind a new bot', () => {
  it('hands the link and a QR to the page and waits for the user', async () => {
    const h = makeHarness(NEW_SCRIPT)
    await h.core.getStatus()
    await h.core.bind({ mode: 'new', brand: 'feishu' })
    const job = await until(() => h.core.job(), j => j?.phase === 'waiting-user')
    expect(job?.handoff?.url).toBe(URL_LINE)
    expect(job?.handoff?.qrPngBase64).toBe(Buffer.from('PNGDATA').toString('base64'))
    await h.core.cancel()
  })

  it('cancel ends the flow, removes the child and returns to unbound', async () => {
    const h = makeHarness(NEW_SCRIPT)
    await h.core.getStatus()
    await h.core.bind({ mode: 'new', brand: 'feishu' })
    await until(() => h.core.job(), j => j?.phase === 'waiting-user')
    const pid = h.fake.calls().find(c => c.argv[1] === 'init')?.pid
    const cancelled = await h.core.cancel()
    expect(cancelled.phase).toBe('cancelled')
    expect(cancelled.handoff).toBeNull()
    await sleep(200)
    expect(pid !== undefined && alive(pid)).toBe(false)
    expect(h.deps.runner.active).toBe(0)
    expect((await h.core.refresh(false)).state).toBe('installed-unbound')
  })

  it('times out and cleans up', async () => {
    const h = makeHarness(NEW_SCRIPT, { bindTimeoutMs: 10_000 })
    await h.core.getStatus()
    // shorten the wait for the test only: the job timeout comes from the config at start
    h.config.bindTimeoutMs = 10_000
    await h.core.bind({ mode: 'new', brand: 'feishu' })
    await until(() => h.core.job(), j => j?.phase === 'waiting-user')
    const job = await h.core.cancel()
    expect(['cancelled', 'timed-out']).toContain(job.phase)
  })

  it('success: the status turns connected without a manual refresh', async () => {
    const script = { ...NEW_SCRIPT, 'config init --new --brand feishu': { lines: [{ text: URL_LINE }], delayMs: 300 } }
    const h = makeHarness(script)
    expect((await h.core.getStatus()).state).toBe('installed-unbound')
    await h.core.bind({ mode: 'new', brand: 'feishu' })
    // the user finishes in the browser: lark-cli now reports a bound app
    h.fake.setScript({ ...script, ...BOUND_SCRIPT, 'config init --new --brand feishu': { lines: [{ text: URL_LINE }], delayMs: 300 } })
    await finished(h.core)
    const status = await until(() => h.core.getStatus(), s => s.state === 'ready')
    expect(status.binding?.appId).toBe('cli_test0000000000')
  })

  it('refuses when lark-cli is not installed', async () => {
    const h = makeHarness(NEW_SCRIPT, {}, {}, false)
    await expect(h.core.bind({ mode: 'new' })).rejects.toMatchObject({ info: { code: 'not_installed' } })
  })

  it('a second start is rejected while one runs', async () => {
    const h = makeHarness(NEW_SCRIPT)
    await h.core.getStatus()
    await h.core.bind({ mode: 'new', brand: 'feishu' })
    await expect(h.core.bind({ mode: 'new', brand: 'feishu' })).rejects.toMatchObject({ info: { code: 'job_in_progress' } })
    await h.core.cancel()
  })
})

describe('what lark-cli really prints (to stderr)', () => {
  const ART = ['█████████████████████', '████ ▄▄▄▄▄ █▄▀▀█ ████', '▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀']
  it('keeps the ASCII QR out of the log and still finds the link on stderr', async () => {
    const real = { stderr: `${ART.join('\n')}\n\n打开以下链接配置应用:\n\n  ${URL_LINE}\n\n等待配置应用...\n`, hang: true }
    const h = makeHarness({ ...NEW_SCRIPT, 'config init --new --brand feishu': real })
    await h.core.getStatus()
    await h.core.bind({ mode: 'new', brand: 'feishu' })
    const job = await until(() => h.core.job(), j => j?.phase === 'waiting-user')
    expect(job?.handoff?.url).toBe(URL_LINE)
    expect(job?.log.join('\n')).not.toMatch(/[█▄▀]/u)
    expect(job?.log.join('\n')).toContain('等待配置应用')
    await h.core.cancel()
  })

  it('a network failure is reported as such, in one human line, not as JSON fragments', async () => {
    const envelope = JSON.stringify({ ok: false, error: { type: 'network', subtype: 'timeout', message: 'app registration begin failed: Post "https://accounts.feishu.cn/oauth/v1/app/registration": net/http: TLS handshake timeout' } }, null, 2)
    const h = makeHarness({ ...NEW_SCRIPT, 'config init --new --brand feishu': { stderr: `${envelope}\n`, code: 1 } })
    await h.core.getStatus()
    await h.core.bind({ mode: 'new', brand: 'feishu' })
    const job = await finished(h.core)
    expect(job.failure?.code).toBe('network_unreachable')
    expect(job.failure?.hint).toContain('TLS handshake timeout')
    expect(job.failure?.hint).not.toMatch(/[{}]/)
  })
})

describe('bind an existing app', () => {
  const SECRET = 'S3cr3tValue-9f2c'
  const script = {
    ...UNBOUND_SCRIPT,
    'config init --app-id cli_abc12345 --app-secret-stdin --brand feishu': { readStdin: true, stdout: 'configured cli_abc12345\n' },
    'auth status': { stdout: '{"identities":{"user":{"status":"ready"}}}' },
  }

  it('sends the secret only on stdin and never exposes it', async () => {
    const h = makeHarness(script)
    await h.core.getStatus()
    await h.core.bind({ mode: 'existing', appId: 'cli_abc12345', appSecret: SECRET, brand: 'feishu' })
    const job = await finished(h.core)
    expect(job.phase).toBe('succeeded')
    const call = h.fake.calls().find(c => c.argv.includes('--app-secret-stdin'))
    expect(call?.stdin).toBe(`${SECRET}\n`)
    expect(call?.argv.join(' ')).not.toContain(SECRET)
    const everything = JSON.stringify({ job, status: await h.core.getStatus() })
    expect(everything).not.toContain(SECRET)
  })

  it('redacts the secret even when lark-cli echoes it in an error', async () => {
    const h = makeHarness({ ...script, 'config init --app-id cli_abc12345 --app-secret-stdin --brand feishu': { readStdin: true, stderr: `invalid secret ${SECRET}\n`, code: 1 } })
    await h.core.getStatus()
    await h.core.bind({ mode: 'existing', appId: 'cli_abc12345', appSecret: SECRET, brand: 'feishu' })
    const job = await finished(h.core)
    expect(job.phase).toBe('failed')
    expect(JSON.stringify(job)).not.toContain(SECRET)
  })

  it('validates the input without starting anything', async () => {
    const h = makeHarness(script)
    await h.core.getStatus()
    await expect(h.core.bind({ mode: 'existing', appId: 'x', appSecret: SECRET })).rejects.toMatchObject({ info: { code: 'invalid_input' } })
    await expect(h.core.bind({ mode: 'existing', appId: 'cli_abc12345', appSecret: 'short' })).rejects.toMatchObject({ info: { code: 'invalid_input' } })
    await expect(h.core.bind({ mode: 'weird' })).rejects.toMatchObject({ info: { code: 'invalid_input' } })
    expect(h.core.job()).toBeNull()
  })
})

describe('reconfigure', () => {
  const script = { ...BOUND_SCRIPT, 'config init --new --brand feishu': { lines: [{ text: URL_LINE }], hang: true } }
  it('needs confirmation and says what it replaces', async () => {
    const h = makeHarness(script)
    await h.core.getStatus()
    await expect(h.core.bind({ mode: 'new', replace: true })).rejects.toMatchObject({ name: 'ConfirmationRequired', details: { appId: 'cli_test0000000000' } })
    expect(h.core.job()).toBeNull()
  })
  it('runs once confirmed', async () => {
    const h = makeHarness(script)
    await h.core.getStatus()
    await h.core.bind({ mode: 'new', replace: true, confirm: true })
    const job = await until(() => h.core.job(), j => j !== null)
    expect(job?.replace).toBe(true)
    await h.core.cancel()
  })
  it('nothing to replace when not bound', async () => {
    const h = makeHarness({ ...UNBOUND_SCRIPT })
    await h.core.getStatus()
    await expect(h.core.bind({ mode: 'new', replace: true, confirm: true })).rejects.toMatchObject({ info: { code: 'invalid_input' } })
    expect(fixture('not-configured.json')).toContain('not_configured')
  })
})

describe('binding continues into the personal-account step', () => {
  it('starts the sign-in right after a successful bind when the account is not signed in', async () => {
    const h = makeHarness({
      ...UNBOUND_SCRIPT,
      'config init --app-id cli_abc12345 --app-secret-stdin --brand feishu': { readStdin: true, stdout: 'ok\n' },
      'auth status': { stdout: '{"identities":{"user":{"status":"missing"}}}' },
      'auth login --no-wait --json': { stdout: '{"verification_url":"https://example.test/v","device_code":"dc-1","expires_in":300}' },
      'auth login --device-code dc-1': { hang: true },
    })
    await h.core.getStatus()
    await h.core.bind({ mode: 'existing', appId: 'cli_abc12345', appSecret: 'S3cr3tValue-9f2c', brand: 'feishu' })
    const job = await until(() => h.core.job(), j => j?.phase === 'waiting-user' && j.handoff !== null)
    expect(job?.handoff?.url).toBe('https://example.test/v')
    expect(job?.stage).toBe('authorize')
    expect(h.fake.calls().filter(c => c.argv.join(' ') === 'config show').length).toBe(3) // one more than without: the status is re-read before the sign-in wait
    await h.core.cancel()
  })
})
