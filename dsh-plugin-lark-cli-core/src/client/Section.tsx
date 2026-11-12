import type { ReactNode } from 'react'
import { LarkTab, type Translate } from './LarkTab.tsx'

/** The bundle this panel belongs to (the Plugins page renders every `plugins.detail.section` entry for every page). */
export const PACKAGE_NAME = 'dsh-plugin-lark-cli'

/** The slice of the page subject this section decides on. */
interface Subject { readonly kind: string, readonly pkg?: { readonly name: string, readonly enabled?: boolean } }

/** The Feishu panel, shown only on this bundle's own page (and only while the bundle is switched on). */
export function LarkSection({ t, subject }: { t: Translate, subject: Subject }): ReactNode {
  if (subject.kind !== 'bundle' || subject.pkg?.name !== PACKAGE_NAME || subject.pkg.enabled === false) return null
  return <LarkTab t={t} />
}
