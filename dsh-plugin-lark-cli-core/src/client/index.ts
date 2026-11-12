/**
 * Browser half. The Feishu panel is a section of this bundle's own page under Plugins (the standard place for a
 * plugin's own UI), contributed through the Plugins page's `plugins.detail.section` slot.
 */
// Type-only: these merge `ctx.locale` and the Plugins page slots into the Context type.
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { en, zh, type LarkKey } from './locales.ts'
import { LarkSection } from './Section.tsx'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Copy of the Feishu connector panel. */
    larkCli: LarkKey
  }
}

/** Dictionary namespace owned by this plugin. */
export const NS = 'larkCli'

/** Cordis services this half needs. */
export const inject = ['slots', 'locale']

export function apply(ctx: ClientContext): void {
  // The other languages fall back to English until they are translated.
  ctx.effect(() => ctx.locale.register(NS, { zh, en, ja: en, es: en, fr: en, de: en, ru: en, pt: en }), 'lark-cli: dictionaries')
  ctx.slots.inject('plugins.detail.section', () => ctx.slots.register({
    name: 'plugins.detail.section', id: 'lark-cli', locale: NS,
  }, LarkSection))
}
