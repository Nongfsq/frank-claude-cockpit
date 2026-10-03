import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Board, Kind, Loose, Report, Row } from '../types'

const PANE = 'pr-pane'
const TITLE = 'Sessions'
const SERVER = 'ccd_session_mgmt'
const POLL_MS = 15_000
const PULLS_MS = 120_000
const DONE_LIMIT = 8

const board = atom({ plugin: 'pr-pane', key: 'board' } as const, null)
const error = atom({ plugin: 'pr-pane', key: 'error' } as const, null)
const isLoading = atom({ plugin: 'pr-pane', key: 'isLoading' } as const, false)
const attention = atom({ plugin: 'pr-pane', key: 'attention' } as const, 0)
const reports = atom({ plugin: 'pr-pane', key: 'reports' } as const, {})
const checkedAt = atom({ plugin: 'pr-pane', key: 'checkedAt' } as const, 0)
const expanded = atom({ plugin: 'pr-pane', key: 'expanded' } as const, [])
// When each running session was first seen running, so a row can say how long its current run has lasted.
const runs = atom({ plugin: 'pr-pane', key: 'runs' } as const, {})
const openSections = atom({ plugin: 'pr-pane', key: 'openSections' } as const, ['needs', 'working'])

// Theme keys, so both themes stay legible. Color means attention; merged gets the theme's own merged hue.
const TONES: Record<Kind, string | undefined> = {
  ready: 'success',
  waiting: 'warning',
  fix: 'error',
  working: 'suggestion',
  merged: 'merged',
  closed: undefined,
}
const NEEDS: Kind[] = ['fix', 'ready', 'waiting']

type Session = {
  sessionId: string
  title: string
  cwd: string
  branch?: string
  isRunning: boolean
  prNumber?: number
  prState?: 'OPEN' | 'MERGED' | 'CLOSED'
  lastActivityAt: string
  group?: { id: string; name: string } | null
}

type OpenPull = {
  number: number
  isDraft: boolean
  reviewDecision: string
  mergeable: string
  url: string
  statusCheckRollup: { conclusion?: string; status?: string; state?: string }[]
}

const FAILED = ['FAILURE', 'ERROR', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE']

const checksOf = (rollup: OpenPull['statusCheckRollup']) => {
  if (rollup.some(c => FAILED.includes(c.conclusion ?? '') || FAILED.includes(c.state ?? ''))) return 'fail'
  if (rollup.some(c => (c.status !== undefined && c.status !== 'COMPLETED') || c.state === 'PENDING')) return 'pending'

  return 'pass'
}

// Lifts a task id out of an AI-written title: "Fix TASK-183: unify recovery" → TASK-183, "unify recovery".
const splitTitle = (title: string) => {
  const match = title.match(/^(?:\S+\s+){0,3}?([A-Z][A-Z0-9]+-\d+)\s*[:：\-–]?\s*(.+)$/)

  return match ? { tag: match[1]!, name: match[2]! } : { tag: '', name: title }
}

const kindOf = (s: Session, pull: OpenPull | undefined): { kind: Kind; status: string } => {
  if (s.prState === 'MERGED') return { kind: 'merged', status: 'merged' }
  if (s.prState === 'CLOSED') return { kind: 'closed', status: 'closed' }

  const checks = pull === undefined ? 'pass' : checksOf(pull.statusCheckRollup ?? [])

  if (s.isRunning) return { kind: 'working', status: checks === 'pending' ? 'working · CI running' : 'working' }
  if (s.prState !== 'OPEN') return { kind: 'waiting', status: 'no report yet' }
  if (pull === undefined) return { kind: 'waiting', status: 'PR open' }
  if (checks === 'fail') return { kind: 'fix', status: 'CI failing' }
  if (pull.mergeable === 'CONFLICTING') return { kind: 'fix', status: 'conflicts' }
  if (pull.reviewDecision === 'CHANGES_REQUESTED') return { kind: 'fix', status: 'changes requested' }
  if (pull.isDraft) return { kind: 'waiting', status: 'draft' }
  if (checks === 'pending') return { kind: 'working', status: 'CI running' }
  if (pull.reviewDecision === 'REVIEW_REQUIRED') return { kind: 'waiting', status: 'needs review' }

  return { kind: 'ready', status: 'ready to merge' }
}

const ago = (ms: number) => {
  const seconds = Math.max(0, Math.round(ms / 1000))

  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h`

  return `${Math.floor(seconds / 86_400)}d`
}

const cut = (text: string, max: number) => (text.length > max ? `${text.slice(0, Math.max(1, max - 1))}…` : text)
const basename = (path: string) => path.replace(/\/+$/, '').split('/').pop() ?? path

const mcpJson = async ($: EngineInterface, tool: string, args: Record<string, unknown>) => {
  const result = await $.mcp.call(SERVER, tool, args)
  const text = result.content.find(block => block.type === 'text')?.text ?? ''

  if (result.isError) {
    throw new Error(text.split('\n')[0] || `${tool} failed`)
  }

  // An empty list comes back as a sentence ("No other sessions found in group ..."), not as `[]`.
  if (tool === 'list_sessions' && !text.trimStart().startsWith('[')) {
    return []
  }

  return JSON.parse(text) as unknown
}

const run = async ($: EngineInterface, argv: string[], cwd?: string) => {
  const result = await $.process.run(argv, { cwd, timeoutMs: 20_000 })

  return { ok: result.exitCode === 0, out: result.stdout.trim() }
}

let ghPath: string | null = null

// gh may be off the host's PATH; fall back to Homebrew's location.
const gh = async ($: EngineInterface, args: string[], cwd: string) => {
  for (const candidate of ghPath === null ? ['gh', '/opt/homebrew/bin/gh', '/usr/local/bin/gh'] : [ghPath]) {
    try {
      const result = await run($, [candidate, ...args], cwd)
      ghPath = candidate

      return result
    } catch {
      continue
    }
  }

  return { ok: false, out: '' }
}

let pulls = new Map<number, OpenPull>()
let repoName = ''
let pullsAt = 0

const refreshPulls = async ($: EngineInterface, root: string, now: number) => {
  const [repo, list] = await Promise.all([
    gh($, ['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner'], root),
    gh($, ['pr', 'list', '--state', 'open', '--limit', '50', '--json', 'number,isDraft,reviewDecision,mergeable,statusCheckRollup,url'], root),
  ])

  repoName = repo.ok ? repo.out : repoName
  pulls = list.ok ? new Map((JSON.parse(list.out) as OpenPull[]).map(p => [p.number, p] as const)) : pulls
  pullsAt = now
}

const looseWorktrees = async ($: EngineInterface, root: string, taken: Set<string>): Promise<Loose[]> => {
  const listed = await run($, ['git', 'worktree', 'list', '--porcelain'], root)

  if (!listed.ok) {
    return []
  }

  const paths = listed.out
    .split('\n\n')
    .filter(block => !block.includes('\nprunable'))
    .map(block => block.split('\n').find(line => line.startsWith('worktree '))?.slice(9) ?? '')
    .filter(path => path.startsWith(`${root}/`) && !taken.has(path))
    .slice(0, 10)

  const found = await Promise.all(
    paths.map(async path => {
      const status = await run($, ['git', '-C', path, 'status', '--porcelain']).catch(() => null)

      return status?.ok ? { path, name: basename(path), dirty: status.out === '' ? 0 : status.out.split('\n').length } : null
    }),
  )

  return found.filter((tree): tree is Loose => tree !== null)
}

const refresh = async ($: EngineInterface, force = false) => {
  if (await read($, isLoading)) {
    return
  }

  await update($, isLoading, () => true)

  try {
    const me = (await mcpJson($, 'get_session', { session_id: 'self' })) as Session
    const group = me.group ?? null
    const listed = (await mcpJson($, 'list_sessions', group === null ? { limit: 50 } : { group: group.id, limit: 50 })) as Session[]
    const common = await run($, ['git', 'rev-parse', '--path-format=absolute', '--git-common-dir'], me.cwd)
    const root = common.ok ? common.out.replace(/\/\.git$/, '') : ''
    // Outside any project (no group, no repo) the pane is an overview of every project's sessions.
    const isOverview = group === null && root === ''
    const sessions = isOverview ? listed : group === null ? listed.filter(s => s.cwd.startsWith(root)) : listed
    const now = await $.clock.now()

    if (root !== '' && (force || now - pullsAt >= PULLS_MS)) {
      await refreshPulls($, root, now)
    }

    const seen: Record<string, number> = await read($, runs)
    const running = Object.fromEntries(sessions.filter(s => s.isRunning).map(s => [s.sessionId, seen[s.sessionId] ?? now]))
    await update($, runs, () => running)

    const rows: Row[] = sessions.map(s => {
      const pull = s.prNumber === undefined ? undefined : pulls.get(s.prNumber)
      const { tag, name } = splitTitle(s.title)

      return {
        id: s.sessionId,
        tag,
        name,
        worktree: basename(s.cwd),
        branch: s.branch ?? '',
        ...kindOf(s, pull),
        pr: s.prNumber ?? 0,
        prUrl: pull?.url ?? (s.prNumber !== undefined && repoName !== '' ? `https://github.com/${repoName}/pull/${s.prNumber}` : ''),
        isRunning: s.isRunning,
        lastActivityAt: s.lastActivityAt,
        since: running[s.sessionId] ?? Date.parse(s.lastActivityAt),
        project: isOverview ? (s.group?.name ?? basename(s.cwd.split('/.claude/worktrees/')[0] ?? s.cwd)) : '',
      }
    })

    const taken = new Set([me.cwd, ...sessions.map(s => s.cwd)])
    const loose = root === '' ? [] : await looseWorktrees($, root, taken)
    const next: Board = {
      group: isOverview ? 'All projects' : (group?.name ?? basename(root)),
      me: { id: me.sessionId, title: me.title },
      rows,
      loose,
      at: now,
    }

    await update($, board, () => next)
    await update($, attention, () => rows.filter(row => NEEDS.includes(row.kind)).length)
    await update($, error, () => null)
  } catch (cause) {
    await update($, error, () => `Session list unavailable: ${cause instanceof Error ? cause.message : String(cause)}`)
  } finally {
    await update($, isLoading, () => false)
  }
}

// Asks about other sessions in this one: the prompt lands in this session's own chat, and Claude reads their
// transcripts to answer, so the sessions asked about are not interrupted.
const askHere = async ($: EngineInterface, rows: Row[]) => {
  if (rows.length === 0) {
    return
  }

  const list = rows.map(row => `- "${row.tag === '' ? row.name : `${row.tag} ${row.name}`}" (session ${row.id}${row.pr > 0 ? `, PR #${row.pr}` : ''})`)
  const text =
    `Report the status of ${rows.length === 1 ? 'this session' : 'these sessions'} without messaging ${rows.length === 1 ? 'it' : 'them'}: ` +
    `read each one's recent transcript with the ccd_session_mgmt list_events tool, and check its PR and CI if it has one.\n` +
    `${list.join('\n')}\n` +
    `For each, in one or two lines: what it is doing now, how far along it is, any blocker, and whether it is ready to merge.`

  await $.prompt.submit({ text, asUser: true })
  const now = await $.clock.now()
  await update($, checkedAt, () => now)
}

// The sessions worth asking about: the ones working now, or failing that the unfinished idle ones.
const askable = (rows: Row[]) => {
  const working = rows.filter(row => row.kind === 'working')

  return working.length > 0 ? working : rows.filter(row => row.kind !== 'merged' && row.kind !== 'closed')
}

const checkIn = async ($: EngineInterface) => {
  const data = await read($, board)

  if (data !== null) {
    await askHere($, askable(data.rows))
  }
}

const toggleRow = async ($: EngineInterface, id: string) =>
  update($, expanded, was => (was.includes(id) ? was.filter(one => one !== id) : [...was, id]))

const toggleSection = async ($: EngineInterface, id: string) =>
  update($, openSections, was => (was.includes(id) ? was.filter(one => one !== id) : [...was, id]))

// Toggles the pane: the context card's Sessions button and a typed /sessions both land here.
const togglePane = async ($: EngineInterface) => {
  const panes = await $.ui.panes()

  if (panes.some(pane => pane.id === PANE && pane.isPlaced)) {
    await $.ui.close({ id: PANE })

    return
  }

  const opened = await $.ui.open({ id: PANE, title: TITLE })

  if (!opened.isPlaced) $.ui.toast(`Sessions pane did not open: ${opened.reason ?? 'no reason given'}`)

  await refresh($, true)
}

/** Runs the toggle, and says why on screen when it fails rather than doing nothing. */
const pressPane = async ($: EngineInterface) => {
  try {
    await togglePane($)
  } catch (cause) {
    $.ui.toast(`Sessions pane failed: ${cause instanceof Error ? cause.message : String(cause)}`)
  }
}

export const register: Register = on => {
  let ticker: { cancel: () => void } | null = null

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'sessions', description: 'Show the sessions of this project and what each needs' })
    await $.command.register({ name: 'prs', description: 'Same as /sessions' })
    await refresh($, true)
    ticker?.cancel()
    ticker = $.clock.every(POLL_MS, () => void refresh($))

    return next(e)
  })

  on('session.end', ($, e, next) => {
    ticker?.cancel()
    ticker = null

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) {
      void refresh($)
    }

    return next(e)
  })

  // A report a check-in asked for: keep its first line beside the session it names.
  on('session.receive', async ($, e, next) => {
    const match = e.text.match(/\[status (local_[A-Za-z0-9-]+)\]\s*([^\n]*)/)

    if (match !== null) {
      const now = await $.clock.now()
      const id = match[1]!
      const reply = cut(match[2]!.trim(), 200)
      await update($, reports, was => ({ ...was, [id]: { askedAt: was[id]?.askedAt ?? now, reply, repliedAt: now } }))
    }

    return next(e)
  })

  on('command.run', { command: 'sessions' }, async $ => {
    await pressPane($)

    return {}
  })

  // The context card's PRs button: it counts its presses in its own state, and each write toggles the pane.
  on('state.set', { plugin: 'context-card', key: 'paneAsk' }, async ($, e, next) => {
    const result = await next(e)
    void pressPane($)

    return result
  })

  on('command.run', { command: 'prs' }, async $ => {
    await pressPane($)

    return {}
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Link, Text } = $.ui.resolve(e)
    const now = await $.clock.now()
    const data = await read($, board)
    const problem = await read($, error)
    const traces: Record<string, Report> = await read($, reports)
    const asked = await read($, checkedAt)
    const open: string[] = await read($, expanded)
    const sections: string[] = await read($, openSections)
    const columns = e.props.bodyColumns ?? 60
    const isNarrow = columns < 44
    const isDesktop = e.surface === 'desktop'
    // The grid every line sits on: a mark column, then a tag column that the detail labels share, then the text.
    // A cell is about one monospace character on both surfaces; desktop's proportional text runs narrower than
    // its cell count, so its tag column needs one cell less of gap than the terminal's.
    const MARK = 2
    const longestTag = Math.max(0, ...(data?.rows ?? []).map(row => row.tag.length))
    const tagColumn = isDesktop ? Math.max(9, longestTag + 1) : Math.max(10, longestTag + 2)
    const hasTags = !isNarrow && longestTag > 0
    const titleRoom = Math.max(12, columns - MARK - (hasTags ? tagColumn : 0) - 6)
    const keys = (hotkey: string) => (isDesktop ? {} : { hotkey })

    // Desktop: a label-less control laid over a whole line, so a click anywhere on it presses, with no hover block.
    const cover = (key: string, onPress: () => void) => (
      <Box position="absolute" top={0} left={0} right={0} bottom={0} overflow="hidden">
        {/* Wider than any line, so the overlay clips the control and its label is never cut with an ellipsis. */}
        <Box width={1200} flexShrink={0}>
          <Button key={key} plain label={'\u00A0'.repeat(600)} hover={{ backgroundColor: '#00000000' }} onPress={onPress} />
        </Box>
      </Box>
    )

    if (data === null) {
      return (
        <Box flexDirection="column" rowGap={1} paddingX={1}>
          <Text dimColor>{problem ?? 'Loading sessions…'}</Text>
          <Button key="refresh" plain {...(e.surface === 'desktop' ? {} : { hotkey: 'r' })} label="↻ refresh" onPress={() => void refresh($, true)} />
        </Box>
      )
    }

    const needs = data.rows.filter(row => NEEDS.includes(row.kind)).sort((a, b) => NEEDS.indexOf(a.kind) - NEEDS.indexOf(b.kind))
    const working = data.rows.filter(row => row.kind === 'working')
    const done = data.rows.filter(row => row.kind === 'merged' || row.kind === 'closed').slice(0, DONE_LIMIT)
    const targets = askable(data.rows)
    const targetLabel = `${targets.length} ${targets.some(row => row.kind === 'working') ? 'working' : 'open'}`

    const sessionRow = (row: Row) => {
      const isOpen = open.includes(row.id)
      const trace = traces[row.id]
      const hasReply = trace !== undefined && trace.repliedAt > 0
      const tone = TONES[row.kind]
      // One time per row, always how long it has been in the state its status names.
      const age = ago(now - row.since)
      const quiet = now - Date.parse(row.lastActivityAt)
      const toggle = () => void toggleRow($, row.id)

      return (
        <Box key={`row-${row.id}`} flexDirection="column" marginBottom={isOpen ? 1 : 0}>
          <Box key={`head-${row.id}`} flexDirection="row" position="relative">
            <Box width={MARK} flexShrink={0}>
              <Text color={tone} dimColor={tone === undefined}>
                {row.kind === 'working' ? '◐' : '●'}
              </Text>
            </Box>
            {hasTags && row.tag !== '' ? (
              <Box width={tagColumn} flexShrink={0}>
                <Text dimColor>{row.tag}</Text>
              </Box>
            ) : null}
            {isDesktop ? (
              <Text bold={isOpen} wrap="truncate-end">
                {row.name}
              </Text>
            ) : (
              <Button key={`title-${row.id}`} plain label={cut(row.name, titleRoom)} onPress={toggle} />
            )}
            <Box flexGrow={1} />
            <Text dimColor>{age}</Text>
            {isDesktop ? cover(`title-${row.id}`, toggle) : null}
          </Box>
          <Box flexDirection="row" columnGap={2} paddingLeft={MARK}>
            <Text color={tone} dimColor={tone === undefined} wrap="truncate-end">
              {row.status}
            </Text>
            {row.pr > 0 && row.prUrl !== '' ? <Link href={row.prUrl} label={`#${row.pr}`} /> : null}
            {row.pr > 0 && row.prUrl === '' ? <Text dimColor>{`#${row.pr}`}</Text> : null}
            <Box flexGrow={1} />
            {row.project === '' ? null : <Text dimColor wrap="truncate-end">{row.project}</Text>}
          </Box>
          {hasReply ? (
            <Box flexDirection="row" paddingLeft={MARK}>
              <Box width={2} flexShrink={0}>
                <Text color="success">↩</Text>
              </Box>
              <Text wrap="truncate-end">{trace.reply}</Text>
              <Box flexGrow={1} />
              <Text dimColor>{ago(now - trace.repliedAt)}</Text>
            </Box>
          ) : null}
          {isOpen ? (
            <Box flexDirection="column" rowGap={1} paddingLeft={MARK} marginTop={1}>
              <Box flexDirection="column">
                {[
                  ['worktree', row.worktree],
                  ['branch', row.branch],
                  ['PR', row.pr > 0 ? `#${row.pr} · ${row.status}` : 'none yet'],
                  ['activity', row.isRunning ? `working ${age}${quiet >= 60_000 ? ` · quiet ${ago(quiet)}` : ''}` : `idle ${age}`],
                ].map(([label, value]) => (
                  <Box key={`${row.id}-${label}`} flexDirection="row">
                    <Box width={tagColumn} flexShrink={0}>
                      <Text dimColor>{label}</Text>
                    </Box>
                    <Text wrap="truncate-end">{value}</Text>
                  </Box>
                ))}
              </Box>
              <Box flexDirection="row" columnGap={2}>
                <Button key={`ask-${row.id}`} variant="secondary" label="Ask here" onPress={() => void askHere($, [row])} />
                {row.prUrl === '' ? null : <Link href={row.prUrl} label="PR ↗" />}
              </Box>
            </Box>
          ) : null}
        </Box>
      )
    }

    // A section's heading is its own switch: bold while open, dim while folded, and no arrow.
    const section = (id: string, label: string, n: number, body: () => unknown) => {
      const isOpen = sections.includes(id)
      const toggle = () => void toggleSection($, id)

      return n === 0 ? null : (
        <Box key={`section-${id}`} flexDirection="column" marginTop={1}>
          <Box key={`heading-${id}`} flexDirection="row" columnGap={1} position="relative">
            {isDesktop ? (
              <Text bold={isOpen} dimColor={!isOpen}>
                {label}
              </Text>
            ) : (
              <Button key={`section-${id}`} plain label={isOpen ? label : `${label} …`} onPress={toggle} />
            )}
            <Text dimColor>{n}</Text>
            {isDesktop ? cover(`section-${id}`, toggle) : null}
          </Box>
          {isOpen ? body() : null}
        </Box>
      )
    }

    return (
      <Box flexDirection="column" paddingX={1}>
        <Box flexDirection="row" columnGap={2} alignItems="center">
          <Text bold wrap="truncate-end">
            {data.group}
          </Text>
          <Text dimColor>{asked > 0 ? `asked ${ago(now - asked)} ago` : `live · ${ago(now - data.at)}`}</Text>
          <Box flexGrow={1} />
          {targets.length === 0 ? null : (
            <Button key="checkin" variant="secondary" {...keys('c')} label={`Ask ${targetLabel}`} onPress={() => void checkIn($)} />
          )}
          <Button key="refresh" plain {...keys('r')} label="↻" onPress={() => void refresh($, true)} />
        </Box>

        {problem === null ? null : <Text color="error">{problem}</Text>}

        {data.rows.length === 0 ? (
          <Box marginTop={1}>
            <Text dimColor>No other sessions in this group yet.</Text>
          </Box>
        ) : null}
        {section('needs', 'Needs you', needs.length, () => needs.map(sessionRow))}
        {section('working', 'Working', working.length, () => working.map(sessionRow))}
        {section('done', 'Done', done.length, () => done.map(sessionRow))}
        {section('loose', 'Loose worktrees', data.loose.length, () =>
          data.loose.map(tree => (
            <Box key={`loose-${tree.path}`} flexDirection="row" columnGap={2} paddingLeft={MARK}>
              <Text wrap="truncate-end">{tree.name}</Text>
              <Box flexGrow={1} />
              <Text color={tree.dirty > 0 ? 'warning' : undefined} dimColor={tree.dirty === 0}>
                {tree.dirty > 0 ? `${tree.dirty} changed` : 'clean'}
              </Text>
            </Box>
          )),
        )}
      </Box>
    )
  })
}
