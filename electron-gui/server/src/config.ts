import fs from 'node:fs'
import path from 'node:path'

export interface ServerConfig {
  host: string
  port: number
  bearerToken?: string
  allowedPaths: string[]
  whitelistFilename: string
  readonlyMode: boolean
  disabledTools: string[]
  guiMode: boolean
  rgPath?: string
  adminToken?: string
}

export interface WhitelistEntry {
  command: string
  description?: string
}

const DEFAULTS = {
  host: '0.0.0.0',
  port: 8100,
  whitelistFilename: '.cmd_whitelist.json',
}

function loadConfigFile(configPath: string | undefined): Record<string, unknown> {
  const candidates: string[] = []

  if (configPath) {
    candidates.push(configPath)
  } else {
    const envPath = process.env['MCP_SERVER_CONFIG'] ?? process.env['MCP_PROXY_CONFIG']
    if (envPath) candidates.push(envPath)
    candidates.push(
      path.join(process.cwd(), '.mcp-server.json'),
      path.join(process.cwd(), '.mcp-proxy.json'),
      path.join(process.cwd(), 'config', 'config.json'),
    )
  }

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      try {
        const raw = fs.readFileSync(candidate, 'utf-8')
        console.log(`[INFO] 載入設定檔：${candidate}`)
        return JSON.parse(raw) as Record<string, unknown>
      } catch (err) {
        console.warn(`[WARN] 設定檔解析失敗：${candidate}:`, err)
      }
    }
  }

  return {}
}

function resolveAllowedPaths(raw: unknown): string[] {
  if (!raw || !Array.isArray(raw) || raw.length === 0) {
    return [path.resolve(process.cwd())]
  }
  return (raw as string[]).map(p => path.resolve(p))
}

export interface CliArgs {
  host?: string
  port?: number
  bearerToken?: string
  config?: string
  allowedPaths?: string[]
}

export function loadConfig(cli: CliArgs): ServerConfig {
  const file = loadConfigFile(cli.config)

  const allowedPaths =
    cli.allowedPaths && cli.allowedPaths.length > 0
      ? cli.allowedPaths.map(p => path.resolve(p))
      : resolveAllowedPaths(file['allowed_paths'])

  return {
    host: cli.host ?? (file['host'] as string | undefined) ?? DEFAULTS.host,
    port: cli.port ?? (file['port'] as number | undefined) ?? DEFAULTS.port,
    bearerToken:
      cli.bearerToken ??
      (file['bearer-token'] as string | undefined) ??
      (file['bearerToken'] as string | undefined),
    allowedPaths,
    whitelistFilename:
      (file['whitelist_filename'] as string | undefined) ??
      (file['whitelistFilename'] as string | undefined) ??
      DEFAULTS.whitelistFilename,
    readonlyMode: Boolean(file['readonlyMode'] ?? false),
    disabledTools: Array.isArray(file['disabledTools'])
      ? (file['disabledTools'] as string[])
      : [],
    guiMode: Boolean(process.env['MCP_GUI_MODE']),
    adminToken: process.env['MCP_ADMIN_TOKEN'],
  }
}

export function isPathAllowed(targetPath: string, allowedPaths: string[], tempDirs?: string[]): boolean {
  const resolved = path.resolve(targetPath)
  if (allowedPaths.some(base => resolved === base || resolved.startsWith(base + path.sep))) {
    return true
  }
  if (tempDirs) {
    return tempDirs.some(base => resolved === base || resolved.startsWith(base + path.sep))
  }
  return false
}
