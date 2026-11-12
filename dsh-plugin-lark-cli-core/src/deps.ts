/** What the core modules need from their surroundings; tests substitute all of it. */
import { join } from 'node:path'
import type { LarkConfig } from './config-defaults.ts'
import type { Installer } from './pnpm.ts'
import type { Runner } from './runner.ts'

export interface Deps {
  runner: Runner
  /** Live Config (read on every use so hot updates apply). */
  config: () => LarkConfig
  /** DSH_HOME (default: the host's home, e.g. `~/.dsh`). */
  dshHome: string
  /** Shared agents root (default `~/.agents`). */
  agentsHome: string
  /** The operating-system home, for locating lark-cli. */
  home: string
  /** Extra environment for child processes (tests inject the fake CLI script here). */
  env: Record<string, string | undefined>
  platform: NodeJS.Platform
  now: () => Date
  /** Override where lark-cli is searched besides PATH (tests). */
  commonDirs?: string[] | undefined
  /** Replace installer discovery (tests). */
  installerOverride?: (() => Promise<Installer | null>) | undefined
  /** Environment used to find lark-cli on PATH. */
  processEnv: NodeJS.ProcessEnv
  log: { info(msg: string): void, warn(msg: string): void }
}

export function installPrefixOf(deps: Deps): string {
  const configured = deps.config().installPrefix
  return configured.length > 0 ? configured : join(deps.dshHome, 'lark-cli')
}

export function managedSkillsDir(deps: Deps): string {
  return join(deps.dshHome, 'skills')
}
