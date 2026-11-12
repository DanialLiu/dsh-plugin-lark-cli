/** Plain-data defaults of the plugin Config (the Schemastery schema in index.ts reuses them). */
export interface LarkConfig {
  /** Manual path to lark-cli; wins over automatic discovery. */
  cliPath: string
  /** Managed install prefix; empty = `<dshHome>/lark-cli`. */
  installPrefix: string
  /** npm registry override (corporate mirror); empty = default. */
  registry: string
  statusTimeoutMs: number
  updateCheckTtlMs: number
  installTimeoutMs: number
  bindTimeoutMs: number
  /** Lowest lark-cli version the features rely on (`auth qrcode` since 1.0.40, embedded `skills` since 1.0.49). */
  minCliVersion: string
}

export const CONFIG_DEFAULTS: LarkConfig = {
  cliPath: '',
  installPrefix: '',
  registry: '',
  statusTimeoutMs: 8_000,
  updateCheckTtlMs: 1_800_000,
  installTimeoutMs: 600_000,
  bindTimeoutMs: 600_000,
  minCliVersion: '1.0.49',
}
