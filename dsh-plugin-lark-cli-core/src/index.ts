/**
 * Feishu (lark-cli) connector for dsh, host half. Detects lark-cli, installs/updates/binds it from the Plugins page and exposes the
 * state to the browser half under `/api/lark-cli`. Everything Feishu-specific is delegated to lark-cli.
 */
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { defaultAgentsHome, defaultDshHome, AGENTS_HOME_ENV, DSH_HOME_ENV } from '@deepseek-ai/dsh-home-paths'
import Schema from '@deepseek-ai/schemastery'
import { CONFIG_DEFAULTS, type LarkConfig } from './config-defaults.ts'
import { LarkCore } from './core.ts'
import type { Deps } from './deps.ts'
import { Runner } from './runner.ts'
import { createHandler, ROUTE_PREFIX, type RequestFence } from './routes.ts'

export const name = 'lark-cli'
export const inject = ['webServer', 'connection']

export type Config = LarkConfig

export const Config: Schema<Config> = Schema.object({
  cliPath: Schema.string().default(CONFIG_DEFAULTS.cliPath),
  installPrefix: Schema.string().default(CONFIG_DEFAULTS.installPrefix),
  registry: Schema.string().default(CONFIG_DEFAULTS.registry),
  statusTimeoutMs: Schema.number().min(500).max(120_000).step(1).default(CONFIG_DEFAULTS.statusTimeoutMs),
  updateCheckTtlMs: Schema.number().min(0).max(86_400_000).step(1).default(CONFIG_DEFAULTS.updateCheckTtlMs),
  installTimeoutMs: Schema.number().min(10_000).max(3_600_000).step(1).default(CONFIG_DEFAULTS.installTimeoutMs),
  bindTimeoutMs: Schema.number().min(10_000).max(3_600_000).step(1).default(CONFIG_DEFAULTS.bindTimeoutMs),
  minCliVersion: Schema.string().default(CONFIG_DEFAULTS.minCliVersion),
})

export function apply(ctx: Context, config: Config): void {
  const deps: Deps = {
    runner: new Runner(),
    config: () => config,
    dshHome: process.env[DSH_HOME_ENV] || defaultDshHome(),
    agentsHome: process.env[AGENTS_HOME_ENV] || defaultAgentsHome(),
    home: homedir(),
    env: {},
    platform: process.platform,
    now: () => new Date(),
    processEnv: process.env,
    // Development/verification knob: `LARK_CLI_SEARCH_DIRS=/a:/b` replaces the usual install locations (an empty
    // value means "none"), to simulate a machine that has no lark-cli. Not for production use.
    commonDirs: process.env.LARK_CLI_SEARCH_DIRS === undefined ? undefined : process.env.LARK_CLI_SEARCH_DIRS.split(delimiter).filter(Boolean),
    log: { info: (m) => { ctx.logger.info(m) }, warn: (m) => { ctx.logger.warn(m) } },
  }
  const core = new LarkCore(deps)
  // The browser-trust fence of the composition's `connection` service (its package is browser-side, so it is typed here).
  const fence: RequestFence = request => (Reflect.get(ctx, 'connection') as { requestRejection: RequestFence }).requestRejection(request)
  const handler = createHandler(core, (message) => { ctx.logger.warn(`lark-cli: ${message}`) }, fence)
  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: ROUTE_PREFIX, handler }), 'lark-cli: routes')
  // Unload and hot config changes must leave no child process, timer or temp file behind.
  ctx.effect(() => () => { void core.dispose() }, 'lark-cli: dispose')
  ctx.logger.info(`lark-cli: routes at ${ROUTE_PREFIX}/*, install prefix ${join(deps.dshHome, 'lark-cli')}`)
}
