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
