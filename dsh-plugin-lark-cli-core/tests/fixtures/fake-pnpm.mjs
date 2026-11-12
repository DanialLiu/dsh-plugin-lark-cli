#!/usr/bin/env node
/**
 * Fake `pnpm add --dir <dir> @larksuite/cli@<v>`: lays out node_modules/@larksuite/cli/bin/lark-cli as a wrapper
 * around the fake lark-cli. FAKE_PNPM_MODE: ok | network | broken | hang. FAKE_PNPM_VERSION sets the version
 * the wrapper reports (the fake CLI script decides the actual output).
 */
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const argv = process.argv.slice(2)
const dir = argv[argv.indexOf('--dir') + 1]
const mode = process.env.FAKE_PNPM_MODE ?? 'ok'
console.log(`fake pnpm: ${argv.join(' ')}`)
if (mode === 'hang') { setInterval(() => {}, 1000); await new Promise(() => {}) }
if (mode === 'network') { console.error('ERR_PNPM_FETCH_FAIL getaddrinfo ENOTFOUND registry.npmjs.org'); process.exit(1) }
const bin = join(dir, 'node_modules', '@larksuite', 'cli', 'bin')
mkdirSync(bin, { recursive: true })
const target = join(bin, 'lark-cli')
if (mode === 'broken') writeFileSync(target, '#!/bin/sh\nexit 3\n')
else writeFileSync(target, `#!/bin/sh\n# tag=${process.env.FAKE_TAG ?? ''}\nexec "${process.env.FAKE_NODE}" "${process.env.FAKE_CLI}" "$@"\n`)
chmodSync(target, 0o755)
console.log('fake pnpm: done')
