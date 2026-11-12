import { isActivePhase, type IntegrationStatus } from '../types.ts'

/** Polling is only needed while something is moving: a task, an update check, or the first detection. */
export function needsPolling(status: IntegrationStatus | null): boolean {
  if (status === null) return false
  if (status.job !== null && isActivePhase(status.job.phase)) return true
  if (status.state === 'checking') return true
  return status.cli?.update === 'checking'
}
