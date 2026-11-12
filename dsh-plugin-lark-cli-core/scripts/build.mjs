// Build lib/index.js (host half) and lib/client.js (browser half) with the DSH checkout named by DSH_ROOT, then strip
// build-machine paths from the output.
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dshRoot } from './dsh-root.mjs'

const pkg = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const root = dshRoot()
const run = (command, args, env = {}) => {
  const result = spawnSync(command, args, { cwd: pkg, stdio: 'inherit', env: { ...process.env, ...env }, shell: process.platform === 'win32' })
  if (result.status !== 0) process.exit(result.status ?? 1)
}
run(join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'tsdown.cmd' : 'tsdown'), ['--config', 'tsdown.config.ts'], { DSH_ROOT: root })
run(process.execPath, [join(pkg, 'scripts', 'strip-build-paths.mjs')])
