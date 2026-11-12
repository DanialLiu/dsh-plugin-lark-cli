// Type-check both halves against the sources of the DSH checkout named by DSH_ROOT. Generates throw-away tsconfig files
// from the *.template.json files (DSH_ROOT is substituted) and reports only diagnostics located in this package.
import { spawnSync } from 'node:child_process'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dshRoot } from './dsh-root.mjs'

const pkg = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const root = dshRoot()
const posix = (path) => path.split(sep).join('/')
const rel = relative(pkg, root) || '.'
const common = (() => {
  const a = pkg.split(sep), b = root.split(sep)
  let i = 0
  while (i < a.length && i < b.length && a[i] === b[i]) i += 1
  return a.slice(0, i).join(sep) || sep
})()
let failed = false
for (const name of ['host', 'client']) {
  const out = join(pkg, `tsconfig.${name}.generated.json`)
  const text = readFileSync(join(pkg, `tsconfig.${name}.template.json`), 'utf8')
    .replaceAll('<DSH_ROOT>', posix(rel)).replaceAll('<COMMON_ROOT>', posix(relative(pkg, common) || '.'))
  writeFileSync(out, text)
  try {
    const result = spawnSync(join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'tsc.cmd' : 'tsc'), ['-p', out, '--pretty', 'false'], { cwd: pkg, encoding: 'utf8', shell: process.platform === 'win32' })
    const mine = `${result.stdout}${result.stderr}`.split('\n').filter(line => /^(?:src|tests)\//.test(line))
    if (mine.length > 0) { failed = true; console.error(`${name}:\n${mine.join('\n')}`) } else console.log(`${name}: no diagnostics in this package`)
  } finally { rmSync(out, { force: true }) }
}
process.exit(failed ? 1 : 0)
