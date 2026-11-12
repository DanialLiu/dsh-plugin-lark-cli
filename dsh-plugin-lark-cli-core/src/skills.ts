/**
 * lark-cli ships its skills embedded in the binary (`lark-cli skills list|read`), so they always match its
 * version. A user who installed lark-cli with `npx skills add` already has them in `~/.agents/skills`; a managed
 * install has none, so they are exported to the host's own `<dshHome>/skills/` (a skill-filesystem root that is
 * watched, so the assistant sees them without a restart). Exported skills carry a marker file with the
 * lark-cli version; nothing the user installed is ever touched.
 */
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { managedSkillsDir, type Deps } from './deps.ts'
import { jsonOf, QUIET_ENV } from './runner.ts'
import { JobFailure, type SkillsInfo } from './types.ts'

export const SKILLS_MARKER = '.lark-cli-managed'
const PREFIX = 'lark-'

export interface SkillsStatusHint { inSync: boolean, official: number }

async function listLarkSkillDirs(root: string): Promise<string[]> {
  try {
    const entries = await readdir(root, { withFileTypes: true })
    const out: string[] = []
    for (const entry of entries) {
      if (!entry.name.startsWith(PREFIX)) continue
      try {
        const info = await stat(join(root, entry.name, 'SKILL.md'))
        if (info.isFile()) out.push(entry.name)
      } catch { /* not a skill directory */ }
    }
    return out
  } catch { return [] }
}

async function managedVersion(root: string): Promise<string | null> {
  try { return (await readFile(join(root, SKILLS_MARKER), 'utf8')).trim() || null } catch { return null }
}

/**
 * Decide which skills the assistant currently sees and whether they match the installed lark-cli.
 * @param hint `skills_status` from `lark-cli update --check`, when available.
 */
export async function inspectSkills(deps: Deps, cliVersion: string, hint: SkillsStatusHint | null): Promise<SkillsInfo> {
  const managedRoot = managedSkillsDir(deps)
  const [managedSkills, managedVersionTag, agentSkills] = await Promise.all([
    listLarkSkillDirs(managedRoot), managedVersion(managedRoot), listLarkSkillDirs(join(deps.agentsHome, 'skills')),
  ])
  if (managedVersionTag === cliVersion && managedSkills.length > 0) return { inSync: true, count: managedSkills.length, source: 'managed' }
  if (agentSkills.length > 0) {
    return { inSync: hint === null ? null : hint.inSync, count: agentSkills.length, source: 'agents' }
  }
  if (managedSkills.length > 0) return { inSync: false, count: managedSkills.length, source: 'managed', reason: 'version-mismatch' }
  return { inSync: false, count: 0, source: 'none', reason: 'not-installed' }
}

/** A skill directory name from lark-cli's listing: one plain path segment, never something that leaves the skills root. */
const SKILL_NAME = /^lark-[A-Za-z0-9][A-Za-z0-9._-]*$/
/** A file path inside a skill: relative, `/`-separated, no empty, `.` or `..` segments, no backslashes or NUL. */
export function isSafeSkillPath(path: string): boolean {
  return path.length > 0 && !/[\\\0]/.test(path) && path.split('/').every(segment => segment.length > 0 && segment !== '.' && segment !== '..')
}

interface Ctx { signal: AbortSignal, log: (line: string) => void }

async function cliJson(deps: Deps, bin: string, args: string[], ctx: Ctx): Promise<unknown> {
  const result = await deps.runner.run(bin, args, {
    timeoutMs: deps.config().statusTimeoutMs * 2, signal: ctx.signal, env: { ...QUIET_ENV, ...deps.env },
  })
  const parsed = jsonOf(result) as { ok?: boolean } | undefined
  if (result.code !== 0 || parsed === undefined || parsed.ok === false) {
    throw new JobFailure({ code: 'cli_failed', message: `lark-cli ${args.join(' ')} failed`, hint: 'skills-sync' })
  }
  return parsed
}

/**
 * Export the skills embedded in this lark-cli into `<dshHome>/skills`, replacing only previously managed ones.
 * Throws JobFailure on failure; partial results are discarded so the previous set stays intact.
 * @returns the number of skills written.
 */
export async function syncSkills(deps: Deps, bin: string, cliVersion: string, ctx: Ctx): Promise<number> {
  const root = managedSkillsDir(deps)
  await mkdir(root, { recursive: true })
  const staging = join(root, `.lark-sync-${process.pid}-${Date.now()}`)
  await mkdir(staging, { recursive: true })
  try {
    const listing = await cliJson(deps, bin, ['skills', 'list'], ctx) as { skills?: Array<{ name: string }> }
    const names = (listing.skills ?? []).map(s => s.name).filter(n => typeof n === 'string' && SKILL_NAME.test(n))
    if (names.length === 0) throw new JobFailure({ code: 'cli_failed', message: 'this lark-cli exposes no skills', hint: 'skills-sync' })
    ctx.log(`skills: ${names.length}`)

    const walk = async (path: string): Promise<string[]> => {
      const json = await cliJson(deps, bin, ['skills', 'list', path], ctx) as { entries?: Array<{ path: string, is_dir: boolean }> }
      const files: string[] = []
      for (const entry of json.entries ?? []) {
        if (typeof entry.path !== 'string' || !isSafeSkillPath(entry.path) || !entry.path.startsWith(`${path.split('/')[0]}/`) && entry.path !== path.split('/')[0]) {
          throw new JobFailure({ code: 'cli_failed', message: 'lark-cli listed a skill file outside its skill', hint: 'skills-sync' })
        }
        if (entry.is_dir) files.push(...await walk(entry.path))
        else files.push(entry.path)
      }
      return files
    }
    const writeOne = async (path: string): Promise<void> => {
      if (ctx.signal.aborted) throw new Error('aborted')
      const result = await deps.runner.run(bin, ['skills', 'read', path], {
        timeoutMs: deps.config().statusTimeoutMs * 2, signal: ctx.signal, env: { ...QUIET_ENV, ...deps.env }, maxOutputBytes: 4 * 1024 * 1024,
      })
      if (result.code !== 0) throw new JobFailure({ code: 'cli_failed', message: `could not read skill file ${path}`, hint: 'skills-sync' })
      const target = join(staging, path)
      await mkdir(join(target, '..'), { recursive: true })
      await writeFile(target, result.stdout)
    }

    let done = 0
    for (const name of names) {
      const files = await walk(name)
      // modest concurrency: hundreds of tiny processes in total
      for (let i = 0; i < files.length; i += 6) {
        await Promise.all(files.slice(i, i + 6).map(writeOne))
      }
      done += 1
      if (done % 5 === 0 || done === names.length) ctx.log(`skills: ${done}/${names.length}`)
    }
    await writeFile(join(staging, SKILLS_MARKER), `${cliVersion}\n`)

    // Swap in: drop previously managed lark skills (only ours), then move the new ones.
    if (await managedVersion(root) !== null) {
      for (const old of await listLarkSkillDirs(root)) await rm(join(root, old), { recursive: true, force: true })
    }
    for (const name of names) {
      await rm(join(root, name), { recursive: true, force: true })
      await rename(join(staging, name), join(root, name))
    }
    await writeFile(join(root, SKILLS_MARKER), `${cliVersion}\n`)
    return names.length
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
}
