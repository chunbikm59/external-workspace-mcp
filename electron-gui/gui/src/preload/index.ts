import { contextBridge, ipcRenderer } from 'electron'
import type { ConnectionStats, ConnectionStatsChange, EndpointConfig, ServerStatus, LogLine, StatusChange } from '../shared/types.js'

type Unsubscribe = () => void

const api = {
  // Endpoint CRUD
  getEndpoints: (): Promise<EndpointConfig[]> => ipcRenderer.invoke('endpoint:getAll'),
  saveEndpoint: (endpoint: EndpointConfig): Promise<void> => ipcRenderer.invoke('endpoint:save', endpoint),
  deleteEndpoint: (id: string): Promise<void> => ipcRenderer.invoke('endpoint:delete', id),
  createEndpoint: (name: string): Promise<EndpointConfig> => ipcRenderer.invoke('endpoint:create', name),

  // Server control
  startServer: (endpoint: EndpointConfig): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('server:start', endpoint),
  stopServer: (endpointId: string): Promise<void> => ipcRenderer.invoke('server:stop', endpointId),
  restartServer: (endpoint: EndpointConfig): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('server:restart', endpoint),
  getServerStatus: (endpointId: string): Promise<ServerStatus> =>
    ipcRenderer.invoke('server:getStatus', endpointId),
  getServerLogs: (endpointId: string): Promise<string[]> =>
    ipcRenderer.invoke('server:getLogs', endpointId),
  getConnectionStats: (endpointId: string): Promise<ConnectionStats> =>
    ipcRenderer.invoke('server:getConnectionStats', endpointId),

  // Dialog
  browseFolder: (): Promise<string | null> => ipcRenderer.invoke('dialog:browseFolder'),
  checkPort: (port: number): Promise<{ available: boolean }> =>
    ipcRenderer.invoke('system:checkPort', port),
  openPath: (p: string): Promise<void> => ipcRenderer.invoke('shell:openPath', p),
  copyToClipboard: (text: string): Promise<void> => ipcRenderer.invoke('shell:copyToClipboard', text),
  reloadWhitelist: (
    endpoint: EndpointConfig,
  ): Promise<{ ok: boolean; error?: string; cancelled?: boolean; message?: string; commands?: string[] }> =>
    ipcRenderer.invoke('whitelist:reload', endpoint),

  // Event subscriptions
  onLogLine: (callback: (payload: LogLine) => void): Unsubscribe => {
    const handler = (_: Electron.IpcRendererEvent, payload: LogLine) => callback(payload)
    ipcRenderer.on('log:line', handler)
    return () => ipcRenderer.removeListener('log:line', handler)
  },
  onStatusChanged: (callback: (payload: StatusChange) => void): Unsubscribe => {
    const handler = (_: Electron.IpcRendererEvent, payload: StatusChange) => callback(payload)
    ipcRenderer.on('status:changed', handler)
    return () => ipcRenderer.removeListener('status:changed', handler)
  },
  onConnectionStatsChanged: (callback: (payload: ConnectionStatsChange) => void): Unsubscribe => {
    const handler = (_: Electron.IpcRendererEvent, payload: ConnectionStatsChange) => callback(payload)
    ipcRenderer.on('connections:changed', handler)
    return () => ipcRenderer.removeListener('connections:changed', handler)
  },
}

contextBridge.exposeInMainWorld('electronAPI', api)

export type ElectronAPI = typeof api
