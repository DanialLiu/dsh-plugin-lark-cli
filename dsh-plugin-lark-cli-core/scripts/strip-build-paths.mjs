// Post-build step: the client bundler leaves `//#region` comments that carry the absolute path of the build machine
// (user name, checkout location). Replace the package directory with `.` and fail if any other absolute path remains,
// so a published tarball never reveals where it was built.
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const lib = join(root, 'lib')
const prefixes = [root, root.replaceAll('\\', '/')]
const ABSOLUTE = /(?:\/Users\/|\/home\/|[A-Za-z]:[\\/]Users[\\/])[^\s"'`\\]+/

for (const name of readdirSync(lib)) {
  if (!/\.(?:js|map)$/.test(name)) continue
  const file = join(lib, name)
  let text = readFileSync(file, 'utf8')
  for (const prefix of prefixes) text = text.split(prefix).join('.')
  const left = ABSOLUTE.exec(text)
  if (left !== null) throw new Error(`lib/${name} still contains a build-machine path: ${left[0]}`)
  writeFileSync(file, text)
}
