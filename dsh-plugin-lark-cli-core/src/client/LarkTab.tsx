import { useEffect, useState, type ReactNode } from 'react'
import { Button, StateDot, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import type { StateDotState, TagTone } from '@deepseek-ai/dsh-client-ui-primitives'
import { isActivePhase, type ErrorInfo, type IntegrationStatus, type Job, type JobKind, type JobPhase } from '../types.ts'
import { larkApi, type ApiResult } from './api.ts'
import { useLarkStatus } from './hooks.ts'
import type { LarkKey } from './locales.ts'
import css from './LarkTab.module.css'

export type Translate = (key: LarkKey, params?: Record<string, string | number>) => string

export interface LarkTabProps {
  t: Translate
}

type Pending =
  | { kind: 'install', details: Record<string, unknown> }
  | { kind: 'update', details: Record<string, unknown> }
  | { kind: 'uninstall' }
  | { kind: 'reconfigure', mode: 'new' | 'existing', details: Record<string, unknown> }

const JOB_LABEL: Record<JobKind | 'skills', LarkKey> = {
  install: 'jobInstall', update: 'jobUpdate', 'bind-new': 'jobBindNew', 'bind-existing': 'jobBindExisting', authorize: 'jobAuthorize', skills: 'jobSkills',
}
const PHASE_LABEL: Record<JobPhase, LarkKey> = {
  running: 'phaseRunning', 'waiting-user': 'phaseWaiting', succeeded: 'phaseSucceeded', failed: 'phaseFailed', cancelled: 'phaseCancelled', 'timed-out': 'phaseTimedOut',
}
const PHASE_DOT: Record<JobPhase, StateDotState> = {
  running: 'ongoing', 'waiting-user': 'warning', succeeded: 'done', failed: 'error', cancelled: 'idle', 'timed-out': 'error',
}

function errorText(t: Translate, error: ErrorInfo | null): string {
  if (error === null) return t('err_default')
  const key = `err_${error.code}` as LarkKey
  const text = t(key)
  return text === key ? t('err_default') : text
}

function stateTag(t: Translate, status: IntegrationStatus): { label: string, tone: TagTone } {
  switch (status.state) {
    case 'ready': return { label: t('stateReady'), tone: 'success' }
    case 'installed-unbound': return { label: t('stateUnbound'), tone: 'warning' }
    case 'rebind-required': return { label: t('stateRebind'), tone: 'danger' }
    case 'not-installed': return { label: t('stateNotInstalled'), tone: 'neutral' }
    default: return { label: t('checking'), tone: 'neutral' }
  }
}

export function LarkTab({ t }: LarkTabProps): ReactNode {
  const { status, loadFailed, reload } = useLarkStatus()
  const [pending, setPending] = useState<Pending | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [form, setForm] = useState<null | { appId: string, appSecret: string, brand: 'feishu' | 'lark' }>(null)
  const [brand, setBrand] = useState<'feishu' | 'lark'>('feishu')
  const [showLog, setShowLog] = useState(false)
  const [showQr, setShowQr] = useState(false)
  const [purge, setPurge] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  useEffect(() => {
    if (!menuOpen) return
    const close = (): void => { setMenuOpen(false) }
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') close() }
    document.addEventListener('click', close)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('click', close); document.removeEventListener('keydown', onKey) }
  }, [menuOpen])
  const [dismissed, setDismissed] = useState<string | null>(null)
  if (status === null) {
    return (
      <div className={css.page}>
        <div className={css.head}><h2>{t('title')}</h2></div>
        <p className={css.muted}>{loadFailed ? t('errLoad') : t('checking')}</p>
        {loadFailed && <div><Button variant="outline" size="sm" onClick={() => { void reload() }}>{t('retry')}</Button></div>}
      </div>
    )
  }

  const job = status.job
  const jobActive = job !== null && isActivePhase(job.phase)
  const installed = status.cli !== null
  const bound = status.binding !== null
  const jobShown = job !== null && job.phase !== 'succeeded' && dismissed !== job.id
  /** The authorize job's own panel carries step 3 (with the open-browser button), so the plain step-3 card is hidden meanwhile. */
  const authJobShown = jobShown && (job.stage === 'authorize' || job.kind === 'authorize')
  const tag = stateTag(t, status)

  /** Run a request; a confirmation_required answer opens the confirm panel instead of failing. */
  const run = async <T,>(request: () => Promise<ApiResult<T>>, onConfirm?: (details: Record<string, unknown>) => void): Promise<ApiResult<T>> => {
    setBusy(true)
    setMessage(null)
    const result = await request()
    setBusy(false)
    if (!result.ok) {
      if (result.error?.code === 'confirmation_required' && onConfirm !== undefined) onConfirm(result.details ?? {})
      else setMessage(errorText(t, result.error))
    } else setPending(null)
    await reload()
    return result
  }

  const startInstall = (confirm: boolean) => run(() => larkApi.install(confirm), d => { setPending({ kind: 'install', details: d }) })
  const startUpdate = (confirm: boolean) => run(() => larkApi.update(confirm), d => { setPending({ kind: 'update', details: d }) })
  const doUninstall = async (): Promise<void> => {
    setBusy(true)
    setMessage(null)
    const result = await larkApi.uninstall(purge)
    setBusy(false)
    setPending(null)
    setPurge(false)
    if (!result.ok) setMessage(errorText(t, result.error))
    await reload()
  }
  const startAuthorize = () => run(() => larkApi.authorize(true))
  const startBind = (body: Record<string, unknown>, mode: 'new' | 'existing') =>
    run(() => larkApi.bind(body), d => { setPending({ kind: 'reconfigure', mode, details: d }) })

  const confirmPending = async (): Promise<void> => {
    if (pending === null) return
    if (pending.kind === 'uninstall') return
    if (pending.kind === 'install') await startInstall(true)
    else if (pending.kind === 'update') await startUpdate(true)
    else if (pending.mode === 'new') await startBind({ mode: 'new', brand, replace: true, confirm: true }, 'new')
    else if (form !== null) await startBind({ mode: 'existing', ...form, replace: true, confirm: true }, 'existing')
    if (pending.kind === 'reconfigure') setForm(null)
  }

  const copyText = async (text: string): Promise<void> => {
    try { await navigator.clipboard.writeText(text); setMessage(t('copied')) } catch { /* clipboard unavailable */ }
  }

  const uninstallDialog = (): ReactNode => {
    if (pending === null || pending.kind !== 'uninstall') return null
    return (
      <div className={css.modalBackdrop} onClick={() => { if (!busy) setPending(null) }}>
        <div className={css.modal} role="alertdialog" aria-modal="true" aria-label={t('uninstallTitle')} onClick={(e) => { e.stopPropagation() }}>
          <strong>{t('uninstallTitle')}</strong>
          <span>{t('uninstallBody')}</span>
          {jobActive && <span className={css.muted}>{t('uninstallStopsJob')}</span>}
          <label className={css.check}>
            <input type="checkbox" checked={purge} onChange={(e) => { setPurge(e.target.checked) }} />
            <span>{t('uninstallPurge')}<br /><span className={css.muted}>{t('uninstallKeep')}</span></span>
          </label>
          <div className={css.row}>
            <Button variant="primary" size="sm" disabled={busy} onClick={() => { void doUninstall() }}>{t('uninstallBtn')}</Button>
            <Button variant="outline" size="sm" disabled={busy} onClick={() => { setPending(null) }}>{t('cancel')}</Button>
          </div>
        </div>
      </div>
    )
  }

  const confirmBox = (): ReactNode => {
    if (pending === null || pending.kind === 'uninstall') return null
    const d = pending.details
    const title = pending.kind === 'install' ? t('installConfirmTitle') : pending.kind === 'update' ? t('updateConfirmTitle') : t('reconfigureConfirmTitle')
    const body = pending.kind === 'install'
      ? t('installConfirmBody', { source: String(d.source ?? 'npm'), package: String(d.package ?? ''), target: String(d.target ?? '') })
      : pending.kind === 'update' ? t('updateConfirmBody', { from: String(d.from ?? ''), to: String(d.to ?? '') })
        : t('reconfigureConfirmBody', { app: String(d.appId ?? status.binding?.appId ?? '') })
    return (
      <div className={css.confirm} role="alertdialog" aria-label={title}>
        <strong>{title}</strong>
        <span>{body}</span>
        <div className={css.row}>
          <Button variant="primary" size="sm" disabled={busy} onClick={() => { void confirmPending() }}>{t('confirm')}</Button>
          <Button variant="outline" size="sm" onClick={() => { setPending(null) }}>{t('cancel')}</Button>
        </div>
      </div>
    )
  }

  /** Install and update are one step: the one button does whichever the machine needs. */
  const cliAction = (): ReactNode => {
    const cli = status.cli
    const disabled = busy || jobActive || status.state === 'checking'
    if (cli === null) return <div className={css.row}><Button variant="primary" size="sm" disabled={disabled} onClick={() => { void startInstall(true) }}>{t('installBtn')}</Button></div>
    const available = cli.update === 'available'
    return (
      <div className={css.row}>
        <span>{available ? t('updateAvailable', { from: cli.version, to: cli.latestVersion ?? '' }) : t('version', { version: cli.version })}</span>
        {available
          ? <Button variant="primary" size="sm" disabled={disabled} onClick={() => { void startUpdate(true) }}>{t('updateBtn')}</Button>
          : cli.update === 'up-to-date' && <Tag tone="success">{t('updateLatest')}</Tag>}
        {cli.belowMinVersion && <span className={css.warn}>{t('belowMin', { min: cli.minVersion })}</span>}
        {cli.managed && (
          <div className={css.more}>
            <Button variant="ghost" size="sm" aria-label={t('more')} aria-haspopup="menu" aria-expanded={menuOpen} disabled={busy} onClick={(e) => { e.stopPropagation(); setMenuOpen(v => !v) }}>…</Button>
            {menuOpen && (
              <div className={css.menu} role="menu">
                <button type="button" role="menuitem" className={css.menuItemDanger} onClick={() => { setMenuOpen(false); setPurge(false); setPending({ kind: 'uninstall' }) }}>{t('uninstallBtn')}</button>
              </div>
            )}
          </div>
        )}
      </div>
    )
  }

  const jobPanel = (j: Job): ReactNode => {
    const terminal = !isActivePhase(j.phase)
    const failure = j.failure
    return (
      <div className={css.job} data-testid="lark-job">
        <div className={css.rowBetween}>
          <div className={css.row}>
            <StateDot state={PHASE_DOT[j.phase]} />
            <strong>{j.stage === 'authorize' ? t('stageAuthTitle') : j.stage === 'bind' ? t('stageBindTitle') : t(JOB_LABEL[j.kind as JobKind | 'skills'])}</strong>
            <Tag tone={j.phase === 'succeeded' ? 'success' : j.phase === 'failed' || j.phase === 'timed-out' ? 'danger' : 'neutral'}>{t(PHASE_LABEL[j.phase])}</Tag>
          </div>
          <div className={css.row}>
            {!terminal && <Button variant="outline" size="sm" onClick={() => { void run(() => larkApi.cancel()) }}>{t('stop')}</Button>}
            {terminal && <Button variant="ghost" size="sm" onClick={() => { setDismissed(j.id) }}>{t('dismiss')}</Button>}
          </div>
        </div>
        {j.stage === 'authorize' && j.kind !== 'authorize' && <div className={css.bannerOk} role="status">{t('stageBindDone')}</div>}
        {j.phase === 'waiting-user' && j.handoff === null && <span className={css.muted}>{t('waitingUser')}</span>}
        {j.handoff !== null && (
          <div className={css.handoff}>
            <p className={css.muted}>{t('waitingUser')}</p>
            <div className={css.row}>
              <Button variant="primary" size="sm" onClick={() => { window.open(j.handoff?.url, '_blank', 'noopener') }}>{t('openBrowser')}</Button>
              {j.handoff.qrPngBase64 !== null && (
                <>
                  <span className={css.muted}>{t('or')}</span>
                  <button type="button" className={css.link} onClick={() => { setShowQr(v => !v) }}>{showQr ? t('hideQr') : t('showQr')}</button>
                </>
              )}
            </div>
            {showQr && j.handoff.qrPngBase64 !== null && <img className={css.qr} alt="QR" src={`data:image/png;base64,${j.handoff.qrPngBase64}`} />}
          </div>
        )}
        {failure !== null && (
          <div>
            <p className={css.error}>{errorText(t, failure)}</p>
            {failure.hint !== undefined && <p className={`${css.muted} ${css.mono}`}>{failure.hint}</p>}
            {failure.manualCommand !== undefined && (
              <p className={css.muted}>{t('manualCommand')}
                {' '}<span className={css.copy}><code className={css.mono}>{failure.manualCommand}</code>
                  <button type="button" className={css.link} onClick={() => { void copyText(failure.manualCommand ?? '') }}>{t('copyLink')}</button></span></p>
            )}
          </div>
        )}
        {j.log.length > 0 && (
          <div>
            <button type="button" className={css.link} onClick={() => { setShowLog(v => !v) }}>{showLog ? t('hideLog') : t('showLog')}</button>
            {showLog && <pre className={css.log}>{j.log.join('\n')}</pre>}
          </div>
        )}
      </div>
    )
  }

  const bindActions = (): ReactNode => {
    if (!installed) return <span className={css.muted}>{t('bindFirst')}</span>
    if (bound) {
      return (
        <div className={css.rowBetween}>
          <span>{t('boundApp', { app: status.binding?.appId ?? '', brand: status.binding?.brand === 'lark' ? t('brandLark') : t('brandFeishu') })}</span>
          <div className={css.row}>
            <Button variant="outline" size="sm" disabled={busy || jobActive} onClick={() => { setForm(null); void startBind({ mode: 'new', brand: status.binding?.brand ?? 'feishu', replace: true }, 'new') }}>{t('reconfigure')}</Button>
          </div>
        </div>
      )
    }
    return (
      <div className={css.row}>
        <select className={css.select} style={{ width: 'auto' }} aria-label={t('brand')} value={brand} onChange={(e) => { setBrand(e.target.value === 'lark' ? 'lark' : 'feishu') }}>
          <option value="feishu">{t('brandFeishu')}</option>
          <option value="lark">{t('brandLark')}</option>
        </select>
        <Button variant="primary" size="sm" disabled={busy || jobActive} onClick={() => { void startBind({ mode: 'new', brand }, 'new') }}>{t('bindNew')}</Button>
        <Button variant="outline" size="sm" disabled={busy || jobActive} onClick={() => { setForm({ appId: '', appSecret: '', brand }) }}>{t('bindExisting')}</Button>
      </div>
    )
  }

  const user = status.user

  return (
    <div className={css.page}>
      <div className={css.head}>
        <div className={css.row}><h2>{t('title')}</h2><Tag tone={tag.tone}>{tag.label}</Tag>{status.state === 'ready' && !status.verified && <Tag tone="outline">{t('unverified')}</Tag>}</div>
      </div>
      {status.conflict !== null && <div className={css.banner}>{t('conflict')}</div>}
      {message !== null && <div className={css.banner}>{message}</div>}

      <section className={css.card}>
        <div className={css.cardHead}><h3 className={css.cardTitle}>{t('step1')}</h3>
          {installed ? <StateDot state="done" /> : null}</div>
        {cliAction()}
        {pending !== null && (pending.kind === 'install' || pending.kind === 'update') && confirmBox()}
        {uninstallDialog()}
      </section>

      <section className={`${css.card} ${installed ? '' : css.cardDim}`}>
        <div className={css.cardHead}><h3 className={css.cardTitle}>{t('step2')}</h3>
          {status.state === 'ready' ? <StateDot state="done" /> : status.state === 'rebind-required' ? <StateDot state="error" /> : null}</div>
        {status.state === 'rebind-required' && <span className={css.error}>{t('rebindHint')}</span>}
        {bindActions()}
        {form !== null && (
          <div className={css.form}>
            <label htmlFor="lark-app-id">{t('appId')}</label>
            <input id="lark-app-id" className={css.input} value={form.appId} autoComplete="off" spellCheck={false} onChange={(e) => { setForm({ ...form, appId: e.target.value }) }} />
            <label htmlFor="lark-app-secret">{t('appSecret')}</label>
            <input id="lark-app-secret" className={css.input} type="password" value={form.appSecret} autoComplete="off" spellCheck={false} onChange={(e) => { setForm({ ...form, appSecret: e.target.value }) }} />
            <span />
            <div className={css.row}>
              <Button variant="primary" size="sm" disabled={busy || jobActive || form.appId.trim() === '' || form.appSecret === ''}
                onClick={() => { void startBind({ mode: 'existing', ...form, appId: form.appId.trim() }, 'existing').then(() => { setForm(null) }) }}>{t('submitBind')}</Button>
              <Button variant="outline" size="sm" onClick={() => { setForm(null) }}>{t('cancel')}</Button>
            </div>
          </div>
        )}
        {pending !== null && pending.kind === 'reconfigure' && confirmBox()}
      </section>

      {bound && !authJobShown && (
        <section className={css.card}>
          <div className={css.cardHead}><h3 className={css.cardTitle}>{t('step3')}</h3>
            {user.status === 'authorized' ? <StateDot state="done" /> : null}</div>
          {user.status === 'authorized'
            ? <span>{user.userName !== null ? t('userAuthorized', { name: user.userName }) : t('userAuthorizedNoName')}</span>
            : (
              <div className={css.row}>
                <Button variant="primary" size="sm" disabled={busy || jobActive} onClick={() => { void startAuthorize() }}>{t('authorize')}</Button>
                {user.status === 'expired' && <span className={css.warn}>{t('userExpired')}</span>}
              </div>
            )}
        </section>
      )}

      {jobShown && job !== null && jobPanel(job)}

    </div>
  )
}
