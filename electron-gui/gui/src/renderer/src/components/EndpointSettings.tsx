import { useState } from 'react'
import type { ConnectionStats, EndpointConfig, ServerStatus } from '../../../shared/types'
import { ServerStatusBadge } from './ServerStatus'
import { WorkspacePaths } from './WorkspacePaths'
import { ToolsGrid } from './ToolsGrid'
import { LogPanel } from './LogPanel'

interface Props {
  endpoint: EndpointConfig
  status: ServerStatus
  connectionStats: ConnectionStats
  onSave: (updated: EndpointConfig) => void
  onStart: () => void
  onStop: () => void
  onRestart: () => void
  onReloadWhitelist: () => void
}

type Tab = 'workspace' | 'tools' | 'advanced'

export function EndpointSettings({ endpoint, status, connectionStats, onSave, onStart, onStop, onRestart, onReloadWhitelist }: Props) {
  const draft = endpoint
  const [showToken, setShowToken] = useState(false)
  const [portError, setPortError] = useState('')
  const [tab, setTab] = useState<Tab>('workspace')

  const update = <K extends keyof EndpointConfig>(key: K, value: EndpointConfig[K]) => {
    onSave({ ...draft, [key]: value })
  }

  const handlePortChange = async (raw: string) => {
    const port = parseInt(raw, 10)
    if (isNaN(port) || port < 1 || port > 65535) {
      setPortError('請輸入 1–65535 的有效埠號')
      return
    }
    setPortError('')
    update('port', port)
    if (status === 'stopped') {
      const { available } = await window.electronAPI.checkPort(port)
      if (!available) setPortError('此埠號已被佔用')
    }
  }

  const mcpUrl = `http://${draft.host === '0.0.0.0' ? '127.0.0.1' : draft.host}:${draft.port}/mcp`
  const isRunning = status === 'running' || status === 'starting' || status === 'stopping'
  const isStopping = status === 'stopping'

  const tabs: { key: Tab; label: string }[] = [
    { key: 'workspace', label: '工作資料夾' },
    { key: 'tools', label: '工具設定' },
    { key: 'advanced', label: '進階設定' },
  ]

  return (
    <div className="flex flex-col h-full overflow-hidden">

      {/* ── Topbar ── */}
      <div
        className="flex items-center justify-between px-5 py-3 flex-shrink-0"
        style={{ borderBottom: '1px solid #e2e0db', background: '#fafaf8' }}
      >
        {/* Left: name + status */}
        <div className="flex items-center gap-3 min-w-0">
          <h2 className="font-semibold text-sm truncate" style={{ color: '#1a1a1a' }}>{draft.name}</h2>
          <ServerStatusBadge status={status} />
          {isRunning && (
            <span
              className="text-xs font-medium px-1.5 py-0.5 rounded"
              style={{ color: '#4a9e6e', background: '#eaf5ee' }}
              title="目前連線數"
            >
              連線 {connectionStats.active}
            </span>
          )}
          <span className="text-xs font-mono" style={{ color: '#aaa' }}>{mcpUrl}</span>
        </div>

        {/* Right: actions */}
        <div className="flex items-center gap-2 flex-shrink-0 ml-4">
          <button
            onClick={() => window.electronAPI.copyToClipboard(mcpUrl)}
            className="px-2.5 py-1.5 text-xs rounded-md transition-colors"
            style={{ background: '#efefec', color: '#666', border: '1px solid #ddd' }}
            title="複製 MCP URL"
          >
            複製 URL
          </button>

          {!isRunning ? (
            <button
              onClick={onStart}
              className="px-3 py-1.5 text-xs font-medium rounded-md transition-colors"
              style={{ background: '#4a9e6e', color: '#fff' }}
              onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.background = '#3d8a5e' }}
              onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.background = '#4a9e6e' }}
            >
              ▶ 啟動
            </button>
          ) : (
            <>
              <button
                onClick={onReloadWhitelist}
                disabled={isStopping}
                className="px-2.5 py-1.5 text-xs rounded-md transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                style={{ background: '#f59e0b', color: '#fff' }}
                onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.background = '#d97706' }}
                onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.background = '#f59e0b' }}
                title="重新從磁碟載入白名單，無需重啟伺服器"
              >
                ⟳ 套用白名單
              </button>
              <button
                onClick={onRestart}
                disabled={isStopping}
                className="px-2.5 py-1.5 text-xs rounded-md transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                style={{ background: '#6b7280', color: '#fff' }}
                onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.background = '#4b5563' }}
                onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.background = '#6b7280' }}
              >
                ↺ 重啟
              </button>
              <button
                onClick={onStop}
                disabled={isStopping}
                className="px-2.5 py-1.5 text-xs rounded-md transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                style={{ background: '#ef4444', color: '#fff' }}
                onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.background = '#dc2626' }}
                onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.background = '#ef4444' }}
              >
                {isStopping ? '⏳ 停止中...' : '■ 停止'}
              </button>
            </>
          )}
        </div>
      </div>

      {/* ── Tab bar ── */}
      <div
        className="flex items-end gap-0 px-5 flex-shrink-0"
        style={{ borderBottom: '1px solid #e2e0db', background: '#fafaf8' }}
      >
        {tabs.map(t => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className="px-4 py-2.5 text-xs font-medium transition-colors relative"
            style={{
              color: tab === t.key ? '#1a1a1a' : '#888',
              borderBottom: tab === t.key ? '2px solid #4a9e6e' : '2px solid transparent',
              marginBottom: '-1px',
              background: 'none',
            }}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* ── Settings body ── */}
      <div className="flex-1 overflow-y-auto min-h-0" style={{ background: '#f7f5f2' }}>
        <div className={tab === 'workspace' ? 'p-5' : 'p-5 max-w-2xl'}>

          {/* Tab: 工作資料夾 */}
          {tab === 'workspace' && (
            <div className="space-y-5 max-w-4xl">
              <div>
                <h3 className="text-sm font-semibold mb-1" style={{ color: '#333' }}>工作資料夾</h3>
                <p className="text-xs mb-3" style={{ color: '#999' }}>
                  MCP Server 可存取的根目錄。AI 只能讀寫這些資料夾內的檔案。
                </p>
                <WorkspacePaths
                  paths={draft.allowedPaths}
                  onChange={paths => update('allowedPaths', paths)}
                />
              </div>

              {/* Readonly toggle — put here because it's about workspace access */}
              <div
                className="flex items-center gap-3 rounded-xl px-4 py-3"
                style={{ background: '#fafaf8', border: '1px solid #e2e0db' }}
              >
                <div
                  onClick={() => update('readonlyMode', !draft.readonlyMode)}
                  className="relative w-10 h-5 rounded-full transition-colors cursor-pointer flex-shrink-0"
                  style={{ background: draft.readonlyMode ? '#f59e0b' : '#d1d5db' }}
                >
                  <span
                    className="absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform"
                    style={{ transform: draft.readonlyMode ? 'translateX(20px)' : 'translateX(0)' }}
                  />
                </div>
                <div>
                  <p className="text-sm font-medium" style={{ color: '#333' }}>唯讀模式</p>
                  <p className="text-xs mt-0.5" style={{ color: '#999' }}>
                    禁用所有寫入工具；md_convert 輸出導向暫存目錄
                  </p>
                </div>
              </div>
            </div>
          )}

          {/* Tab: 工具設定 */}
          {tab === 'tools' && (
            <div className="max-w-2xl">
              <h3 className="text-sm font-semibold mb-1" style={{ color: '#333' }}>工具啟用／禁用</h3>
              <p className="text-xs mb-4" style={{ color: '#999' }}>
                控制此端點對外暴露的 MCP 工具。
              </p>
              <ToolsGrid
                disabledTools={draft.disabledTools}
                readonlyMode={draft.readonlyMode}
                onChange={tools => update('disabledTools', tools)}
              />
            </div>
          )}

          {/* Tab: 進階設定 */}
          {tab === 'advanced' && (
            <div className="space-y-5 max-w-2xl">
              <div>
                <h3 className="text-sm font-semibold mb-4" style={{ color: '#333' }}>連線設定</h3>
                <div className="space-y-3">
                  <div className="flex gap-3">
                    <div className="flex-1">
                      <label className="block text-xs font-medium mb-1.5" style={{ color: '#555' }}>Host</label>
                      <input
                        value={draft.host}
                        onChange={e => update('host', e.target.value)}
                        className="w-full rounded-lg px-3 py-2 text-sm focus:outline-none"
                        style={{ background: '#fff', border: '1px solid #ddd', color: '#1a1a1a' }}
                      />
                    </div>
                    <div style={{ width: '120px' }}>
                      <label className="block text-xs font-medium mb-1.5" style={{ color: '#555' }}>Port</label>
                      <input
                        type="number"
                        defaultValue={draft.port}
                        onBlur={e => handlePortChange(e.target.value)}
                        className="w-full rounded-lg px-3 py-2 text-sm focus:outline-none"
                        style={{ background: '#fff', border: `1px solid ${portError ? '#f87171' : '#ddd'}`, color: '#1a1a1a' }}
                      />
                      {portError && <p className="text-xs text-red-400 mt-1">{portError}</p>}
                    </div>
                  </div>
                  <div>
                    <label className="block text-xs font-medium mb-1.5" style={{ color: '#555' }}>
                      Bearer Token
                      <span className="font-normal ml-1" style={{ color: '#bbb' }}>（留空則不驗證）</span>
                    </label>
                    <div className="flex gap-2">
                      <input
                        type={showToken ? 'text' : 'password'}
                        value={draft.bearerToken ?? ''}
                        onChange={e => update('bearerToken', e.target.value || null)}
                        placeholder="（無）"
                        className="flex-1 rounded-lg px-3 py-2 text-sm focus:outline-none"
                        style={{ background: '#fff', border: '1px solid #ddd', color: '#1a1a1a' }}
                      />
                      <button
                        onClick={() => setShowToken(s => !s)}
                        className="px-3 rounded-lg text-xs"
                        style={{ background: '#efefec', color: '#666', border: '1px solid #ddd' }}
                      >
                        {showToken ? '隱藏' : '顯示'}
                      </button>
                    </div>
                  </div>
                  <div>
                    <label className="block text-xs font-medium mb-1.5" style={{ color: '#555' }}>白名單檔案名稱</label>
                    <input
                      value={draft.whitelistFilename}
                      onChange={e => update('whitelistFilename', e.target.value)}
                      className="w-full rounded-lg px-3 py-2 text-sm focus:outline-none"
                      style={{ background: '#fff', border: '1px solid #ddd', color: '#1a1a1a' }}
                    />
                  </div>
                </div>
              </div>

              <div
                className="flex items-center gap-3 rounded-xl px-4 py-3"
                style={{ background: '#fafaf8', border: '1px solid #e2e0db' }}
              >
                <div
                  onClick={() => update('autoStart', !draft.autoStart)}
                  className="relative w-10 h-5 rounded-full transition-colors cursor-pointer flex-shrink-0"
                  style={{ background: draft.autoStart ? '#4a9e6e' : '#d1d5db' }}
                >
                  <span
                    className="absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform"
                    style={{ transform: draft.autoStart ? 'translateX(20px)' : 'translateX(0)' }}
                  />
                </div>
                <div>
                  <p className="text-sm font-medium" style={{ color: '#333' }}>應用程式啟動時自動執行</p>
                  <p className="text-xs mt-0.5" style={{ color: '#999' }}>開啟應用程式時自動啟動此端點</p>
                </div>
              </div>
            </div>
          )}

        </div>
      </div>

      {/* ── Log panel ── */}
      <div className="flex-shrink-0" style={{ height: '180px', borderTop: '1px solid #e2e0db' }}>
        <LogPanel endpointId={endpoint.id} />
      </div>

    </div>
  )
}
