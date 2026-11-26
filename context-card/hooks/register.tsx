import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionRateLimit } from 'claude-code'

import type { Card, Knob, Limit } from '../types'

const card = atom({ plugin: 'context-card', key: 'card' } as const, null)
// The terminal's bar, in cells; the desktop draws it as an SVG.
const LINE_CELLS = 14

const LOCAL_MS = 15_000

// The compact knob at the bar's end. Below ARM_PERCENT the first press only arms it, for ARM_MS, and a second
// press compacts; from ARM_PERCENT one press compacts. While a compaction runs it is marked busy.
const IDLE: Knob = { state: 'idle', since: 0, tick: 0 }
const knob = atom({ plugin: 'context-card', key: 'knob' } as const, IDLE)
const ARM_MS = 3_000
const ARM_PERCENT = 60
// A compaction that never reports back stops being drawn as one after this long.
const COMPACT_GIVE_UP_MS = 600_000

const LIMIT_ORDER = ['seven_day']

const compact = (tokens: number) => {
  if (tokens < 1000) {
    return String(tokens)
  }

  const [value, unit] = tokens < 999_950 ? [tokens / 1000, 'k'] : [tokens / 1_000_000, 'M']

  return `${value.toFixed(1).replace(/\.0$/, '')}${unit}`
}

// Each figure has its own theme hue, so the two percentages never read alike; near a cap the hue gives way to
// warning or error. Theme keys resolve per theme: claude is terracotta and suggestion is blue in light, dark and
// ANSI themes alike, each legible on its background.
const fillColor = (percent: number) => (percent >= 80 ? 'error' : percent >= 60 ? 'warning' : 'claude')
const limitColor = (percent: number) => (percent >= 90 ? 'error' : percent >= 75 ? 'warning' : 'suggestion')

const resetsIn = (resetsAt: string | undefined, now: number) => {
  if (resetsAt === undefined) {
    return ''
  }

  const minutes = Math.max(0, Math.round((Date.parse(resetsAt) - now) / 60_000))

  if (minutes >= 1440) {
    return `${Math.floor(minutes / 1440)}d ${Math.floor((minutes % 1440) / 60)}h`
  }

  return minutes >= 60 ? `${Math.floor(minutes / 60)}h ${minutes % 60}m` : `${minutes}m`
}

const age = (ms: number) => {
  const minutes = Math.max(1, Math.round(ms / 60_000))

  return minutes >= 1440 ? `${Math.floor(minutes / 1440)}d` : minutes >= 60 ? `${Math.floor(minutes / 60)}h` : `${minutes}m`
}

const toLimits = (limits: SessionRateLimit[]): Limit[] =>
  limits
    .filter(({ kind }) => LIMIT_ORDER.includes(kind))
    .map(({ kind, percentUsed, resetsAt }) => ({ kind, percentUsed, resetsAt }))
    .sort((a, b) => LIMIT_ORDER.indexOf(a.kind) - LIMIT_ORDER.indexOf(b.kind))

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'
const POLL_MS = 60_000

// The newest weekly reading any session has, kept in one file every session reads, so they all show the same
// figure. A reading comes from a session's own API responses, free, or failing those from asking the account, once
// for all sessions. `status` is the refusal since the account last answered, if any.
type Shared = { at: number; triedAt: number; retryAt: number; status: number | null; limits: Limit[] }

// The account is asked only when no session has brought a reading for this long: weekly moves slowly.
const SHARE_MS = 600_000
const BACKOFF_MS = 300_000
const CLAIM_MS = 20_000
// Past this the account-wide figure gives way to the session's own reading, and is drawn dim if nothing newer exists.
const STALE_MS = 900_000

const EMPTY: Shared = { at: 0, triedAt: 0, retryAt: 0, status: null, limits: [] }

// The last shared file this session read or wrote.
let lastShared: Shared = EMPTY

const pickLimits = () => ({ limits: lastShared.limits, limitsAt: lastShared.at, refusedStatus: lastShared.status })

const showLimits = async ($: EngineInterface) => {
  await update($, card, was => (was === null ? was : { ...was, ...pickLimits() }))
}

const sharedPath = async ($: EngineInterface) => {
  // Windows has no HOME by default; USERPROFILE is its equivalent.
  const home = (await $.env.get('HOME').catch(() => undefined)) || (await $.env.get('USERPROFILE').catch(() => undefined))

  return typeof home === 'string' && home !== '' ? `${home}/.claude/cache/context-card-usage.json` : null
}

const readShared = async ($: EngineInterface, path: string | null): Promise<Shared | null> => {
  if (path === null) {
    return null
  }

  try {
    const found = JSON.parse(await $.fs.read(path)) as Partial<Shared>

    return {
      at: Number(found.at) || 0,
      triedAt: Number(found.triedAt) || 0,
      retryAt: Number(found.retryAt) || 0,
      status: typeof found.status === 'number' ? found.status : null,
      limits: Array.isArray(found.limits) ? found.limits : [],
    }
  } catch {
    return null
  }
}

const writeShared = async ($: EngineInterface, path: string | null, value: Shared) => {
  lastShared = value

  if (path !== null) {
    await $.fs.write(path, JSON.stringify(value)).catch(() => undefined)
  }
}

// How long a refusal asks to be left alone: Retry-After in seconds or as a date, never less than the backoff.
const waitFor = (retryAfter: string | undefined, now: number) => {
  const seconds = Number(retryAfter)
  const asked = Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : Date.parse(retryAfter ?? '') - now

  return Math.max(BACKOFF_MS, Number.isFinite(asked) ? asked : 0)
}

// Account-wide plan usage, as the app's usage card reads it; covers every session, not just this one.
// Each session calls this on its own timer, but only one of them sends the request: the rest read its result.
const poll = async ($: EngineInterface) => {
  const path = await sharedPath($)
  const now = await $.clock.now()
  const shared = (await readShared($, path)) ?? lastShared

  lastShared = shared
  await showLimits($)

  // Fresh enough, told to wait after a refusal, or another session is asking right now.
  if (now - shared.at < SHARE_MS || now < shared.retryAt || now - shared.triedAt < CLAIM_MS) {
    return
  }

  const auth = await $.session.authorize()

  if (auth === null) {
    return
  }

  await writeShared($, path, { ...shared, triedAt: now })
  const response = await $.http.fetch(USAGE_URL, {
    headers: { 'anthropic-beta': 'oauth-2025-04-20' },
    auth: auth.handle,
  })

  if (!response.ok) {
    // Refused (rate limited, usually): every session waits as long as it was asked before any of them asks again.
    // Read again first, so a reading another session wrote while this one waited is kept.
    await writeShared($, path, {
      ...((await readShared($, path)) ?? shared),
      triedAt: now,
      retryAt: now + waitFor(response.headers?.['retry-after'], now),
      status: response.status,
    })
    await showLimits($)

    return
  }

  const body = JSON.parse(response.text) as Record<string, { utilization?: unknown; resets_at?: unknown } | null>
  const limits: Limit[] = LIMIT_ORDER.flatMap(kind => {
    const window = body[kind]

    return window && typeof window.utilization === 'number'
      ? [{ kind, percentUsed: window.utilization, resetsAt: typeof window.resets_at === 'string' ? window.resets_at : undefined }]
      : []
  })

  if (limits.length === 0) {
    return
  }

  await writeShared($, path, { at: now, triedAt: now, retryAt: 0, status: null, limits })
  await showLimits($)
}

// Puts the windows a response just reported into the shared file, for every session to show. Only one that just
// came back: a session's first look holds whatever its last response said, which a resumed session may have had
// for a day, and stamping that as now would pass it off as fresh.
const shareHeaders = async ($: EngineInterface, rateLimits: SessionRateLimit[]) => {
  const limits = toLimits(rateLimits)

  if (limits.length === 0) {
    return
  }

  const path = await sharedPath($)
  const now = await $.clock.now()
  const shared = (await readShared($, path)) ?? lastShared

  await writeShared($, path, { ...shared, at: now, limits })
}

const percentOf = (tokens: number, window: number) => Math.round((tokens / Math.max(window, 1)) * 100)

// The auto-compact windows the window menu offers, as /autocompact takes them; `auto` is the window tuned for the
// model. Off, last as the rare pick, turns auto-compaction off.
const WINDOWS: { args: string; label: string; tokens: number | 'auto' }[] = [
  { args: '400k', label: '400k', tokens: 400_000 },
  { args: '500k', label: '500k', tokens: 500_000 },
  { args: '600k', label: '600k', tokens: 600_000 },
  { args: 'auto', label: 'Auto', tokens: 'auto' },
]

// The window /autocompact saved for this model (`modelSettings.<model>.autoCompactWindow`, keyed by the canonical
// name, which the breakdown's dated or [1m] spelling contains), else the top-level one; null when neither is set.
const savedWindow = async ($: EngineInterface, model: string): Promise<number | 'auto' | null> => {
  const asWindow = (value: unknown) => (value === 'auto' || typeof value === 'number' ? value : null)
  const perModel = (await $.settings.read({ key: 'modelSettings' }).catch(() => undefined)) as
    | Record<string, { autoCompactWindow?: unknown } | undefined>
    | undefined
  const name = model.toLowerCase()
  const own = Object.entries(perModel ?? {}).find(([key]) => key !== '' && name.includes(key.toLowerCase()))?.[1]

  return asWindow(own?.autoCompactWindow) ?? asWindow(await $.settings.read({ key: 'autoCompactWindow' }).catch(() => undefined))
}

// The controls go through the official /config row and slash commands, so they keep doing what those do.
const setAutoCompact = async ($: EngineInterface, isOn: boolean) => {
  const result = await $.config.set({ key: 'autoCompact', value: isOn }).catch((error: unknown) => ({ deny: String(error) }))

  if (result.deny !== undefined) {
    $.ui.toast(`Auto-compact unchanged: ${result.deny}`)
  }

  await refresh($)
}

const runCommand = async ($: EngineInterface, command: string, args?: string) => {
  try {
    await $.command.run({ command, args })
  } catch (error) {
    $.ui.toast(`/${command} did not run: ${String(error)}`)
    await refresh($)

    return false
  }

  await refresh($)

  return true
}

// A pick from the window menu: Off turns auto-compaction off; a window turns it back on if it was off, then saves
// the window with /autocompact. `saved` is a window saved outside the presets, already in force.
// The desktop's native dropdown can report its own value again when the line redraws (it did after a compaction,
// running /autocompact twice): a pick of what is already chosen changes nothing and runs nothing.
const pickWindow = async ($: EngineInterface, value: string, choice: string, isAutoCompact: boolean) => {
  if (value === choice) {
    return
  }

  if (value === 'off') {
    await setAutoCompact($, false)

    return
  }

  if (!isAutoCompact) {
    await setAutoCompact($, true)
  }

  if (value !== 'saved') {
    await runCommand($, 'autocompact', value)
  }
}

const compactNow = async ($: EngineInterface) => {
  const since = await $.clock.now()
  await update($, knob, () => ({ state: 'compacting', since, tick: 0 }))
  $.clock.after(COMPACT_GIVE_UP_MS, () => void update($, knob, was => (was.state === 'compacting' && was.since === since ? IDLE : was)))

  if (!(await runCommand($, 'compact'))) {
    await update($, knob, () => IDLE)
  }
}

const pressKnob = async ($: EngineInterface) => {
  const was = await read($, knob)
  const percent = (await read($, card))?.percent ?? 0

  if (was.state === 'compacting') {
    return
  }

  if (was.state === 'armed' || percent >= ARM_PERCENT) {
    await compactNow($)

    return
  }

  // Armed: the ring around the check drains over ARM_MS, redrawn a few times a second, then the knob folds back.
  const since = await $.clock.now()
  await update($, knob, () => ({ state: 'armed', since, tick: 0 }))
  const drain = $.clock.every(250, () => void update($, knob, k => (k.state === 'armed' && k.since === since ? { ...k, tick: k.tick + 1 } : k)))
  $.clock.after(ARM_MS, () => {
    drain.cancel()
    void update($, knob, k => (k.state === 'armed' && k.since === since ? IDLE : k))
  })
}

// SVG has no theme keys: these hues read on light and dark alike, close to the theme's claude, warning, error and
// suggestion, and the greys carry their own alpha so they sit on either background.
const HUE = { claude: '#D97757', warning: '#E0A030', error: '#E5484D', suggestion: '#6B8AFD' }
const TRACK = '#8884'
const DIM = '#888C'
const ON_ACCENT = '#FFFFFF'
const hueOf = (percent: number) => (percent >= 80 ? HUE.error : percent >= ARM_PERCENT ? HUE.warning : HUE.claude)
const weeklyHue = (percent: number) => (percent >= 90 ? HUE.error : percent >= 75 ? HUE.warning : HUE.suggestion)
const svg = (width: number, height: number, body: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${body}</svg>`
const clamp = (share: number) => Math.min(Math.max(share, 0), 1)
const arc = (r: number, share: number) => {
  const length = 2 * Math.PI * r

  return `stroke-dasharray="${(length * clamp(share)).toFixed(2)} ${length.toFixed(2)}"`
}

const BAR_HEIGHT = 10
const barSource = (width: number, percent: number, isBusy: boolean) => {
  const fill = Math.max(2, Math.round(width * clamp(percent / 100)))

  return svg(
    width,
    BAR_HEIGHT,
    `<rect y="2" width="${width}" height="6" rx="3" fill="${TRACK}"/><rect y="2" width="${fill}" height="6" rx="3" fill="${isBusy ? DIM : hueOf(percent)}"/>`,
  )
}

const KNOB = 20
const COMPRESS = 'M4 14h6v6M20 10h-6V4M14 10l7-7M3 21l7-7'
const knobSource = (state: Knob['state'], percent: number, left: number) => {
  if (state === 'armed') {
    return svg(
      KNOB,
      KNOB,
      `<circle cx="10" cy="10" r="10" fill="${HUE.claude}"/>` +
        `<circle cx="10" cy="10" r="8.2" fill="none" stroke="${ON_ACCENT}" stroke-opacity="0.35" stroke-width="1.6"/>` +
        `<circle cx="10" cy="10" r="8.2" fill="none" stroke="${ON_ACCENT}" stroke-width="1.6" stroke-linecap="round" ${arc(8.2, left)} transform="rotate(-90 10 10)"/>` +
        `<path d="M6.6 10.3l2.3 2.3 4.5-4.9" fill="none" stroke="${ON_ACCENT}" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/>`,
    )
  }

  if (state === 'compacting') {
    return svg(
      KNOB,
      KNOB,
      `<circle cx="10" cy="10" r="10" fill="${TRACK}"/><circle cx="10" cy="10" r="4.8" fill="none" stroke="${DIM}" stroke-width="1.5"/><path d="M10 5.2a4.8 4.8 0 0 1 0 9.6z" fill="${DIM}"/>`,
    )
  }

  // Track grey with a dim icon while there is room; the icon in the fill's hue from 60%; filled from 80%.
  const isHot = percent >= 80
  const icon = isHot ? ON_ACCENT : percent >= ARM_PERCENT ? hueOf(percent) : DIM

  return svg(
    KNOB,
    KNOB,
    `<circle cx="10" cy="10" r="10" fill="${isHot ? hueOf(percent) : TRACK}"/>` +
      `<g transform="translate(4 4) scale(0.5)"><path d="${COMPRESS}" fill="none" stroke="${icon}" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></g>`,
  )
}

// Weekly pace: the outer ring is the plan used, the inner ring how much of the week has gone. Outer ahead of
// inner means spending faster than the week runs. Every figure is still written out beside it.
const WEEK_MS = 7 * 86_400_000
const ringSource = (usedShare: number, weekShare: number, hue: string) =>
  svg(
    16,
    16,
    `<circle cx="8" cy="8" r="6.9" fill="none" stroke="${TRACK}" stroke-width="2"/>` +
      `<circle cx="8" cy="8" r="6.9" fill="none" stroke="${hue}" stroke-width="2" stroke-linecap="round" ${arc(6.9, usedShare)} transform="rotate(-90 8 8)"/>` +
      `<circle cx="8" cy="8" r="3.2" fill="none" stroke="${TRACK}" stroke-width="1.8"/>` +
      `<circle cx="8" cy="8" r="3.2" fill="none" stroke="${DIM}" stroke-width="1.8" ${arc(3.2, weekShare)} transform="rotate(-90 8 8)"/>`,
  )

const refresh = async ($: EngineInterface, afterReply = false) => {
  const { context, rateLimits } = await $.session.usage({ breakdown: 'summary' })
  const breakdown = context.breakdown

  if (afterReply) {
    await shareHeaders($, rateLimits)
  }

  if (breakdown === undefined) {
    return
  }

  // Measured as /context measures: against the compaction window, which a model's `autoCompactWindow` setting or
  // /autocompact can set below the model's own window (`context.window`).
  const window = breakdown.rawMaxTokens
  // The last response's own count where there is one, as /context reconciles its rows to it; else its estimate.
  const tokens = context.tokens ?? breakdown.totalTokens
  const saved = await savedWindow($, breakdown.model)

  await update($, card, () => ({
    tokens,
    window,
    percent: context.tokens === undefined ? breakdown.percentage : percentOf(tokens, window),
    compactsAt: breakdown.isAutoCompactEnabled ? (breakdown.autoCompactThreshold ?? null) : null,
    isAutoCompact: breakdown.isAutoCompactEnabled,
    savedWindow: saved,
    ...pickLimits(),
  }))
}

export const register: Register = on => {
  let ticker: { cancel: () => void } | null = null
  let localTicker: { cancel: () => void } | null = null

  on('session.start', async ($, e, next) => {
    // A knob left armed or busy by an earlier load has no timer behind it any more.
    await update($, knob, () => IDLE)
    await refresh($)
    await poll($).catch(() => {})
    ticker?.cancel()
    ticker = $.clock.every(POLL_MS, () => poll($).catch(() => {}))
    // The figures are a local estimate: refreshing them sends no request.
    localTicker?.cancel()
    localTicker = $.clock.every(LOCAL_MS, () => void refresh($))

    return next(e)
  })

  on('session.end', ($, e, next) => {
    ticker?.cancel()
    localTicker?.cancel()
    ticker = null
    localTicker = null

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) {
      await refresh($, true)
      await poll($).catch(() => {})
    }

    return next(e)
  })

  // Any compaction of the main conversation, the knob's, the person's /compact or the engine's own, shows on the
  // knob while it runs; a precompute installs nothing and is not shown.
  on('session.compact', async ($, e, next) => {
    const isShown = e.trigger !== 'precompute' && e.agentId === undefined

    if (isShown) {
      const since = await $.clock.now()
      await update($, knob, was => (was.state === 'compacting' ? was : ({ state: 'compacting', since, tick: 0 }) as const))
    }

    try {
      return await next(e)
    } finally {
      if (isShown) {
        await update($, knob, () => IDLE)
      }

      await refresh($)
    }
  })

  on('session.measure', async ($, e, next) => {
    // The fill moves mid-turn: follow it at once, keeping the last window until the next refresh. The window here
    // is the model's, not the compaction window /context measures against.
    const { tokens } = e.context

    if (e.changed.includes('context') && tokens !== undefined) {
      await update($, card, was => (was === null ? was : { ...was, tokens, percent: percentOf(tokens, was.window) }))
    }

    if (e.changed.includes('rateLimits')) {
      await shareHeaders($, e.rateLimits)
      await showLimits($)
    }

    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const now = await read($, card)

    if (e.props.hasSurvey || now === null) {
      return next(e)
    }

    const table = $.ui.resolve(e)
    const { Box, Button, Select, Text } = table
    // The terminal has no Svg: it draws the bar in cells and the knob as a glyph.
    const Svg = e.surface !== 'terminal' && 'Svg' in table ? table.Svg : null
    const clock = await $.clock.now()
    const isNarrow = (e.props.bodyColumns ?? 100) < 64
    const pctColor = fillColor(now.percent)
    const k = await read($, knob)

    // The denominator is the window control. Its number is written out beside it only when the window in force is
    // not the one picked: Auto, Off, or a window the engine raised for this conversation.
    // A card stored before these fields existed reads as the engine's defaults until the next refresh.
    const isAutoCompact = now.isAutoCompact ?? now.compactsAt !== null
    const saved = now.savedWindow ?? null
    const preset = WINDOWS.find(option => option.tokens === saved)
    const choice = !isAutoCompact ? 'off' : saved === null || saved === 'auto' ? 'auto' : (preset?.args ?? 'saved')
    const options = [
      ...(choice === 'saved' && typeof saved === 'number' ? [{ value: 'saved', label: compact(saved) }] : []),
      ...WINDOWS.map(option => ({ value: option.args, label: option.label })),
      { value: 'off', label: 'Off' },
    ]
    const isWindowPicked = typeof saved === 'number' && isAutoCompact && saved === now.window
    const used = isWindowPicked ? `${compact(now.tokens)} /` : `${compact(now.tokens)} / ${compact(now.window)}`

    const weekly = now.limits.find(limit => limit.kind === 'seven_day')
    // Nothing newer has come in for a while: the figure is drawn dim, with how old it is and why.
    const isWeeklyStale = now.limitsAt > 0 && clock - now.limitsAt > STALE_MS
    const weekGone = weekly?.resetsAt === undefined ? 0 : 1 - (Date.parse(weekly.resetsAt) - clock) / WEEK_MS
    const left = k.state === 'armed' ? 1 - (clock - k.since) / ARM_MS : 0
    const knobLabel = k.state === 'armed' ? 'Click again to compact' : k.state === 'compacting' ? 'Compacting' : 'Compact now'
    const barWidth = isNarrow ? 72 : 120
    const cells = isNarrow ? 8 : LINE_CELLS
    const filled = Math.min(cells, Math.round((now.percent / 100) * cells))

    return (
      <Box flexDirection="row" alignItems="center" columnGap={2}>
        <Text bold color={pctColor}>{`${now.percent}%`}</Text>
        <Box flexDirection="row" alignItems="center" columnGap={1} flexShrink={0}>
          {isNarrow && isWindowPicked ? null : <Text dimColor>{isNarrow ? `/ ${compact(now.window)}` : used}</Text>}
          <Select key="window" options={options} value={choice} onSelect={value => void pickWindow($, value, choice, isAutoCompact)} />
        </Box>
        <Box flexDirection="row" alignItems="center" flexShrink={0}>
          {Svg === null ? (
            <Text>
              <Text color={k.state === 'compacting' ? undefined : pctColor} dimColor={k.state === 'compacting'}>
                {'━'.repeat(filled)}
              </Text>
              <Text dimColor>{'─'.repeat(Math.max(0, cells - filled))}</Text>
            </Text>
          ) : (
            <Svg
              source={barSource(barWidth, now.percent, k.state === 'compacting')}
              alt={`${now.percent}% of the window`}
              width={barWidth}
              height={BAR_HEIGHT}
            />
          )}
          {Svg === null ? (
            <Button
              key="knob"
              plain
              label={k.state === 'armed' ? '✓' : k.state === 'compacting' ? '◐' : '⤡'}
              onPress={() => pressKnob($).catch((error: unknown) => $.ui.toast(`Compact did not start: ${String(error)}`))}
            />
          ) : (
            <Box key="knob-box" position="relative" flexShrink={0}>
              <Svg source={knobSource(k.state, now.percent, left)} alt={knobLabel} width={KNOB} height={KNOB} />
              {/* A label-less control laid over the knob, wider than it so the overlay clips it and no ellipsis shows. */}
              <Box position="absolute" top={0} left={0} right={0} bottom={0} overflow="hidden">
                <Box width={200} flexShrink={0}>
                  <Button
                    key="knob"
                    plain
                    label={' '.repeat(100)}
                    hover={{ backgroundColor: '#00000000' }}
                    onPress={() => pressKnob($).catch((error: unknown) => $.ui.toast(`Compact did not start: ${String(error)}`))}
                  />
                </Box>
              </Box>
            </Box>
          )}
        </Box>
        <Box flexGrow={1} />
        {weekly === undefined ? null : (
          <Box flexDirection="row" alignItems="center" columnGap={1} flexShrink={0}>
            {Svg === null ? null : (
              <Svg
                source={ringSource(weekly.percentUsed / 100, weekGone, isWeeklyStale ? DIM : weeklyHue(weekly.percentUsed))}
                alt={`Weekly plan: ${Math.round(weekly.percentUsed)}% used, ${Math.round(clamp(weekGone) * 100)}% of the week gone`}
                width={16}
                height={16}
              />
            )}
            {isNarrow ? null : <Text dimColor>weekly</Text>}
            {isWeeklyStale ? (
              <Text dimColor>{`${Math.round(weekly.percentUsed)}%`}</Text>
            ) : (
              <Text bold color={limitColor(weekly.percentUsed)}>{`${Math.round(weekly.percentUsed)}%`}</Text>
            )}
            {weekly.resetsAt === undefined ? null : <Text dimColor>{`↻ ${resetsIn(weekly.resetsAt, clock)}`}</Text>}
            {isWeeklyStale ? (
              <Text dimColor>
                {`· read ${age(clock - now.limitsAt)} ago${now.refusedStatus === null ? '' : ` (refused ${now.refusedStatus})`}`}
              </Text>
            ) : null}
          </Box>
        )}
      </Box>
    )
  })
}
