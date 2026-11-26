import { expect, test } from 'claude-code/testing'

const BAND = {
  plugin: 'context-card',
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isCollapsed: false,
    isWorking: false,
    maxRows: 12,
    bodyColumns: 120,
    scroll: { offset: 0, bodyRows: 12, contentRows: 1 },
    view: {},
  },
} as const

const category = (name: string, tokens: number, color: string, kind: 'used' | 'free' | 'buffer' | 'deferred' = 'used') => ({
  name,
  tokens,
  color,
  isDeferred: false,
  kind,
})

// A session's usage: `tokens` in a window of `window`, the compaction window being `rawMaxTokens`.
const usage = (o: { tokens: number; percent: number; window?: number; rawMaxTokens?: number; threshold?: number; limits?: { kind: string; percentUsed: number; resetsAt?: string }[] }) => ({
  value: {
    startedAt: 0,
    context: {
      window: o.window ?? 1_000_000,
      tokens: o.tokens,
      percent: o.percent,
      breakdown: {
        categories: [category('Messages', o.tokens, 'purple_FOR_SUBAGENTS_ONLY'), category('Free space', 100_000, 'promptBorder', 'free')],
        totalTokens: o.tokens,
        maxTokens: o.rawMaxTokens ?? 1_000_000,
        rawMaxTokens: o.rawMaxTokens ?? 1_000_000,
        autocompactSource: 'model-default' as const,
        percentage: Math.round((o.tokens / (o.rawMaxTokens ?? 1_000_000)) * 100),
        gridRows: [],
        model: 'claude-opus-5-5',
        memoryFiles: [],
        mcpTools: [],
        agents: [],
        autoCompactThreshold: o.threshold ?? 970_000,
        isAutoCompactEnabled: true,
        apiUsage: null,
      },
    },
    rateLimits: o.limits ?? [],
  },
})

test('draws the line on both surfaces: percent, used of the window, the window control, the knob and weekly', async ($, on) => {
  let live = { tokens: 145_000, percent: 14 }
  on('session.usage', () => usage({ ...live, limits: [{ kind: 'seven_day', percentUsed: 18, resetsAt: '2026-10-08T01:00:00Z' }] }))
  on('session.authorize', () => ({ value: null }))
  on('clock.now', () => ({ value: Date.parse('2026-10-03T00:30:00Z') }))
  on('clock.every', () => ({ value: undefined }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.measure', ($, e) => ({ changed: e.changed }))
  on('command.list', () => ({ value: [] }))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  // A response reports the windows; what the session held before it was of unknown age and was not shown.
  await $.session.measure({
    context: { window: 1_000_000, tokens: 145_000, percent: 14 },
    rateLimits: [{ kind: 'seven_day', percentUsed: 18, resetsAt: '2026-10-08T01:00:00Z' }],
    changed: ['rateLimits'],
  })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect(await ui.find({ text: /^14%$/ })).toBeDefined()
    // No window is saved: the model's own (Auto) is in force, so its number is written beside the control.
    expect(await ui.find({ text: /^145k \/ 1M$/ })).toBeDefined()
    expect(await ui.find({ key: 'window' })).toBeDefined()
    expect(await ui.find({ key: 'knob' })).toBeDefined()
    expect(await ui.find({ text: /^weekly$/ })).toBeDefined()
    expect(await ui.find({ text: /^18%$/ })).toBeDefined()
    expect(await ui.find({ text: /↻ 5d 0h/ })).toBeDefined()
    // No panel, no repeated figures, no cache mark, no PRs button.
    expect(await ui.find({ key: 'toggle' })).toBeUndefined()
    expect(await ui.find({ text: /compacts at|cache|^PRs$|^[●◐○]$/ })).toBeUndefined()
    await ui.unmount()
  }

  // Mid-turn measurements move the line at once.
  live = { tokens: 300_000, percent: 30 }
  await $.session.measure({ context: { window: 1_000_000, tokens: 300_000, percent: 30 }, rateLimits: [], changed: ['context'] })
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await ui.find({ text: /^30%$/ })).toBeDefined()
  expect(await ui.find({ text: /^300k \/ 1M$/ })).toBeDefined()
  await ui.unmount()
})

test('measures against the compaction window, as /context does, and the window menu runs the official commands', async ($, on) => {
  // A 1M model whose saved window, 500k, the engine raised to 600k for this conversation: /context reads 516.4k
  // of 600k as 86%, not 52% of 1M.
  let live = { tokens: 516_400, percent: 52 }
  on('session.usage', () => usage({ ...live, rawMaxTokens: 600_000, threshold: 567_000 }))
  on('session.authorize', () => ({ value: null }))
  on('clock.now', () => ({ value: Date.parse('2026-10-03T00:30:00Z') }))
  on('clock.every', () => ({ value: undefined }))
  on('clock.after', () => ({ deny: 'held' }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.measure', ($, e) => ({ changed: e.changed }))
  on('command.list', () => ({ value: [] }))
  // What /autocompact 500k saved for the model.
  on('settings.read', () => ({ value: { modelSettings: { 'claude-opus-5-5': { autoCompactWindow: 500_000 } } } }))
  const ran: string[] = []
  on('command.run', ($, e) => {
    ran.push(`${e.command} ${e.args}`.trim())
    return {}
  })
  const set: unknown[] = []
  on('config.set', ($, e) => {
    set.push([e.key, e.value])
    return { value: e.value }
  })

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await ui.find({ text: /^86%$/ })).toBeDefined()
  // The window in force is not the one picked, so its number is written out.
  expect(await ui.find({ text: /^516\.4k \/ 600k$/ })).toBeDefined()
  await ui.unmount()

  // A mid-turn measurement carries the model's window; the line keeps measuring against the compaction window.
  live = { tokens: 540_000, percent: 54 }
  await $.session.measure({ context: { window: 1_000_000, tokens: 540_000, percent: 54 }, rateLimits: [], changed: ['context'] })
  const later = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await later.find({ text: /^90%$/ })).toBeDefined()
  expect(await later.find({ text: /^540k \/ 600k$/ })).toBeDefined()

  // The window already chosen, reported again by a redraw, runs nothing. Another window saves it with /autocompact;
  // Off turns /config's auto-compact off; at 90% one press on the knob compacts.
  await later.select({ key: 'window', value: '500k' })
  expect(ran).toEqual([])
  await later.select({ key: 'window', value: '400k' })
  await later.select({ key: 'window', value: 'off' })
  await later.press({ key: 'knob' })
  await later.unmount()
  expect(ran).toEqual(['autocompact 400k', 'compact'])
  expect(set).toEqual([['autoCompact', false]])
})

test('below 60% the knob asks once: the first press arms it, the second compacts', async ($, on) => {
  on('session.usage', () => usage({ tokens: 159_500, percent: 16, rawMaxTokens: 500_000, threshold: 467_000 }))
  on('session.authorize', () => ({ value: null }))
  let clockNow = Date.parse('2026-10-03T00:30:00Z')
  on('clock.now', () => ({ value: clockNow }))
  on('clock.every', () => ({ value: undefined }))
  // The timers are held, so the knob stays armed until pressed.
  on('clock.after', () => ({ deny: 'held' }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.list', () => ({ value: [] }))
  on('settings.read', () => ({ value: { modelSettings: { 'claude-opus-5-5': { autoCompactWindow: 500_000 } } } }))
  const ran: string[] = []
  on('command.run', ($, e) => {
    ran.push(`${e.command} ${e.args}`.trim())
    return {}
  })

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' })
  // The saved 500k is the window in force: the control alone is the denominator.
  expect(await ui.find({ text: /^159\.5k \/$/ })).toBeDefined()
  expect(await ui.find({ text: /^⤡$/ })).toBeDefined()

  await ui.press({ key: 'knob' })
  expect(ran).toEqual([])
  expect(await ui.find({ text: /^✓$/ })).toBeDefined()

  clockNow += 1_000
  await ui.press({ key: 'knob' })
  expect(ran).toEqual(['compact'])
  // Busy until the compaction reports back; a press meanwhile does nothing.
  expect(await ui.find({ text: /^◐$/ })).toBeDefined()
  await ui.press({ key: 'knob' })
  expect(ran).toEqual(['compact'])
  await ui.unmount()
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

  on('session.usage', () => usage({ tokens: 145_000, percent: 14, limits: [{ kind: 'seven_day', percentUsed: 18, resetsAt: '2026-10-08T01:00:00Z' }] }))
  on('env.get', () => ({ value: '/home/me' }))
  on('fs.read', () => ({ value: file }))
  on('fs.write', ($, e) => {
    file = e.text
    return { value: undefined }
  })
  on('session.authorize', () => ({ value: { handle: 'h', kind: 'bearer' } }))
  on('http.fetch', () => {
    fetches += 1
    return { value: { ok: true, status: 200, headers: {}, text: JSON.stringify({ seven_day: { utilization: 55, resets_at: '2026-10-06T03:30:00Z' } }) } }
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

  // Eleven minutes on, no session has brought a reading: this one asks, and the answer goes back into the file.
  clockNow += 11 * 60_000
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const later = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await later.find({ text: /^55%$/ })).toBeDefined()
  expect(fetches).toBe(1)
  expect(JSON.parse(file).limits[0].percentUsed).toBe(55)
  await later.unmount()
})

test('a reading any session brings reaches the file, and a refusal waits as long as it asks', async ($, on) => {
  const NOW = Date.parse('2026-10-03T00:30:00Z')
  // Another session last read the account 22 hours ago, and the latest request was refused.
  let file = JSON.stringify({
    at: NOW - 22 * 3_600_000,
    triedAt: NOW - 400_000,
    retryAt: NOW - 100_000,
    status: 429,
    limits: [{ kind: 'seven_day', percentUsed: 5, resetsAt: '2026-10-06T03:30:00Z' }],
  })
  let fetches = 0
  let clockNow = NOW

  on('session.usage', () => usage({ tokens: 145_000, percent: 14 }))
  on('env.get', () => ({ value: '/home/me' }))
  on('fs.read', () => ({ value: file }))
  on('fs.write', ($, e) => {
    file = e.text
    return { value: undefined }
  })
  on('session.authorize', () => ({ value: { handle: 'h', kind: 'bearer' } }))
  on('http.fetch', () => {
    fetches += 1
    return { value: { ok: false, status: 429, headers: { 'retry-after': '3600' }, text: '' } }
  })
  on('clock.now', () => ({ value: clockNow }))
  on('clock.every', () => ({ value: undefined }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.measure', ($, e) => ({ changed: e.changed }))
  on('command.list', () => ({ value: [] }))

  // No reading anywhere newer than 22 hours: the account is asked once, refused for an hour, and every session
  // waits the hour. The old figure is drawn dim, and the line says how old it is and why.
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  expect(fetches).toBe(1)
  expect(JSON.parse(file).retryAt).toBe(NOW + 3_600_000)
  expect(JSON.parse(file).status).toBe(429)
  const stale = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await stale.find({ text: /^5%$/ })).toBeDefined()
  expect(await stale.find({ text: /^· read 22h ago \(refused 429\)$/ })).toBeDefined()
  await stale.unmount()

  // A response reports the windows: the reading goes into the file for every session, and is drawn at full color.
  const reading = [{ kind: 'seven_day', percentUsed: 31, resetsAt: '2026-10-06T03:30:00Z' }]
  await $.session.measure({ context: { window: 1_000_000, tokens: 145_000, percent: 14 }, rateLimits: reading, changed: ['rateLimits'] })
  expect(JSON.parse(file).at).toBe(NOW)
  expect(JSON.parse(file).limits[0].percentUsed).toBe(31)
  const fresh = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await fresh.find({ text: /^31%$/ })).toBeDefined()
  expect(await fresh.find({ text: /read .* ago/ })).toBeUndefined()
  await fresh.unmount()

  // Another session's newer reading, written to the file, is what this one shows next.
  file = JSON.stringify({ ...JSON.parse(file), at: NOW + 60_000, limits: [{ ...reading[0], percentUsed: 33 }] })
  clockNow += 60_000
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  expect(fetches).toBe(1)
  const synced = await $.ui.mount({ ...BAND, surface: 'desktop' })
  expect(await synced.find({ text: /^33%$/ })).toBeDefined()
  await synced.unmount()
})
