import { useEffect, useRef, useState } from 'react'
import type { ConnectionStats, EndpointConfig, ServerStatus } from '../../../shared/types'
import { ServerStatusBadge } from './ServerStatus'

interface Props {
  endpoints: EndpointConfig[]
  statuses: Record<string, ServerStatus>
  connectionStats: Record<string, ConnectionStats>
  selectedId: string | null
  onSelect: (id: string) => void
  onAdd: () => void
  onDelete: (id: string) => void
  onRename: (id: string, name: string) => void
}

export function EndpointList({ endpoints, statuses, connectionStats, selectedId, onSelect, onAdd, onDelete, onRename }: Props) {
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draftName, setDraftName] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (editingId) inputRef.current?.select()
  }, [editingId])

  const startEditing = (ep: EndpointConfig) => {
    setEditingId(ep.id)
    setDraftName(ep.name)
  }

  const commitEditing = () => {
    if (editingId) onRename(editingId, draftName)
    setEditingId(null)
  }

  const cancelEditing = () => setEditingId(null)

  return (
    <aside className="w-56 flex-shrink-0 flex flex-col" style={{ background: '#e8e6e1', borderRight: '1px solid #d8d5cf' }}>
      {/* Header + Add button */}
      <div className="px-3 pt-4 pb-3">
        <p className="text-xs font-semibold uppercase tracking-widest mb-3 px-1" style={{ color: '#888' }}>
          MCP Endpoints
        </p>
        <button
          onClick={onAdd}
          className="w-full flex items-center justify-center gap-1.5 py-2 rounded-lg text-sm font-medium transition-colors"
          style={{ background: '#4a9e6e', color: '#fff' }}
          onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.background = '#3d8a5e' }}
          onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.background = '#4a9e6e' }}
        >
          <span className="text-base leading-none">+</span>
          <span>新增端點</span>
        </button>
      </div>

      {/* Divider */}
      <div style={{ height: '1px', background: '#d0cdc7', margin: '0 12px' }} />

      {/* Endpoint list */}
      <div className="flex-1 overflow-y-auto py-2">
        {endpoints.length === 0 ? (
          <p className="text-xs italic px-4 py-6 text-center" style={{ color: '#bbb' }}>
            尚無端點<br />
            <span style={{ color: '#ccc' }}>點擊上方按鈕新增</span>
          </p>
        ) : (
          endpoints.map(ep => {
            const status = statuses[ep.id] ?? 'stopped'
            const stats = connectionStats[ep.id]
            const isSelected = ep.id === selectedId
            return (
              <div
                key={ep.id}
                onClick={() => onSelect(ep.id)}
                className="group mx-2 mb-0.5 flex items-start justify-between px-3 py-2.5 rounded-lg cursor-pointer transition-colors"
                style={isSelected
                  ? { background: '#fff', boxShadow: '0 1px 3px rgba(0,0,0,0.08)' }
                  : {}}
                onMouseEnter={e => { if (!isSelected) (e.currentTarget as HTMLDivElement).style.background = 'rgba(255,255,255,0.5)' }}
                onMouseLeave={e => { if (!isSelected) (e.currentTarget as HTMLDivElement).style.background = '' }}
              >
                <div className="min-w-0 flex-1">
                  {editingId === ep.id ? (
                    <input
                      ref={inputRef}
                      value={draftName}
                      onChange={e => setDraftName(e.target.value)}
                      onClick={e => e.stopPropagation()}
                      onBlur={commitEditing}
                      onKeyDown={e => {
                        if (e.key === 'Enter') commitEditing()
                        else if (e.key === 'Escape') cancelEditing()
                      }}
                      className="w-full text-sm font-medium px-1 py-0.5 rounded outline-none"
                      style={{ color: '#111', background: '#fff', border: '1px solid #4a9e6e' }}
                    />
                  ) : (
                    <div
                      className="flex items-center gap-1.5 text-sm font-medium truncate"
                      style={{ color: isSelected ? '#111' : '#333', cursor: isSelected ? 'text' : 'pointer' }}
                      onClick={e => {
                        if (isSelected) { e.stopPropagation(); startEditing(ep) }
                      }}
                      title={isSelected ? '點擊以重新命名' : undefined}
                    >
                      <ServerStatusBadge status={status} dotOnly />
                      <span className="truncate">{ep.name}</span>
                    </div>
                  )}
                  <div className="mt-1 flex items-center gap-1.5 whitespace-nowrap overflow-hidden">
                    <span className="text-xs flex-shrink-0" style={{ color: '#888' }}>:{ep.port}</span>
                    {status === 'running' && stats && stats.active > 0 && (
                      <span className="text-xs font-medium truncate" style={{ color: '#4a9e6e' }}>
                        ・{stats.active} 連線
                      </span>
                    )}
                  </div>
                </div>
                {editingId !== ep.id && (
                  <button
                    onClick={e => { e.stopPropagation(); onDelete(ep.id) }}
                    className="opacity-0 group-hover:opacity-100 transition-opacity ml-1 mt-0.5 w-5 h-5 flex items-center justify-center rounded text-xs hover:bg-red-100 hover:text-red-400"
                    style={{ color: '#bbb' }}
                    title="刪除端點"
                  >
                    ✕
                  </button>
                )}
              </div>
            )
          })
        )}
      </div>
    </aside>
  )
}
