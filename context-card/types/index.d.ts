export type Slice = {
  /** Row label as /context prints it. */
  name: string
  tokens: number
  /** 0 to 100, against the measured window. */
  percent: number
  color: string
  isFree: boolean
}

export type Limit = {
  /** `five_hour`, `seven_day`, or a gateway's `spend_limit`. */
  kind: string
  percentUsed: number
  resetsAt?: string
}

export type Card = {
  /** Tokens in use. */
  tokens: number
  /** The window measured against. */
  window: number
  percent: number
  /** Token count where auto-compaction runs; null when off. */
  compactsAt: number | null
  slices: Slice[]
  limits: Limit[]
}

declare module 'claude-code' {
  interface PluginState {
    'context-card': { card: Card | null; isOpen: boolean; cache: { lastReplyAt: number; ttlMs: number }; paneAsk: number }
    'pr-pane': { attention: number }
  }
}
