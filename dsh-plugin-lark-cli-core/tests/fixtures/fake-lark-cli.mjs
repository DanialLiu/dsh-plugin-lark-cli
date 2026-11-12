#!/usr/bin/env node
/**
 * Fake lark-cli for tests. LARK_FAKE_SCRIPT points at a JSON file mapping the space-joined argv to
 * { stdout?, stderr?, code?, delayMs?, hang?, lines?: [{ text, delayMs }], writeFile?: [path, content] }.
 * "_default" answers anything unmapped. Every call is appended to LARK_FAKE_LOG (jsonl: argv, stdin, pid).
 */
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'

const argv = process.argv.slice(2)
const key = argv.join(' ')
const script = JSON.parse(readFileSync(process.env.LARK_FAKE_SCRIPT, 'utf8'))
const entry = script[key] ?? script._default ?? { stderr: `fake lark-cli: no script for "${key}"\n`, code: 2 }
const sleep = ms => new Promise(r => setTimeout(r, ms))

let stdin = ''
if (entry.readStdin === true) {
  process.stdin.setEncoding('utf8')
  for await (const chunk of process.stdin) stdin += chunk
}
if (process.env.LARK_FAKE_LOG) appendFileSync(process.env.LARK_FAKE_LOG, `${JSON.stringify({ argv, stdin, pid: process.pid })}\n`)

if (entry.delayMs) await sleep(entry.delayMs)
for (const line of entry.lines ?? []) {
  if (line.delayMs) await sleep(line.delayMs)
  process.stdout.write(`${line.text}\n`)
}
if (entry.writeFile) writeFileSync(entry.writeFile[0], entry.writeFile[1])
if (entry.stdout) process.stdout.write(entry.stdout)
if (entry.stderr) process.stderr.write(entry.stderr)
if (entry.hang) { setInterval(() => {}, 1000); await new Promise(() => {}) }
process.exit(entry.code ?? 0)
