// The plugin is built and type-checked inside a checkout of the DSH repository (the browser half uses its client-bundle
// preset and the type-checks resolve its sources). The checkout is named by DSH_ROOT; nothing else is assumed about
// where this package sits.
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

export function dshRoot() {
  const value = process.env.DSH_ROOT
  if (value === undefined || value === '') throw new Error('DSH_ROOT must point at a checkout of the DSH repository (with its dependencies installed)')
  const root = resolve(value)
  for (const marker of ['packages/client/tsdown.client.ts', 'node_modules/.bin/tsdown']) {
    if (!existsSync(resolve(root, marker))) throw new Error(`DSH_ROOT=${root} is not a built DSH checkout (missing ${marker})`)
  }
  return root
}
