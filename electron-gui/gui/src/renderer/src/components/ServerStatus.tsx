import type { ServerStatus } from '../../../shared/types'

interface Props {
  status: ServerStatus
  dotOnly?: boolean
}

const STATUS_CONFIG = {
  running:  { dot: 'bg-emerald-500', text: 'text-emerald-600', label: 'Running' },
  starting: { dot: 'bg-yellow-400 animate-pulse', text: 'text-yellow-600', label: 'Starting...' },
  stopping: { dot: 'bg-yellow-400 animate-pulse', text: 'text-yellow-600', label: 'Stopping...' },
  error:    { dot: 'bg-red-500', text: 'text-red-500', label: 'Error' },
  stopped:  { dot: 'bg-slate-400', text: 'text-slate-400', label: 'Stopped' },
} as const

export function ServerStatusBadge({ status, dotOnly }: Props) {
  const cfg = STATUS_CONFIG[status]
  if (dotOnly) {
    return <span className={`inline-block w-2 h-2 rounded-full flex-shrink-0 ${cfg.dot}`} title={cfg.label} />
  }
  return (
    <span className={`flex items-center gap-1 text-xs font-medium flex-shrink-0 whitespace-nowrap ${cfg.text}`}>
      <span className={`w-2 h-2 rounded-full flex-shrink-0 ${cfg.dot}`} />
      {cfg.label}
    </span>
  )
}
