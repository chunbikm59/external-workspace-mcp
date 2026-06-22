import fs from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import { randomUUID } from 'node:crypto'
import type { EndpointConfig } from '../shared/types.js'

// 攜帶版：設定與暫存都存在程式 exe 旁邊的 data/ 目錄，整包複製即可帶著走，
// 不依賴系統 userData。開發模式（未打包）則存在 userData 避免污染專案目錄。
function getPortableRoot(): string {
  if (app.isPackaged) {
    return path.join(path.dirname(app.getPath('exe')), 'data')
  }
  return path.join(app.getPath('userData'), 'mcp-gui')
}

function getConfigDir(): string { return getPortableRoot() }
function getConfigFile(): string { return path.join(getConfigDir(), 'endpoints.json') }
function getTempDir(): string { return path.join(getPortableRoot(), 'servers') }

interface ConfigFile {
  version: number
  endpoints: EndpointConfig[]
}

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
}

function readConfig(): ConfigFile {
  const configDir = getConfigDir()
  const configFile = getConfigFile()
  ensureDir(configDir)
  if (!fs.existsSync(configFile)) {
    return { version: 1, endpoints: [] }
  }
  try {
    return JSON.parse(fs.readFileSync(configFile, 'utf-8')) as ConfigFile
  } catch {
    return { version: 1, endpoints: [] }
  }
}

function writeConfig(config: ConfigFile): void {
  ensureDir(getConfigDir())
  fs.writeFileSync(getConfigFile(), JSON.stringify(config, null, 2), 'utf-8')
}

export function getEndpoints(): EndpointConfig[] {
  return readConfig().endpoints
}

export function saveEndpoint(endpoint: EndpointConfig): void {
  const config = readConfig()
  const idx = config.endpoints.findIndex(e => e.id === endpoint.id)
  if (idx >= 0) {
    config.endpoints[idx] = endpoint
  } else {
    config.endpoints.push(endpoint)
  }
  writeConfig(config)
}

export function deleteEndpoint(id: string): void {
  const config = readConfig()
  config.endpoints = config.endpoints.filter(e => e.id !== id)
  writeConfig(config)
  // clean up temp config
  const tempPath = getTempConfigPath(id)
  if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath)
}

function pickPort(): number {
  const used = new Set(readConfig().endpoints.map(e => e.port))
  let port = 8100
  while (used.has(port)) port++
  return port
}

export function createEndpoint(name: string): EndpointConfig {
  const ep: EndpointConfig = {
    id: randomUUID(),
    name,
    enabled: true,
    host: '0.0.0.0',
    port: pickPort(),
    bearerToken: null,
    allowedPaths: [],
    whitelistFilename: '.cmd_whitelist.json',
    readonlyMode: false,
    disabledTools: [],
    autoStart: false,
  }
  saveEndpoint(ep)
  return ep
}

export function getTempConfigPath(endpointId: string): string {
  return path.join(getTempDir(), `mcp-server-${endpointId}.json`)
}

export function writeTempConfig(endpoint: EndpointConfig): string {
  ensureDir(getTempDir())
  const tempPath = getTempConfigPath(endpoint.id)

  const serverConfig = {
    host: endpoint.host,
    port: endpoint.port,
    ...(endpoint.bearerToken ? { 'bearer-token': endpoint.bearerToken } : {}),
    allowed_paths: endpoint.allowedPaths,
    whitelist_filename: endpoint.whitelistFilename,
    readonlyMode: endpoint.readonlyMode,
    disabledTools: endpoint.disabledTools,
  }

  fs.writeFileSync(tempPath, JSON.stringify(serverConfig, null, 2), 'utf-8')
  return tempPath
}

export function getAutoStartEndpoints(): EndpointConfig[] {
  return getEndpoints().filter(e => e.enabled && e.autoStart)
}
