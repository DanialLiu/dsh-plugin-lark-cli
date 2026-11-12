import { describe, expect, it } from 'vitest'
import { parseFirstJson, redact, Runner } from '../src/runner.ts'
import { alive, fixture, makeFake, sleep } from './helpers.ts'

describe('redact', () => {
  it('masks secret-looking values in JSON and key=value text', () => {
    const out = redact('{"appSecret":"abc123xyz","token":"t-1","tokenStatus":"missing","x":1}\nclient_secret=zzz999 device_code=dc-777')
    expect(out).not.toContain('abc123xyz')
    expect(out).not.toContain('t-1')
    expect(out).not.toContain('zzz999')
    expect(out).not.toContain('dc-777')
    expect(out).toContain('"tokenStatus":"missing"')
  })
  it('masks literal secrets the user typed', () => {
    expect(redact('failed for secret S3cr3tValue here', ['S3cr3tValue'])).toBe('failed for secret *** here')
  })
  it('leaves verification urls untouched', () => {
    const url = 'https://open.feishu.cn/page/cli?user_code=ABCD-1234&lang=zh'
    expect(redact(`open ${url}`)).toBe(`open ${url}`)
  })
})

describe('parseFirstJson', () => {
  it('reads the object and ignores the trailer lark-cli prints after config show', () => {
    const parsed = parseFirstJson(fixture('config-show-bound.txt')) as { appId: string }
    expect(parsed.appId).toBe('cli_test0000000000')
  })
  it('returns undefined without an object', () => { expect(parseFirstJson('nothing here')).toBeUndefined() })
  it('handles braces inside strings', () => {
    expect((parseFirstJson('x {"a":"}{","b":2} y') as { b: number }).b).toBe(2)
  })
})

describe('Runner', () => {
  it('captures output and exit code', async () => {
    const fake = makeFake({ '--version': { stdout: 'lark-cli version 1.0.99\n' } })
    const runner = new Runner()
    const result = await runner.run(fake.bin, ['--version'], { timeoutMs: 5000, env: fake.env })
    expect(result.code).toBe(0)
    expect(result.stdout).toContain('1.0.99')
    expect(runner.active).toBe(0)
  })
  it('passes stdin without putting it in argv', async () => {
    const fake = makeFake({ 'config init': { readStdin: true } })
    const result = await new Runner().run(fake.bin, ['config', 'init'], { timeoutMs: 5000, env: fake.env, stdin: 'SECRET-VALUE' })
    expect(result.code).toBe(0)
    const call = fake.calls()[0]
    expect(call.stdin).toBe('SECRET-VALUE')
    expect(call.argv.join(' ')).not.toContain('SECRET-VALUE')
  })
  it('kills on timeout and reports it', async () => {
    const fake = makeFake({ _default: { hang: true } })
    const runner = new Runner()
    const result = await runner.run(fake.bin, ['x'], { timeoutMs: 4000, env: fake.env })
    expect(result.timedOut).toBe(true)
    expect(runner.active).toBe(0)
    await sleep(100)
    const calls = fake.calls()
    expect(calls.length).toBeGreaterThan(0)
    expect(alive(calls[0].pid)).toBe(false)
  })
  it('kills on abort', async () => {
    const fake = makeFake({ _default: { hang: true } })
    const controller = new AbortController()
    const runner = new Runner()
    const pending = runner.run(fake.bin, ['x'], { timeoutMs: 10_000, env: fake.env, signal: controller.signal })
    for (let i = 0; i < 50 && fake.calls().length === 0; i += 1) await sleep(100)
    controller.abort()
    const result = await pending
    expect(result.aborted).toBe(true)
    expect(runner.active).toBe(0)
  })
  it('streams lines', async () => {
    const fake = makeFake({ _default: { lines: [{ text: 'one' }, { text: 'two' }] } })
    const seen: string[] = []
    const run = new Runner().start(fake.bin, ['x'], { timeoutMs: 5000, env: fake.env, onLine: line => seen.push(line) })
    await run.done
    expect(seen).toEqual(['one', 'two'])
  })
  it('caps captured output', async () => {
    const big = 'a'.repeat(5000)
    const fake = makeFake({ _default: { stdout: big } })
    const result = await new Runner().run(fake.bin, ['x'], { timeoutMs: 5000, env: fake.env, maxOutputBytes: 1000 })
    expect(result.stdout.length).toBe(1000)
  })
  it('reports spawn errors instead of throwing', async () => {
    const result = await new Runner().run('/nonexistent/lark-cli', [], { timeoutMs: 1000 })
    expect(result.spawnError).not.toBeNull()
  })
  it('dispose kills live children', async () => {
    const fake = makeFake({ _default: { hang: true } })
    const runner = new Runner()
    const pending = runner.run(fake.bin, ['x'], { timeoutMs: 10_000, env: fake.env })
    for (let i = 0; i < 50 && fake.calls().length === 0; i += 1) await sleep(100)
    runner.dispose()
    await pending
    await sleep(100)
    expect(alive(fake.calls()[0].pid)).toBe(false)
  })
})

describe('no orphans', () => {
  it('children are killed when the process exits without anyone disposing the runner', async () => {
    const { spawnSync } = await import('node:child_process')
    const { fileURLToPath } = await import('node:url')
    const script = fileURLToPath(new URL('./fixtures/leak-check.mjs', import.meta.url))
    const before = spawnSync('pgrep', ['-f', "setInterval\\(\\(\\)=>\\{\\},1000\\)"], { encoding: 'utf8' }).stdout.split('\n').filter(Boolean).length
    const run = spawnSync(process.execPath, [script], { encoding: 'utf8', timeout: 20_000 })
    expect(run.stdout).toContain('CHILD_COUNT 1')
    await sleep(300)
    const after = spawnSync('pgrep', ['-f', "setInterval\\(\\(\\)=>\\{\\},1000\\)"], { encoding: 'utf8' }).stdout.split('\n').filter(Boolean).length
    expect(after).toBe(before)
  })
})
