import { spawn, type ChildProcess } from 'node:child_process'
import path from 'node:path'
import http from 'node:http'
import { randomUUID } from 'node:crypto'
import { app, BrowserWindow, dialog } from 'electron'
import type { ConnectionStats, EndpointConfig, LogLevel, ServerStatus } from '../shared/types.js'
import { writeTempConfig, getTempConfigPath } from './configManager.js'
import fs from 'node:fs'

interface ManagedServer {
  process: ChildProcess
  config: EndpointConfig
  status: ServerStatus
  healthTimer: ReturnType<typeof setInterval> | null
  healthFailCount: number
  logs: string[]
  adminToken: string
  stdoutBuffer: string
  connectionStats: ConnectionStats
  intentionalStop: boolean
}

const RELOAD_REQUEST_MARKER = '__MCP_RELOAD_REQUEST__ '
const CONNECTION_CHANGE_MARKER = '__MCP_CONNECTION_CHANGE__ '
const LOG_MARKER = '__MCP_LOG__ '

const servers = new Map<string, ManagedServer>()

function getServerBundlePath(): string {
  // In production: server bundle is in resources/server/dist/main.js (see prepare-server-resources.mjs)
  // In dev: use the built dist from the server workspace
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'server', 'dist', 'main.js')
  }
  return path.join(__dirname, '../../..', 'server', 'dist', 'main.js')
}

let bundleWatcher: fs.FSWatcher | null = null
let bundleRestartTimer: ReturnType<typeof setTimeout> | null = null

function watchBundleForDevReload(): void {
  if (app.isPackaged || bundleWatcher) return

  const bundlePath = getServerBundlePath()
  const bundleDir = path.dirname(bundlePath)
  if (!fs.existsSync(bundleDir)) return

  bundleWatcher = fs.watch(bundleDir, (_event, filename) => {
    if (filename && filename !== path.basename(bundlePath)) return
    if (bundleRestartTimer) clearTimeout(bundleRestartTimer)
    // debounce: tsup rewrites several files in dist/ per rebuild
    bundleRestartTimer = setTimeout(() => {
      bundleRestartTimer = null
      void restartRunningServersForDev()
    }, 300)
  })
}

async function restartRunningServersForDev(): Promise<void> {
  const running = [...servers.entries()].filter(
    ([, srv]) => srv.status === 'running' || srv.status === 'starting',
  )
  for (const [endpointId, srv] of running) {
    emitLog(endpointId, '偵測到 server bundle 變動，正在自動重新啟動', 'info')
    await restartServer(srv.config)
  }
}

export function emitLog(endpointId: string, line: string, level: LogLevel = 'info'): void {
  const wins = BrowserWindow.getAllWindows()
  for (const win of wins) {
    win.webContents.send('log:line', {
      endpointId,
      line: line.trimEnd(),
      level,
      isError: level === 'error',
      timestamp: Date.now(),
    })
  }
}

function callAdminEndpoint(
  config: EndpointConfig,
  adminToken: string,
  routePath: string,
  body: unknown,
): Promise<{ status: number; json: unknown }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body ?? {})
    const req = http.request(
      {
        host: config.host === '0.0.0.0' ? '127.0.0.1' : config.host,
        port: config.port,
        path: routePath,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
          Authorization: `Bearer ${adminToken}`,
        },
        timeout: 5000,
      },
      res => {
        let data = ''
        res.on('data', chunk => { data += chunk })
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode ?? 0, json: data ? JSON.parse(data) : null })
          } catch {
            resolve({ status: res.statusCode ?? 0, json: null })
          }
        })
      },
    )
    req.on('error', reject)
    req.on('timeout', () => { req.destroy(); reject(new Error('request timeout')) })
    req.write(payload)
    req.end()
  })
}

async function handleStdoutMarkers(
  endpointId: string,
  managed: ManagedServer,
  chunk: string,
): Promise<void> {
  managed.stdoutBuffer += chunk
  const lines = managed.stdoutBuffer.split('\n')
  managed.stdoutBuffer = lines.pop() ?? ''

  for (const line of lines) {
    const connIdx = line.indexOf(CONNECTION_CHANGE_MARKER)
    if (connIdx !== -1) {
      try {
        const payload = JSON.parse(line.slice(connIdx + CONNECTION_CHANGE_MARKER.length)) as {
          active_connections?: number
        }
        const stats: ConnectionStats = { active: payload.active_connections ?? 0 }
        if (stats.active !== managed.connectionStats.active) {
          managed.connectionStats = stats
          emitConnectionStats(endpointId, stats)
        }
      } catch (err) {
        emitLog(endpointId, `連線狀態訊息解析失敗：${String(err)}`, 'warn')
      }
      continue
    }

    const logIdx = line.indexOf(LOG_MARKER)
    if (logIdx !== -1) {
      try {
        const payload = JSON.parse(line.slice(logIdx + LOG_MARKER.length)) as {
          level?: LogLevel
          message?: string
        }
        emitLog(endpointId, payload.message ?? '', payload.level ?? 'info')
      } catch (err) {
        emitLog(endpointId, `結構化日誌解析失敗：${String(err)}`, 'warn')
      }
      continue
    }

    const idx = line.indexOf(RELOAD_REQUEST_MARKER)
    if (idx === -1) continue

    try {
      const payload = JSON.parse(line.slice(idx + RELOAD_REQUEST_MARKER.length)) as {
        id: string
        commands: string[]
      }
      const wins = BrowserWindow.getAllWindows()
      const win = wins.find(w => !w.isDestroyed()) ?? null

      const { response } = await dialog.showMessageBox(win ?? undefined as never, {
        type: 'question',
        title: '白名單重新載入請求',
        message: `遠端 agent 要求重新載入白名單（${managed.config.name}）`,
        detail: `套用後將允許以下命令：\n${payload.commands.map(c => `  - ${c}`).join('\n') || '（白名單為空）'}`,
        buttons: ['核准', '拒絕'],
        defaultId: 1,
        cancelId: 1,
      })
      const approved = response === 0

      await callAdminEndpoint(managed.config, managed.adminToken, `/admin/pending-reload/${payload.id}/resolve`, {
        approved,
      })
    } catch (err) {
      emitLog(endpointId, `處理白名單重載請求失敗：${String(err)}`, 'error')
    }
  }
}

function emitStatus(endpointId: string, status: ServerStatus): void {
  const wins = BrowserWindow.getAllWindows()
  for (const win of wins) {
    win.webContents.send('status:changed', { endpointId, status })
  }
}

function emitConnectionStats(endpointId: string, stats: ConnectionStats): void {
  const wins = BrowserWindow.getAllWindows()
  for (const win of wins) {
    win.webContents.send('connections:changed', { endpointId, stats })
  }
}

function updateStatus(endpointId: string, status: ServerStatus): void {
  const srv = servers.get(endpointId)
  if (srv) srv.status = status
  emitStatus(endpointId, status)
}

function startHealthCheck(endpointId: string): void {
  const srv = servers.get(endpointId)
  if (!srv) return

  let successCount = 0
  srv.healthFailCount = 0

  const check = () => {
    const { config } = srv
    const req = http.get(
      `http://${config.host === '0.0.0.0' ? '127.0.0.1' : config.host}:${config.port}/health`,
      res => {
        if (res.statusCode === 200) {
          successCount++
          srv.healthFailCount = 0

          let body = ''
          res.on('data', chunk => { body += chunk })
          res.on('end', () => {
            try {
              const parsed = JSON.parse(body) as { active_connections?: number }
              const stats: ConnectionStats = { active: parsed.active_connections ?? 0 }
              if (stats.active !== srv.connectionStats.active) {
                srv.connectionStats = stats
                emitConnectionStats(endpointId, stats)
              }
            } catch { /* ignore malformed health body */ }
          })

          if (successCount >= 3 && srv.status === 'starting') {
            updateStatus(endpointId, 'running')
            emitLog(endpointId, '伺服器已啟動並通過健康檢查', 'info')
            // slow down health check after running, but keep it frequent enough
            // for the connection-count display to feel responsive
            if (srv.healthTimer) clearInterval(srv.healthTimer)
            srv.healthTimer = setInterval(check, 5_000)
          }
        } else {
          onHealthFail()
          res.resume()
        }
      },
    )
    req.on('error', onHealthFail)
    req.setTimeout(3000, () => { req.destroy(); onHealthFail() })
  }

  const onHealthFail = () => {
    srv.healthFailCount++
    if (srv.healthFailCount >= 5 && srv.status !== 'stopped') {
      updateStatus(endpointId, 'error')
      emitLog(endpointId, '健康檢查失敗，伺服器可能無回應', 'error')
      if (srv.healthTimer) clearInterval(srv.healthTimer)
      srv.healthTimer = null
    }
  }

  srv.healthTimer = setInterval(check, 2000)
}

export async function startServer(endpoint: EndpointConfig): Promise<{ ok: boolean; error?: string }> {
  emitLog(endpoint.id, `正在啟動伺服器（${endpoint.host}:${endpoint.port}）`, 'info')

  if (servers.has(endpoint.id)) {
    const existing = servers.get(endpoint.id)!
    if (existing.status === 'running' || existing.status === 'starting') {
      emitLog(endpoint.id, '啟動失敗：端點已在執行中', 'warn')
      return { ok: false, error: '端點已在執行中' }
    }
    await stopServer(endpoint.id)
  }

  if (endpoint.allowedPaths.length === 0) {
    emitLog(endpoint.id, '啟動失敗：請先設定至少一個工作資料夾', 'error')
    return { ok: false, error: '請先設定至少一個工作資料夾' }
  }

  const bundlePath = getServerBundlePath()
  if (!fs.existsSync(bundlePath)) {
    emitLog(endpoint.id, `啟動失敗：找不到 server bundle：${bundlePath}`, 'error')
    return { ok: false, error: `找不到 server bundle：${bundlePath}` }
  }

  const tempConfigPath = writeTempConfig(endpoint)
  const adminToken = randomUUID()

  const proc = spawn(process.execPath, [bundlePath, '--config', tempConfigPath], {
    env: {
      ...process.env,
      // 打包後 process.execPath 是 Electron 主程式 exe；若不設此旗標，
      // spawn 會再啟動一個完整 Electron app（開新視窗），造成無限跳視窗。
      // ELECTRON_RUN_AS_NODE 讓 Electron exe 以純 Node 模式執行 server bundle。
      ELECTRON_RUN_AS_NODE: '1',
      MCP_GUI_MODE: '1',
      MCP_ENDPOINT_ID: endpoint.id,
      MCP_ADMIN_TOKEN: adminToken,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  const managed: ManagedServer = {
    process: proc,
    config: endpoint,
    status: 'starting',
    healthTimer: null,
    healthFailCount: 0,
    logs: [],
    adminToken,
    stdoutBuffer: '',
    connectionStats: { active: 0 },
    intentionalStop: false,
  }
  servers.set(endpoint.id, managed)
  emitStatus(endpoint.id, 'starting')

  proc.stdout?.on('data', (chunk: Buffer) => {
    const text = chunk.toString()
    managed.logs.push(text)
    if (managed.logs.length > 500) managed.logs.shift()
    if (!text.includes(LOG_MARKER)) emitLog(endpoint.id, text, 'info')
    handleStdoutMarkers(endpoint.id, managed, text)
  })

  proc.stderr?.on('data', (chunk: Buffer) => {
    const text = chunk.toString()
    managed.logs.push(text)
    if (managed.logs.length > 500) managed.logs.shift()
    emitLog(endpoint.id, text, 'error')
  })

  proc.on('exit', (code) => {
    if (managed.healthTimer) clearInterval(managed.healthTimer)
    managed.healthTimer = null
    if (managed.intentionalStop) {
      updateStatus(endpoint.id, 'stopped')
      emitLog(endpoint.id, '伺服器已停止', 'info')
    } else {
      const finalStatus: ServerStatus = code === 0 ? 'stopped' : 'error'
      updateStatus(endpoint.id, finalStatus)
      if (code === 0) {
        emitLog(endpoint.id, '子程序已結束', 'info')
      } else {
        emitLog(endpoint.id, `子程序異常結束（exit code: ${code}）`, 'error')
      }
    }
    servers.delete(endpoint.id)
  })

  proc.on('error', (err) => {
    emitLog(endpoint.id, `子程序錯誤：${err.message}`, 'error')
    if (!managed.intentionalStop) {
      updateStatus(endpoint.id, 'error')
    }
  })

  startHealthCheck(endpoint.id)
  watchBundleForDevReload()
  return { ok: true }
}

export async function stopServer(endpointId: string): Promise<void> {
  const srv = servers.get(endpointId)
  if (!srv) return
  srv.intentionalStop = true
  if (srv.healthTimer) clearInterval(srv.healthTimer)
  srv.healthTimer = null
  updateStatus(endpointId, 'stopping')

  await new Promise<void>(resolve => {
    srv.process.once('exit', () => resolve())
    srv.process.kill()
  })

  // clean up temp config
  const tempPath = getTempConfigPath(endpointId)
  if (fs.existsSync(tempPath)) {
    try { fs.unlinkSync(tempPath) } catch (err) {
      emitLog(endpointId, `清理暫存設定檔失敗：${String(err)}`, 'warn')
    }
  }
}

export async function restartServer(endpoint: EndpointConfig): Promise<{ ok: boolean; error?: string }> {
  emitLog(endpoint.id, '正在重新啟動伺服器', 'info')
  await stopServer(endpoint.id)
  // brief pause to let port release
  await new Promise(r => setTimeout(r, 500))
  return startServer(endpoint)
}

export async function reloadWhitelist(
  endpoint: EndpointConfig,
): Promise<{ ok: boolean; error?: string; message?: string; commands?: string[] }> {
  const srv = servers.get(endpoint.id)
  if (!srv || srv.status !== 'running') {
    return { ok: false, error: '伺服器未在執行中' }
  }
  try {
    const { status, json } = await callAdminEndpoint(endpoint, srv.adminToken, '/admin/reload-whitelist', {})
    if (status !== 200) {
      emitLog(endpoint.id, `白名單重新載入失敗（HTTP ${status}）`, 'error')
      return { ok: false, error: `重新載入失敗（HTTP ${status}）` }
    }
    const result = json as { success: boolean; message: string; commands: string[] }
    emitLog(endpoint.id, '白名單已重新載入', 'info')
    return { ok: true, message: result.message, commands: result.commands }
  } catch (err) {
    emitLog(endpoint.id, `白名單重新載入失敗：${String(err)}`, 'error')
    return { ok: false, error: String(err) }
  }
}

export function getServerStatus(endpointId: string): ServerStatus {
  return servers.get(endpointId)?.status ?? 'stopped'
}

export function getServerLogs(endpointId: string): string[] {
  return servers.get(endpointId)?.logs ?? []
}

export function getConnectionStats(endpointId: string): ConnectionStats {
  return servers.get(endpointId)?.connectionStats ?? { active: 0 }
}

export function stopAllServers(): Promise<void[]> {
  if (bundleRestartTimer) clearTimeout(bundleRestartTimer)
  bundleWatcher?.close()
  bundleWatcher = null
  return Promise.all([...servers.keys()].map(id => stopServer(id)))
}
