import { expect, test } from 'claude-code/testing'

const BAND = {
  plugin: 'context-card',
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 12,
    bodyColumns: 120,
    scroll: { offset: 0, bodyRows: 12, contentRows: 1 },
    view: {},
  },
} as const

const category = (name: string, tokens: number, color: string, kind: 'used' | 'free' | 'buffer' = 'used') => ({
  name,
  tokens,
  color,
  isDeferred: false,
  kind,
})

test('draws the card and its collapsed line on both surfaces', async ($, on) => {
  let live = { tokens: 145_000, percent: 14 }
  on('session.usage', () => ({
    value: {
      startedAt: 0,
      context: {
        window: 1_000_000,
        tokens: live.tokens,
        percent: live.percent,
        breakdown: {
          categories: [
            category('System prompt', 4_800, 'promptBorder'),
            category('System tools', 28_500, 'inactive'),
            category('MCP tools', 20_100, 'cyan_FOR_SUBAGENTS_ONLY'),
            category('Messages', 74_000, 'purple_FOR_SUBAGENTS_ONLY'),
            category('Free space', 840_000, 'promptBorder', 'free'),
            category('Autocompact buffer', 30_000, 'inactive', 'buffer'),
          ],
          totalTokens: 127_400,
          maxTokens: 1_000_000,
          rawMaxTokens: 1_000_000,
          autocompactSource: 'model',
          percentage: 13,
          gridRows: [],
          model: 'claude-opus-5-5',
          memoryFiles: [],
          mcpTools: [],
          agents: [],
          autoCompactThreshold: 970_000,
          isAutoCompactEnabled: true,
          apiUsage: null,
        },
      },
      rateLimits: [{ kind: 'seven_day', percentUsed: 18, resetsAt: '2026-10-08T01:00:00Z' }],
    },
  }))
  on('session.authorize', () => ({ value: null }))
  let clockNow = Date.parse('2026-10-03T00:30:00Z')
  on('clock.now', () => ({ value: clockNow }))
  on('clock.every', () => ({ value: undefined }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.measure', ($, e) => ({ changed: e.changed }))
  const ran: string[] = []
  on('command.list', () => ({ value: [{ name: 'sessions', description: '', source: 'plugin' }] }))
  on('command.run', ($, e) => {
    ran.push(e.command)
    return {}
  })

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect(await ui.find({ text: /^14%$/ })).toBeDefined()
    expect(await ui.find({ text: /^145k \/ 1M$/ })).toBeDefined()
    expect(await ui.find({ text: /^18%$/ })).toBeDefined()
    expect(await ui.find({ text: /↻ 5d 0h/ })).toBeDefined()
    expect(await ui.find({ text: /^compacts at/ })).toBeUndefined()

    // A click anywhere on the line opens the breakdown, and a second closes it.
    expect(await ui.find({ text: /^messages$/ })).toBeUndefined()
    await ui.press({ key: 'toggle' })
    expect(await ui.find({ text: /^messages$/ })).toBeDefined()
    expect(await ui.find({ text: /auto-compact at 970k/ })).toBeDefined()
    await ui.press({ key: 'toggle' })
    expect(await ui.find({ text: /^messages$/ })).toBeUndefined()

    await ui.press({ key: 'sessions' })
    await ui.unmount()
  }

  // The button counts its presses in state for the sessions pane to act on; it runs no command.
  expect(ran).toEqual([])

  // Mid-turn measurements move the line at once.
  live = { tokens: 300_000, percent: 30 }
  await $.session.measure({ context: { window: 1_000_000, tokens: 300_000, percent: 30 }, rateLimits: [], changed: ['context'] })
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await ui.find({ text: /^30%$/ })).toBeDefined()
  expect(await ui.find({ text: /^300k \/ 1M$/ })).toBeDefined()
  // A response just came back: the cache pie is full.
  expect(await ui.find({ text: /^●$/ })).toBeDefined()
  await ui.unmount()

  // Forty minutes on, over half the cache's hour is gone; past the hour it is cold.
  clockNow += 40 * 60_000
  const later = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await later.find({ text: /^◐$/ })).toBeDefined()
  await later.unmount()
  clockNow += 40 * 60_000
  const cold = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await cold.find({ text: /^○$/ })).toBeDefined()
  await cold.press({ key: 'toggle' })
  expect(await cold.find({ text: /cache cold/ })).toBeDefined()
  await cold.unmount()
})

test('shows the usage another session fetched, and asks the account once when it is stale', async ($, on) => {
  const NOW = Date.parse('2026-10-03T00:30:00Z')
  let file = JSON.stringify({
    at: NOW - 30_000,
    triedAt: NOW - 30_000,
    retryAt: 0,
    limits: [{ kind: 'seven_day', percentUsed: 42, resetsAt: '2026-10-06T03:30:00Z' }],
  })
  let fetches = 0
  let clockNow = NOW

  on('session.usage', () => ({
    value: {
      startedAt: 0,
      context: {
        window: 1_000_000,
        tokens: 145_000,
        percent: 14,
        breakdown: {
          categories: [category('Messages', 145_000, 'purple_FOR_SUBAGENTS_ONLY'), category('Free space', 855_000, 'promptBorder', 'free')],
          totalTokens: 145_000,
          maxTokens: 1_000_000,
          rawMaxTokens: 1_000_000,
          autocompactSource: 'model',
          percentage: 14,
          gridRows: [],
          model: 'claude-opus-5-5',
          memoryFiles: [],
          mcpTools: [],
          agents: [],
          autoCompactThreshold: 970_000,
          isAutoCompactEnabled: true,
          apiUsage: null,
        },
      },
      rateLimits: [{ kind: 'seven_day', percentUsed: 18, resetsAt: '2026-10-08T01:00:00Z' }],
    },
  }))
  on('env.get', () => ({ value: '/home/me' }))
  on('fs.read', () => ({ value: file }))
  on('fs.write', ($, e) => {
    file = e.text
    return { value: undefined }
  })
  on('session.authorize', () => ({ value: { handle: 'h' } }))
  on('http.fetch', () => {
    fetches += 1
    return { value: { ok: true, status: 200, text: JSON.stringify({ seven_day: { utilization: 55, resets_at: '2026-10-06T03:30:00Z' } }) } }
  })
  on('clock.now', () => ({ value: clockNow }))
  on('clock.every', () => ({ value: undefined }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.list', () => ({ value: [] }))

  // Another session fetched 30 seconds ago: its figure and reset time are shown, and nothing is requested.
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await ui.find({ text: /^42%$/ })).toBeDefined()
  expect(await ui.find({ text: /^↻ 3d 3h$/ })).toBeDefined()
  expect(fetches).toBe(0)
  await ui.unmount()

  // Three minutes on the shared figure is stale: this session asks, and the answer goes back into the file.
  clockNow += 180_000
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const later = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await later.find({ text: /^55%$/ })).toBeDefined()
  expect(fetches).toBe(1)
  expect(JSON.parse(file).limits[0].percentUsed).toBe(55)
  await later.unmount()
})

test('takes the cache lifetime from what the session recorded', async ($, on) => {
  const written = (lifetime: '5m' | '1h') =>
    JSON.stringify({ message: { usage: { cache_creation: { [`ephemeral_${lifetime}_input_tokens`]: 1_200 } } } })
  // The tail starts mid-line, and the newest response only read the cache.
  let record = ['"cut": true}', written('5m'), JSON.stringify({ message: { usage: { cache_creation: {} } } })].join('\n')
  let clockNow = Date.parse('2026-10-03T00:30:00Z')

  on('session.usage', () => ({
    value: {
      startedAt: 0,
      context: {
        window: 1_000_000,
        tokens: 145_000,
        percent: 14,
        breakdown: {
          categories: [category('Messages', 145_000, 'purple_FOR_SUBAGENTS_ONLY'), category('Free space', 855_000, 'promptBorder', 'free')],
          totalTokens: 145_000,
          maxTokens: 1_000_000,
          rawMaxTokens: 1_000_000,
          autocompactSource: 'model',
          percentage: 14,
          gridRows: [],
          model: 'claude-opus-5-5',
          memoryFiles: [],
          mcpTools: [],
          agents: [],
          autoCompactThreshold: 970_000,
          isAutoCompactEnabled: true,
          apiUsage: null,
        },
      },
      rateLimits: [],
    },
  }))
  on('session.authorize', () => ({ value: null }))
  on('process.run', ($, e) => {
    expect(e.argv.at(-1)).toBe('/home/me/atlas.jsonl')

    return { value: { exitCode: 0, stdout: record, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('clock.now', () => ({ value: clockNow }))
  on('clock.every', () => ({ value: undefined }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.measure', ($, e) => ({ changed: e.changed }))
  on('command.list', () => ({ value: [] }))
  on('classic.Stop', () => ({}))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.session.measure({ context: { window: 1_000_000, tokens: 145_000, percent: 14 }, rateLimits: [], changed: ['context'] })
  await $.classic.Stop({ stop_hook_active: false, transcript_path: '/home/me/atlas.jsonl' })

  // Written for five minutes: three minutes on it is past half, and after six it is cold.
  clockNow += 3 * 60_000
  const half = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await half.find({ text: /^◐$/ })).toBeDefined()
  await half.unmount()
  clockNow += 3 * 60_000
  const cold = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await cold.find({ text: /^○$/ })).toBeDefined()
  await cold.unmount()

  // The next turn wrote for an hour: six minutes after it the cache is still fresh.
  record = written('1h')
  await $.session.measure({ context: { window: 1_000_000, tokens: 150_000, percent: 15 }, rateLimits: [], changed: ['context'] })
  await $.classic.Stop({ stop_hook_active: false, transcript_path: '/home/me/atlas.jsonl' })
  clockNow += 6 * 60_000
  const fresh = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await fresh.find({ text: /^●$/ })).toBeDefined()
  await fresh.unmount()
})
