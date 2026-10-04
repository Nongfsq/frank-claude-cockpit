import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, SessionRateLimit } from 'claude-code'

import type { Card, Limit, Slice } from '../types'

const card = atom({ plugin: 'context-card', key: 'card' } as const, null)
// Sessions that need the user, as the sessions pane counts them.
const attention = atom({ plugin: 'pr-pane', key: 'attention' } as const, 0)

// Presses of the PRs button. The sessions pane hooks this write and toggles itself, which works mid-turn,
// where running its command would wait for the turn to end.
const paneAsk = atom({ plugin: 'context-card', key: 'paneAsk' } as const, 0)

const LINE_CELLS = 14
// Whether the breakdown is open: a click on the line toggles it.
const isOpen = atom({ plugin: 'context-card', key: 'isOpen' } as const, false)

const LOCAL_MS = 15_000
const HOUR = 3_600_000

const FIVE_MINUTES = 300_000
const TAIL_BYTES = 400_000

// The prompt cache: when the last response came back, and how long the cache lives. An hour until the
// session's own record says otherwise: five minutes with an API key or once usage credits are being drawn.
const cache = atom({ plugin: 'context-card', key: 'cache' } as const, { lastReplyAt: 0, ttlMs: HOUR })

const markReply = async ($: EngineInterface) => {
  const now = await $.clock.now()
  await update($, cache, was => ({ ...was, lastReplyAt: now }))
}

// Each response is recorded with what it wrote to the cache at each lifetime; the newest one that wrote any
// tells which lifetime this session's cache has. Null when the end of the record names neither.
const writtenTtl = (tail: string) => {
  for (const line of tail.split('\n').reverse()) {
    try {
      const wrote = (JSON.parse(line) as { message?: { usage?: { cache_creation?: Record<string, unknown> } } }).message?.usage
        ?.cache_creation

      if (Number(wrote?.ephemeral_1h_input_tokens) > 0) {
        return HOUR
      }

      if (Number(wrote?.ephemeral_5m_input_tokens) > 0) {
        return FIVE_MINUTES
      }
    } catch {
      // The first line is cut where the tail starts, and not every line is a response.
    }
  }

  return null
}

const measureTtl = async ($: EngineInterface, transcriptPath: string) => {
  if (transcriptPath === '') {
    return
  }

  const tail = await $.process.run(['tail', '-c', String(TAIL_BYTES), transcriptPath]).catch(() => null)
  const ttlMs = tail === null || tail.exitCode !== 0 ? null : writtenTtl(tail.stdout)

  if (ttlMs !== null) {
    await update($, cache, was => ({ ...was, ttlMs }))
  }
}

// Full while the cache is fresh, half once most of its life is gone, an empty ring once it has expired. Only
// these three: the quarter pies come from another font on desktop, smaller and off the line's centre.
const cacheGlyph = (left: number, ttl: number) => (left <= 0 ? '○' : left > ttl * 0.5 ? '●' : '◐')

const minutesLeft = (left: number) => (left >= 60_000 ? `${Math.ceil(left / 60_000)}m` : `${Math.max(1, Math.ceil(left / 1000))}s`)

// Opening the breakdown also refreshes it, so what opens is current; neither call spends tokens.
const toggleOpen = async ($: EngineInterface) => {
  const opening = !(await read($, isOpen))
  await update($, isOpen, () => opening)

  if (opening) {
    await Promise.all([refresh($), poll($).catch(() => {})])
  }
}

// Labels per /context row, matched on a lowercase fragment of its name. Colors come from the row itself:
// /context's own theme keys, so the bar matches /context and follows the light and dark themes.
const ROWS: { match: string; label: string }[] = [
  { match: 'system prompt', label: 'system' },
  { match: 'mcp', label: 'mcp' },
  { match: 'tool', label: 'tools' },
  { match: 'agent', label: 'agents' },
  { match: 'memory', label: 'memory' },
  { match: 'skill', label: 'skills' },
  { match: 'message', label: 'messages' },
  { match: 'slash', label: 'commands' },
]

const LIMIT_LABELS: Record<string, string> = { seven_day: 'weekly', five_hour: '5h', spend_limit: 'spend' }
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

const toLimits = (limits: SessionRateLimit[]): Limit[] =>
  limits
    .filter(({ kind }) => LIMIT_ORDER.includes(kind))
    .map(({ kind, percentUsed, resetsAt }) => ({ kind, percentUsed, resetsAt }))
    .sort((a, b) => LIMIT_ORDER.indexOf(a.kind) - LIMIT_ORDER.indexOf(b.kind))

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'
const POLL_MS = 60_000

// True once the account-wide figures came back; the session's own rate-limit headers then stop overriding them.
let hasLive = false

// What the last usage request found, kept in one file every session reads, so the account is asked once
// for all of them and they all show the same figure.
type Shared = { at: number; triedAt: number; retryAt: number; limits: Limit[] }

const SHARE_MS = 120_000
const BACKOFF_MS = 300_000
const CLAIM_MS = 20_000

const sharedPath = async ($: EngineInterface) => {
  const home = await $.env.get('HOME').catch(() => undefined)

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
      limits: Array.isArray(found.limits) ? found.limits : [],
    }
  } catch {
    return null
  }
}

const writeShared = async ($: EngineInterface, path: string | null, value: Shared) => {
  if (path !== null) {
    await $.fs.write(path, JSON.stringify(value)).catch(() => undefined)
  }
}

const show = async ($: EngineInterface, shared: Shared) => {
  if (shared.limits.length === 0) {
    return
  }

  hasLive = true
  await update($, card, was => (was === null ? was : { ...was, limits: shared.limits }))
}

// Account-wide plan usage, as the app's usage card reads it; covers every session, not just this one.
// Each session calls this on its own timer, but only one of them sends the request: the rest read its result.
const poll = async ($: EngineInterface) => {
  const path = await sharedPath($)
  const now = await $.clock.now()
  const shared = (await readShared($, path)) ?? { at: 0, triedAt: 0, retryAt: 0, limits: [] }

  await show($, shared)

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
    // Refused (rate limited, usually): every session waits before any of them asks again.
    await writeShared($, path, { ...shared, triedAt: now, retryAt: now + BACKOFF_MS })

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

  const next: Shared = { at: now, triedAt: now, retryAt: 0, limits }

  await writeShared($, path, next)
  await show($, next)
}

const refresh = async ($: EngineInterface) => {
  const { context, rateLimits } = await $.session.usage({ breakdown: 'summary' })
  const breakdown = context.breakdown

  if (breakdown === undefined) {
    return
  }

  const window = breakdown.rawMaxTokens

  const slices: Slice[] = breakdown.categories
    .filter(row => row.kind === 'used' || row.kind === 'free')
    .filter(row => row.tokens > 0)
    .map(row => {
      const isFree = row.kind === 'free'
      const known = ROWS.find(r => row.name.toLowerCase().includes(r.match))

      return {
        name: isFree ? 'free' : (known?.label ?? row.name.toLowerCase()),
        tokens: row.tokens,
        percent: Math.round((row.tokens / window) * 100),
        color: row.color,
        isFree,
      }
    })
    // Categories that share a label (loaded and deferred MCP tools) are one row.
    .reduce<Slice[]>((merged, slice) => {
      const same = merged.find(one => one.name === slice.name)

      if (same === undefined) {
        return [...merged, slice]
      }

      const tokens = same.tokens + slice.tokens

      return merged.map(one => (one === same ? { ...one, tokens, percent: Math.round((tokens / window) * 100) } : one))
    }, [])

  const tokens = context.tokens ?? breakdown.totalTokens

  await update($, card, was => ({
    tokens,
    window: context.window,
    percent: context.percent ?? breakdown.percentage,
    compactsAt: breakdown.isAutoCompactEnabled ? (breakdown.autoCompactThreshold ?? null) : null,
    slices,
    limits: hasLive && was !== null ? was.limits : toLimits(rateLimits),
  }))
}

export const register: Register = on => {
  let ticker: { cancel: () => void } | null = null
  let localTicker: { cancel: () => void } | null = null

  on('session.start', async ($, e, next) => {
    await refresh($)
    await poll($).catch(() => {})
    ticker?.cancel()
    ticker = $.clock.every(POLL_MS, () => poll($).catch(() => {}))
    // The breakdown is a local estimate: refreshing it sends no request.
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
      await markReply($)
      await refresh($)
      await poll($).catch(() => {})
    }

    return next(e)
  })

  // A resumed session's record already says which lifetime it has; after that, each finished turn's does.
  on('classic.SessionStart', async ($, e, next) => {
    await measureTtl($, e.transcript_path)

    return next(e)
  })

  on('classic.Stop', async ($, e, next) => {
    await measureTtl($, e.transcript_path)

    return next(e)
  })

  on('session.compact', async ($, e, next) => {
    const result = await next(e)
    await refresh($)

    return result
  })

  on('session.measure', async ($, e, next) => {
    // The fill moves mid-turn: follow it at once, keeping the last breakdown until the next refresh.
    const { tokens, window } = e.context

    if (e.changed.includes('context') && tokens !== undefined) {
      await markReply($)
      const percent = e.context.percent ?? Math.round((tokens / window) * 100)
      await update($, card, was => (was === null ? was : { ...was, tokens, window, percent }))
    }

    if (!hasLive && e.changed.includes('rateLimits')) {
      await update($, card, was => (was === null ? was : { ...was, limits: toLimits(e.rateLimits) }))
    }

    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const now = await read($, card)

    if (e.props.hasSurvey || now === null) {
      return next(e)
    }

    const { Box, Button, Text } = $.ui.resolve(e)
    const clock = await $.clock.now()
    const open = await read($, isOpen)
    const isDesktop = e.surface === 'desktop'
    const isNarrow = (e.props.bodyColumns ?? 100) < 64
    const weekly = now.limits.find(limit => limit.kind === 'seven_day')
    const used = now.slices.filter(slice => !slice.isFree).sort((a, b) => b.tokens - a.tokens)
    // Checked while drawing, so the button appears whichever mod finished loading first.
    const hasSessions = (await $.command.list().catch(() => [])).some(command => command.name === 'sessions')
    const waiting = hasSessions ? await read($, attention) : 0
    const pctColor = fillColor(now.percent)
    const cached = await read($, cache)
    const cacheLeft = cached.lastReplyAt === 0 ? null : cached.ttlMs - (clock - cached.lastReplyAt)

    // The line's bar in whole cells: each category its share of the filled cells, the rest dim.
    const filled = Math.min(LINE_CELLS, Math.round((now.percent / 100) * LINE_CELLS))
    const cells = used.map(slice => ({ slice, n: Math.round((slice.tokens / Math.max(now.tokens, 1)) * filled) }))
    const drawn = cells.reduce((sum, cell) => sum + cell.n, 0)

    const breakdown = (
      <Box flexDirection="column" rowGap={1} paddingX={2} paddingY={1} marginBottom={1} borderStyle="round" borderDimColor>
        <Box flexDirection="row" justifyContent="space-between" columnGap={2}>
          <Text>
            <Text bold color={pctColor}>{`${now.percent}%`}</Text>
            <Text dimColor> of the context window</Text>
          </Text>
          <Box flexDirection="row" columnGap={2}>
            {cacheLeft === null ? null : cacheLeft > 0 ? (
              <Text dimColor>{`${cacheGlyph(cacheLeft, cached.ttlMs)} ${minutesLeft(cacheLeft)}`}</Text>
            ) : (
              <Text color="warning">○ cache cold</Text>
            )}
            {now.compactsAt === null ? null : <Text dimColor>{`auto-compact at ${compact(now.compactsAt)}`}</Text>}
          </Box>
        </Box>
        <Box flexDirection="row" overflow="hidden">
          {used.map(slice => (
            <Box key={`bar-${slice.name}`} width={`${Math.max(slice.percent, 1)}%`} flexShrink={0} overflow="hidden">
              {/* Wider than any bar, so the parent clips it and no ellipsis is drawn at the cut. */}
              <Box width={900} flexShrink={0}>
                <Text color={slice.color}>{'━'.repeat(300)}</Text>
              </Box>
            </Box>
          ))}
          <Box key="bar-free" flexGrow={1} flexShrink={1} overflow="hidden">
            <Box width={900} flexShrink={0}>
              <Text dimColor>{'─'.repeat(300)}</Text>
            </Box>
          </Box>
        </Box>
        <Box flexDirection="row" flexWrap="wrap">
          {used.map(slice => (
            <Box key={`row-${slice.name}`} width={isNarrow ? '50%' : '33%'} paddingRight={3}>
              <Box flexDirection="row" justifyContent="space-between" flexGrow={1}>
                <Text wrap="truncate-end">
                  <Text color={slice.color}>● </Text>
                  <Text dimColor>{slice.name}</Text>
                </Text>
                <Text>{compact(slice.tokens)}</Text>
              </Box>
            </Box>
          ))}
        </Box>
      </Box>
    )

    return (
      <Box flexDirection="column">
        {open ? breakdown : null}
        <Box flexDirection="row" alignItems="center" columnGap={2}>
          <Box key="line" flexDirection="row" alignItems="center" columnGap={2} flexGrow={1} position="relative">
            {isDesktop ? (
              <Text bold color={pctColor}>{`${now.percent}%`}</Text>
            ) : (
              <Button key="toggle" plain label={`${now.percent}%`} onPress={() => void toggleOpen($)} />
            )}
            {isNarrow ? null : (
              <Text dimColor hover={{ dimColor: false }}>
                {`${compact(now.tokens)} / ${compact(now.window)}`}
              </Text>
            )}
            {cacheLeft === null ? null : cacheLeft > 0 ? (
              <Text dimColor>{cacheGlyph(cacheLeft, cached.ttlMs)}</Text>
            ) : (
              <Text color="warning">○</Text>
            )}
            <Text wrap="truncate">
              {cells.map(cell => (
                <Text key={`cell-${cell.slice.name}`} color={cell.slice.color}>
                  {'━'.repeat(cell.n)}
                </Text>
              ))}
              <Text dimColor hover={{ dimColor: false }}>
                {'─'.repeat(Math.max(0, LINE_CELLS - drawn))}
              </Text>
            </Text>
            {now.percent >= 60 && now.compactsAt !== null ? (
              <Text color={pctColor}>{`compacts at ${compact(now.compactsAt)}`}</Text>
            ) : null}
            <Box flexGrow={1} />
            {weekly === undefined ? null : (
              <Box flexDirection="row" columnGap={1} flexShrink={0}>
                {isNarrow ? null : <Text dimColor>weekly</Text>}
                <Text bold color={limitColor(weekly.percentUsed)}>{`${Math.round(weekly.percentUsed)}%`}</Text>
                {weekly.resetsAt === undefined ? null : <Text dimColor>{`↻ ${resetsIn(weekly.resetsAt, clock)}`}</Text>}
              </Box>
            )}
            {/* Desktop: a label-less control laid over the whole line, so a click anywhere on it toggles the breakdown. */}
            {isDesktop ? (
              <Box position="absolute" top={0} left={0} right={0} bottom={0} overflow="hidden">
                {/* The control is wider than any line, so the overlay clips it and its label is never cut with an ellipsis. */}
                <Box width={1200} flexShrink={0}>
                  <Button
                    key="toggle"
                    plain
                    label={'\u00A0'.repeat(600)}
                    hover={{ backgroundColor: '#00000000' }}
                    onPress={() => void toggleOpen($)}
                  />
                </Box>
              </Box>
            ) : null}
          </Box>
          {hasSessions ? (
            <Box flexDirection="row" columnGap={1} flexShrink={0}>
              <Button key="sessions" label="PRs" onPress={() => void update($, paneAsk, count => count + 1)} />
              {waiting > 0 ? (
                <Text bold color="warning">
                  {waiting}
                </Text>
              ) : null}
            </Box>
          ) : null}
        </Box>
      </Box>
    )
  })
}
