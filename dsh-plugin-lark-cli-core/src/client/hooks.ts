import { useCallback, useEffect, useRef, useState } from 'react'
import type { IntegrationStatus } from '../types.ts'
import { larkApi } from './api.ts'
import { needsPolling } from './polling.ts'

export interface StatusView {
  status: IntegrationStatus | null
  /** The status could not be read at all. */
  loadFailed: boolean
  reload: () => Promise<void>
}

const POLL_MS = 1000

export function useLarkStatus(): StatusView {
  const [status, setStatus] = useState<IntegrationStatus | null>(null)
  const [loadFailed, setLoadFailed] = useState(false)
  const alive = useRef(true)

  const reload = useCallback(async () => {
    const result = await larkApi.status()
    if (!alive.current) return
    if (result.ok && result.data !== null) { setStatus(result.data); setLoadFailed(false) } else setLoadFailed(true)
  }, [])

  useEffect(() => {
    alive.current = true
    void reload()
    return () => { alive.current = false }
  }, [reload])

  const polling = needsPolling(status)
  useEffect(() => {
    if (!polling) return undefined
    const timer = setInterval(() => { void reload() }, POLL_MS)
    return () => { clearInterval(timer) }
  }, [polling, reload])

  return { status, loadFailed, reload }
}
