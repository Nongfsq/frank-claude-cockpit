export type Limit = {
  /** `five_hour`, `seven_day`, or a gateway's `spend_limit`. */
  kind: string
  percentUsed: number
  resetsAt?: string
}

export type Card = {
  /** Tokens in use. */
  tokens: number
  /** The window measured against: the auto-compact window, as /context measures. */
  window: number
  percent: number
  /** Token count where auto-compaction runs; null when off. */
  compactsAt: number | null
  /** Whether auto-compaction is on (/config's `autoCompact`); absent on a card stored before 0.2.0. */
  isAutoCompact?: boolean
  /** The window /autocompact saved for the model, `auto`, or null when none is saved; absent before 0.2.0. */
  savedWindow?: number | 'auto' | null
  limits: Limit[]
  /** When `limits` was read, epoch ms; 0 when unknown. */
  limitsAt: number
  /** The status the account's usage endpoint last refused with, until it answers again; null when it has not. */
  refusedStatus: number | null
}

/** The compact knob: idle, armed by a first press below 60% (a second press compacts), or compacting. */
export type Knob = {
  state: 'idle' | 'armed' | 'compacting'
  /** When the state began, epoch ms; 0 when idle. */
  since: number
  /** Bumped while armed, so the draining ring is redrawn. */
  tick: number
}

declare module 'claude-code' {
  interface PluginState {
    'context-card': { card: Card | null; knob: Knob }
  }
}
