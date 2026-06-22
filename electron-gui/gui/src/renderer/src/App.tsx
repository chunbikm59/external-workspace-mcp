import { useCallback, useEffect, useRef, useState } from 'react'
import type { ConnectionStats, EndpointConfig, ServerStatus } from '../../shared/types'
import { EndpointList } from './components/EndpointList'
import { EndpointSettings } from './components/EndpointSettings'

const EMPTY_STATS: ConnectionStats = { active: 0 }

export default function App() {
  const [endpoints, setEndpoints] = useState<EndpointConfig[]>([])
  const [statuses, setStatuses] = useState<Record<string, ServerStatus>>({})
  const [connectionStats, setConnectionStats] = useState<Record<string, ConnectionStats>>({})
  const [selectedId, setSelectedId] = useState<string | null>(null)

  const loadEndpoints = useCallback(async () => {
    const eps = await window.electronAPI.getEndpoints()
    setEndpoints(eps)
    if (eps.length > 0 && !selectedId) {
      setSelectedId(eps[0]!.id)
    }
  }, [selectedId])

  useEffect(() => {
    loadEndpoints()

    const unsub = window.electronAPI.onStatusChanged(({ endpointId, status }) => {
      setStatuses(prev => ({ ...prev, [endpointId]: status }))
    })
    const unsubStats = window.electronAPI.onConnectionStatsChanged(({ endpointId, stats }) => {
      setConnectionStats(prev => ({ ...prev, [endpointId]: stats }))
    })

    return () => { unsub(); unsubStats() }
  }, [])

  // Sync statuses for all endpoints on mount
  useEffect(() => {
    endpoints.forEach(ep => {
      window.electronAPI.getServerStatus(ep.id).then(status => {
        setStatuses(prev => ({ ...prev, [ep.id]: status }))
      })
      window.electronAPI.getConnectionStats(ep.id).then(stats => {
        setConnectionStats(prev => ({ ...prev, [ep.id]: stats }))
      })
    })
  }, [endpoints])

  const handleAdd = async () => {
    const name = `新端點 ${endpoints.length + 1}`
    try {
      const ep = await window.electronAPI.createEndpoint(name)
      await loadEndpoints()
      setSelectedId(ep.id)
    } catch (err) {
      alert(`新增端點失敗：${err}`)
    }
  }

  const handleDelete = async (id: string) => {
    const status = statuses[id]
    if (status === 'running' || status === 'starting') {
      await window.electronAPI.stopServer(id)
    }
    await window.electronAPI.deleteEndpoint(id)
    setStatuses(prev => { const next = { ...prev }; delete next[id]; return next })
    const remaining = endpoints.filter(e => e.id !== id)
    setEndpoints(remaining)
    if (selectedId === id) {
      setSelectedId(remaining[0]?.id ?? null)
    }
  }

  const handleSave = async (updated: EndpointConfig) => {
    await window.electronAPI.saveEndpoint(updated)
    setEndpoints(prev => prev.map(e => e.id === updated.id ? updated : e))
  }

  const handleRename = async (id: string, name: string) => {
    const target = endpoints.find(e => e.id === id)
    const trimmed = name.trim()
    if (!target || !trimmed || trimmed === target.name) return
    await handleSave({ ...target, name: trimmed })
  }

  const handleStart = async (endpoint: EndpointConfig) => {
    const result = await window.electronAPI.startServer(endpoint)
    if (!result.ok && result.error) {
      alert(`啟動失敗：${result.error}`)
    }
  }

  const handleStop = async (id: string) => {
    await window.electronAPI.stopServer(id)
  }

  const handleRestart = async (endpoint: EndpointConfig) => {
    const result = await window.electronAPI.restartServer(endpoint)
    if (!result.ok && result.error) {
      alert(`重啟失敗：${result.error}`)
    }
  }

  const handleReloadWhitelist = async (endpoint: EndpointConfig) => {
    const result = await window.electronAPI.reloadWhitelist(endpoint)
    if (result.cancelled) return
    if (!result.ok && result.error) {
      alert(`重載白名單失敗：${result.error}`)
      return
    }
    if (result.ok && result.message) {
      alert(result.message)
    }
  }

  const selected = endpoints.find(e => e.id === selectedId) ?? null

  return (
    <div className="flex h-screen" style={{ background: '#f7f5f2', color: '#1a1a1a' }}>
      <EndpointList
        endpoints={endpoints}
        statuses={statuses}
        connectionStats={connectionStats}
        selectedId={selectedId}
        onSelect={setSelectedId}
        onAdd={handleAdd}
        onDelete={handleDelete}
        onRename={handleRename}
      />

      <main className="flex-1 overflow-hidden">
        {selected ? (
          <EndpointSettings
            key={selected.id}
            endpoint={selected}
            status={statuses[selected.id] ?? 'stopped'}
            connectionStats={connectionStats[selected.id] ?? EMPTY_STATS}
            onSave={handleSave}
            onStart={() => handleStart(selected)}
            onStop={() => handleStop(selected.id)}
            onRestart={() => handleRestart(selected)}
            onReloadWhitelist={() => handleReloadWhitelist(selected)}
          />
        ) : (
          <div className="flex items-center justify-center h-full" style={{ background: '#f7f5f2' }}>
            <div className="text-center">
              <div className="text-5xl mb-4" style={{ opacity: 0.15 }}>⚡</div>
              <p className="text-sm font-medium mb-1" style={{ color: '#888' }}>尚未選擇端點</p>
              <p className="text-xs" style={{ color: '#bbb' }}>在左側新增或選擇一個端點開始設定</p>
            </div>
          </div>
        )}
      </main>
    </div>
  )
}
