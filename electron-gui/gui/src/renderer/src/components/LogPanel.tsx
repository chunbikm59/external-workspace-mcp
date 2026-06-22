import { useEffect, useMemo, useRef, useState } from 'react'
import type { LogLevel, LogLine } from '../../../shared/types'

interface Props {
  endpointId: string
}

const LEVEL_RANK: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 }
const LEVEL_COLOR: Record<LogLevel, string> = {
  debug: '#b8afa7',
  info: '#4a4540',
  warn: '#b9770e',
  error: '#c0392b',
}
const LEVEL_OPTIONS: { value: LogLevel; label: string }[] = [
  { value: 'debug', label: 'Debug+' },
  { value: 'info', label: 'Info+' },
  { value: 'warn', label: 'Warn+' },
  { value: 'error', label: 'Error only' },
]

function guessLevel(line: string): LogLevel {
  if (line.startsWith('[ERROR]') || line.startsWith('Error')) return 'error'
  if (line.startsWith('[WARN]')) return 'warn'
  return 'info'
}

export function LogPanel({ endpointId }: Props) {
  const [lines, setLines] = useState<LogLine[]>([])
  const [pinned, setPinned] = useState(true)
  const [minLevel, setMinLevel] = useState<LogLevel>('info')
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    setLines([])
    // Load existing logs
    window.electronAPI.getServerLogs(endpointId).then(existing => {
      setLines(existing.map((line, i) => {
        const level = guessLevel(line)
        return {
          endpointId,
          line,
          level,
          isError: level === 'error',
          timestamp: Date.now() - (existing.length - i) * 10,
        }
      }))
    })

    const unsub = window.electronAPI.onLogLine(payload => {
      if (payload.endpointId !== endpointId) return
      setLines(prev => {
        const next = [...prev, payload]
        return next.length > 500 ? next.slice(-500) : next
      })
    })
    return unsub
  }, [endpointId])

  useEffect(() => {
    if (pinned) bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [lines, pinned])

  const visibleLines = useMemo(
    () => lines.filter(l => LEVEL_RANK[l.level] >= LEVEL_RANK[minLevel]),
    [lines, minLevel],
  )

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-3 py-1.5" style={{ borderBottom: '1px solid #e2e0db', background: '#efefec' }}>
        <span className="text-xs font-semibold uppercase tracking-widest" style={{ color: '#555' }}>Log</span>
        <div className="flex items-center gap-3">
          <select
            value={minLevel}
            onChange={e => setMinLevel(e.target.value as LogLevel)}
            className="text-xs rounded"
            style={{ color: '#555', background: 'transparent', border: '1px solid #d8d4cd' }}
          >
            {LEVEL_OPTIONS.map(opt => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
          <button
            onClick={() => setLines([])}
            className="text-xs transition-colors"
            style={{ color: '#b8afa7' }}
          >
            Clear
          </button>
          <button
            onClick={() => setPinned(p => !p)}
            className="text-xs transition-colors"
            style={{ color: pinned ? '#6b8f6b' : '#b8afa7' }}
          >
            {pinned ? '↓ Auto-scroll' : '‖ Paused'}
          </button>
        </div>
      </div>
      <div className="flex-1 overflow-y-auto font-mono text-xs p-2 space-y-0.5" style={{ background: '#fafaf8' }}>
        {visibleLines.length === 0 ? (
          <p className="italic p-2" style={{ color: '#b8afa7' }}>No log output</p>
        ) : (
          visibleLines.map((l, i) => (
            <div
              key={i}
              className="whitespace-pre-wrap break-all leading-relaxed"
              style={{ color: LEVEL_COLOR[l.level] }}
            >
              {l.line}
            </div>
          ))
        )}
        <div ref={bottomRef} />
      </div>
    </div>
  )
}
