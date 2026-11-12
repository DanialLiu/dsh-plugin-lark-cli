/**
 * Builds both halves into `lib/`:
 *  - `lib/index.js`  host half, one ESM file (bare imports such as `@deepseek-ai/*` stay external: they are peers);
 *  - `lib/client.js` browser half, with the DSH repository's own client-bundle preset so it has the exact module-loader
 *    format the shell expects (this half can only be built with a checkout of the DSH repository, named by DSH_ROOT).
 * The published package ships these built files; consumers never build anything.
 */
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'
import { dshRoot } from './scripts/dsh-root.mjs'

// The preset lives in the DSH checkout named by DSH_ROOT.
const { clientBundle } = await import(pathToFileURL(join(dshRoot(), 'packages/client/tsdown.client.ts')).href) as { clientBundle: (dir: string, external: string[]) => (context: any) => any }

const client = clientBundle(import.meta.dirname, ['lib/types/index.js'])

export default (context: Parameters<typeof client>[0]) => {
  const configs = client(context)
  const list = Array.isArray(configs) ? configs : [configs]
  return [
    {
      name: 'dsh-plugin-lark-cli-core/host',
      entry: { index: 'src/index.ts' },
      outDir: 'lib',
      format: 'esm' as const,
      platform: 'node' as const,
      target: 'node22',
      dts: false,
      sourcemap: false,
      clean: false,
      fixedExtension: false,
    },
    ...list.filter(config => typeof config.name === 'string' && config.name.endsWith('/client')),
  ]
}
