import { expect, test } from 'claude-code/testing'

const PANE = {
  plugin: 'pr-pane',
  component: 'Pane',
  requestId: 'pr-pane',
  props: { title: 'Sessions', isFocused: false, bodyColumns: 60, placement: 'dock' },
} as const
const NOW = Date.parse('2026-10-03T01:00:00Z')
const GROUP = { id: 'cg-1', name: 'Atlas' }

const ME = { sessionId: 'local_me', title: 'Atlas main', cwd: '/repo/.claude/worktrees/me', isRunning: true, lastActivityAt: '2026-10-03T01:00:00Z', group: GROUP }
const SESSIONS = [
  { sessionId: 'local_a', title: 'Fix TASK-183: retry failed uploads', cwd: '/repo/.claude/worktrees/cranky', branch: 'claude/cranky', isRunning: true, prNumber: 32, prState: 'OPEN', lastActivityAt: '2026-10-03T00:59:50Z', group: GROUP },
  { sessionId: 'local_b', title: 'Fix TASK-186: remember the last filter', cwd: '/repo/.claude/worktrees/brave', branch: 'claude/brave', isRunning: false, prNumber: 34, prState: 'OPEN', lastActivityAt: '2026-10-03T00:54:00Z', group: GROUP },
  { sessionId: 'local_c', title: '修复 TASK-177：深色模式下的对比度', cwd: '/repo/.claude/worktrees/ecstatic', branch: 'claude/ecstatic', isRunning: false, prNumber: 26, prState: 'MERGED', lastActivityAt: '2026-10-03T00:21:00Z', group: GROUP },
  { sessionId: 'local_d', title: 'Toolbar icon states', cwd: '/repo/.claude/worktrees/kind', branch: 'claude/kind', isRunning: false, lastActivityAt: '2026-10-03T00:35:00Z', group: GROUP },
]
const PULLS = [
  { number: 32, isDraft: false, reviewDecision: '', mergeable: 'MERGEABLE', url: 'https://github.com/o/r/pull/32', statusCheckRollup: [{ status: 'IN_PROGRESS' }] },
  { number: 34, isDraft: false, reviewDecision: 'APPROVED', mergeable: 'MERGEABLE', url: 'https://github.com/o/r/pull/34', statusCheckRollup: [{ conclusion: 'SUCCESS', status: 'COMPLETED' }] },
]
const WORKTREES = ['/repo', '/repo/.claude/worktrees/me', '/repo/.claude/worktrees/cranky', '/repo/.claude/worktrees/old']
  .map(path => `worktree ${path}\nHEAD aaa\ndetached`)
  .join('\n\n')

const text = (value: unknown) => ({ value: { content: [{ type: 'text', text: JSON.stringify(value) }], isError: false } })
const reply = (stdout: string, exitCode = 0) => ({ value: { exitCode, stdout, stderr: '' } })

test('groups the sessions by what they need, and asks about them in this session', async ($, on) => {
  const sent: string[] = []
  let isOpen = false

  on('mcp.call', ($, e) => (e.tool === 'get_session' ? text(ME) : text(SESSIONS)))
  on('process.run', ($, e) => {
    const argv = e.argv.join(' ')
    if (argv.includes('--git-common-dir')) return reply('/repo/.git')
    if (argv.includes('repo view')) return reply('o/r')
    if (argv.includes('pr list')) return reply(JSON.stringify(PULLS))
    if (argv.includes('worktree list')) return reply(WORKTREES)
    if (argv.includes('status')) return reply(' M a.ts')
    return reply('', 1)
  })
  on('prompt.submit', ($, e) => {
    sent.push(e.text)
    return { text: e.text }
  })
  on('clock.now', () => ({ value: NOW }))
  on('clock.every', () => ({ value: undefined }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('ui.open', () => {
    isOpen = true
    return { value: { isPlaced: true } }
  })
  on('ui.panes', () => ({ value: isOpen ? [{ id: 'pr-pane', title: 'Sessions', isPlaced: true }] : [] }))
  on('ui.close', () => {
    isOpen = false
    return { value: undefined }
  })
  on('ui.toast', () => ({ value: undefined }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('session.receive', ($, e) => ({ text: e.text }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))

  await $.session.start({ cwd: '/repo/.claude/worktrees/me', surface: 'desktop', isInteractive: true })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ text: /^Atlas$/ })).toBeDefined()
    expect(await ui.find({ text: /^Needs you$/ })).toBeDefined()
    expect(await ui.find({ text: /^TASK-186$/ })).toBeDefined()
    expect(await ui.find({ text: /^ready to merge$/ })).toBeDefined()
    expect(await ui.find({ text: /^no report yet$/ })).toBeDefined()
    expect(await ui.find({ text: /^working · CI running$/ })).toBeDefined()
    expect(await ui.find({ text: /^Loose worktrees/ })).toBeDefined()
    // Done is folded by default.
    expect(await ui.find({ text: /^merged$/ })).toBeUndefined()
    await ui.unmount()
  }

  // A narrow pane drops the freshness note rather than wrapping it beside a cut name.
  const narrow = await $.ui.mount({ ...PANE, surface: 'desktop', props: { ...PANE.props, bodyColumns: 30 } })
  expect(await narrow.find({ text: /^Atlas$/ })).toBeDefined()
  expect(await narrow.find({ text: /^live · / })).toBeUndefined()
  await narrow.unmount()
  const wide = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await wide.find({ text: /^live · / })).toBeDefined()
  await wide.unmount()

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'title-local_b' })
  expect(await ui.find({ text: /^brave$/ })).toBeDefined()

  // Check in asks in this session about the working ones, and messages nobody.
  await ui.press({ key: 'checkin' })
  expect(sent).toHaveLength(1)
  expect(sent[0]).toContain('local_a')
  expect(sent[0]).not.toContain('local_b')
  expect(sent[0]).toContain('list_events')

  await ui.press({ key: 'ask-local_b' })
  expect(sent).toHaveLength(2)
  expect(sent[1]).toContain('local_b')
  expect(await ui.find({ text: /^\?$/ })).toBeUndefined()

  // The Done heading asks what the finished sessions left behind, folded or not.
  await ui.press({ key: 'ask-done' })
  expect(sent).toHaveLength(3)
  expect(sent[2]).toContain('local_c')
  expect(sent[2]).not.toContain('local_a')
  expect(sent[2]).toContain('the outcome')

  // Pressed while this session's own turn runs, an ask waits in the pane, in view: pressing again replaces it
  // rather than stacking a second, Cancel drops it, and the turn's end sends it.
  await $.turn.start({ text: 'busy', turnId: 't1' })
  await ui.press({ key: 'checkin' })
  await ui.press({ key: 'checkin' })
  expect(sent).toHaveLength(3)
  expect(await ui.find({ text: /^After this turn: ask about / })).toBeDefined()
  await ui.press({ key: 'cancel-ask' })
  expect(await ui.find({ text: /^After this turn: ask about / })).toBeUndefined()
  await ui.press({ key: 'ask-done' })
  await $.turn.complete({ turnId: 't1', answer: '', durationMs: 1, isAborted: false, reason: 'answer' })
  // Sent after the hook returns, as the engine takes a plugin's prompt only once the turn has ended.
  for (let tries = 0; tries < 100 && sent.length < 4; tries++) await new Promise(resolve => setTimeout(resolve, 5))
  expect(sent).toHaveLength(4)
  expect(sent[3]).toContain('the outcome')
  expect(await ui.find({ text: /^After this turn: ask about / })).toBeUndefined()

  await $.session.receive({ origin: { kind: 'peer' }, text: '[status local_b] Done. PR #34 is green and approved.' })
  expect(await ui.find({ text: /^Done\. PR #34 is green and approved\.$/ })).toBeDefined()
  await ui.unmount()

  await $.command.run({ command: 'sessions', args: '' })
  expect(isOpen).toBe(true)
  await $.command.run({ command: 'sessions', args: '' })
  expect(isOpen).toBe(false)
})

test('says why when the session list cannot be read', async ($, on) => {
  on('mcp.call', () => ({ value: { content: [{ type: 'text', text: 'Unknown server' }], isError: true } }))
  on('process.run', () => reply('', 1))
  on('clock.now', () => ({ value: NOW }))
  on('clock.every', () => ({ value: undefined }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ text: /Session list unavailable: Unknown server/ })).toBeDefined()
  await ui.unmount()
})

test('outside any project, shows every project as an overview', async ($, on) => {
  const loner = { ...ME, cwd: '/scratch', group: null }
  on('mcp.call', ($, e) => (e.tool === 'get_session' ? text(loner) : text(SESSIONS.map(s => ({ ...s, group: { id: 'cg-2', name: 'harbor' } })))))
  on('process.run', () => reply('', 128))
  on('clock.now', () => ({ value: NOW }))
  on('clock.every', () => ({ value: undefined }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))

  await $.session.start({ cwd: '/scratch', surface: 'desktop', isInteractive: true })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ text: /^All projects$/ })).toBeDefined()
  expect(await ui.find({ text: /^harbor$/ })).toBeDefined()
  expect(await ui.find({ text: /^TASK-186$/ })).toBeDefined()
  await ui.unmount()
})

test('a group with no other session shows an empty board, not an error', async ($, on) => {
  const none = { content: [{ type: 'text', text: 'No other sessions found in group "cg-1".' }], isError: false }
  on('mcp.call', ($, e) => (e.tool === 'get_session' ? text(ME) : { value: none }))
  on('process.run', () => reply('', 1))
  on('clock.now', () => ({ value: NOW }))
  on('clock.every', () => ({ value: undefined }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))

  await $.session.start({ cwd: '/repo/.claude/worktrees/me', surface: 'desktop', isInteractive: true })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ text: /^Atlas$/ })).toBeDefined()
  expect(await ui.find({ text: /^No other sessions in this group yet\.$/ })).toBeDefined()
  expect(await ui.find({ text: /Session list unavailable/ })).toBeUndefined()
  await ui.unmount()
})
