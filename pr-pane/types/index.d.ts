/** What a session row needs next, which decides its section and color. */
export type Kind = 'ready' | 'waiting' | 'fix' | 'working' | 'merged' | 'closed'

export type Row = {
  /** The desktop app's session id (`local_...`). */
  id: string
  /** A task id lifted from the title (`TASK-183`), or empty. */
  tag: string
  /** The title without its task id and verb. */
  name: string
  worktree: string
  branch: string
  kind: Kind
  /** One short status phrase (`ready to merge`, `CI failing`). */
  status: string
  pr: number
  prUrl: string
  isRunning: boolean
  /** ISO time of the session's last activity. */
  lastActivityAt: string
  /** Epoch ms its current state began: the run for a running session, the last activity otherwise. */
  since: number
  /** The session's project, shown only in the all-projects overview; empty otherwise. */
  project: string
}

export type Loose = { path: string; name: string; dirty: number }

export type Board = {
  group: string
  /** This session's own id and title, so check-ins can name where to reply. */
  me: { id: string; title: string }
  rows: Row[]
  loose: Loose[]
  /** Epoch ms of the last successful refresh. */
  at: number
}

/** A check-in's trace per session: when it was asked, and what it answered. */
export type Report = { askedAt: number; reply: string; repliedAt: number }

declare module 'claude-code' {
  interface PluginState {
    'context-card': { paneAsk: number }
    'pr-pane': {
      board: Board | null
      error: string | null
      isLoading: boolean
      attention: number
      reports: Record<string, Report>
      checkedAt: number
      runs: Record<string, number>
      expanded: string[]
      openSections: string[]
    }
  }
}
