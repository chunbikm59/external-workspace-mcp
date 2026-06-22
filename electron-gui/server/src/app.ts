import express from 'express'
import { randomUUID } from 'node:crypto'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js'
import type { RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { ServerConfig } from './config.js'
import type { WhitelistEntry } from './whitelist.js'
import { bearerAuth, adminAuth } from './auth.js'
import { createDownloadRouter, captureSessionBaseUrl } from './download.js'
import { loadWhitelist } from './whitelist.js'
import { resolvePendingReload } from './pendingReload.js'
import { registerReadFile } from './tools/readFile.js'
import { registerGrepFiles } from './tools/grepFiles.js'
import { registerGlobFiles } from './tools/globFiles.js'
import { registerRunCommand } from './tools/runCommand.js'
import { registerWorkspaceTools } from './tools/workspaceContext.js'
import { registerGetDownloadUri } from './tools/getDownloadUri.js'
import { registerFsTools } from './tools/fsTools.js'
import { registerConvertToMarkdown, getTempDirForMarkdown } from './tools/convertToMarkdown.js'
import { registerCapturePptSlides, getTempDirForPptCapture } from './tools/capturePptSlides.js'
import { applyToolFilter } from './middleware/toolFilter.js'
import { emitStructuredLog } from './logger.js'

interface SessionEntry {
  transport: StreamableHTTPServerTransport
  connectedAt: number
}

export const CONNECTION_CHANGE_MARKER = '__MCP_CONNECTION_CHANGE__ '

function emitConnectionChange(activeConnections: number): void {
  console.log(`${CONNECTION_CHANGE_MARKER}${JSON.stringify({ active_connections: activeConnections })}`)
}

const PARAMS_SUMMARY_MAX_LENGTH = 200

function summarizeParams(params: unknown): string {
  if (params === undefined) return ''
  let json: string
  try {
    json = JSON.stringify(params)
  } catch {
    return ''
  }
  return json.length > PARAMS_SUMMARY_MAX_LENGTH
    ? `${json.slice(0, PARAMS_SUMMARY_MAX_LENGTH)}…`
    : json
}

function logMcpRequest(req: express.Request, res: express.Response): void {
  const body = req.body as { method?: string; params?: { name?: string; arguments?: unknown } } | undefined
  const method = body?.method
  if (!method) return

  if (method === 'tools/call') {
    const toolName = body?.params?.name ?? '(unknown)'
    const argsSummary = summarizeParams(body?.params?.arguments)
    emitStructuredLog('info', `工具呼叫：${toolName} ${argsSummary}`.trim())

    const startedAt = Date.now()
    res.on('finish', () => {
      const elapsedMs = Date.now() - startedAt
      const outcome = res.statusCode >= 200 && res.statusCode < 300 ? '成功' : `失敗（HTTP ${res.statusCode}）`
      emitStructuredLog('debug', `工具完成：${toolName} ${outcome}，耗時 ${elapsedMs}ms`)
    })
    return
  }

  emitStructuredLog('debug', `MCP 請求：${method}`)
}

function createMcpServer(
  config: ServerConfig,
  whitelist: WhitelistEntry[],
  rgPath: string,
  endpointId: string,
  reloadWhitelistCallback: (newEntries: WhitelistEntry[]) => void,
): McpServer {
  const mcp = new McpServer({
    name: 'MCP Workspace Server',
    version: '1.0.0',
  })

  const tools = new Map<string, RegisteredTool>()
  const tempDirs = [getTempDirForMarkdown(endpointId), getTempDirForPptCapture(endpointId)]

  tools.set('read_file', registerReadFile(mcp, config.allowedPaths, tempDirs))
  tools.set('grep_files', registerGrepFiles(mcp, config.allowedPaths, rgPath, tempDirs))
  tools.set('glob_files', registerGlobFiles(mcp, config.allowedPaths, rgPath, tempDirs))
  tools.set('cmd_run_command', registerRunCommand(mcp, config.allowedPaths, whitelist))

  const workspaceTools = registerWorkspaceTools(
    mcp,
    config.allowedPaths,
    whitelist,
    config.whitelistFilename,
    config.guiMode,
    reloadWhitelistCallback,
  )
  for (const [name, tool] of Object.entries(workspaceTools)) {
    tools.set(name, tool)
  }

  tools.set(
    'file_get_download_uri',
    registerGetDownloadUri(mcp, config.allowedPaths, config.host, config.port, tempDirs),
  )

  registerFsTools(mcp, config.allowedPaths, tools, tempDirs)

  tools.set(
    'md_convert_to_markdown',
    registerConvertToMarkdown(mcp, config.allowedPaths, config.readonlyMode, endpointId),
  )

  tools.set(
    'md_capture_ppt_slides',
    registerCapturePptSlides(mcp, config.allowedPaths, config.readonlyMode, endpointId),
  )

  applyToolFilter(tools, config.disabledTools, config.readonlyMode)

  return mcp
}

export function buildApp(
  config: ServerConfig,
  whitelist: WhitelistEntry[],
  rgPath: string,
  endpointId: string,
  reloadWhitelistCallback: (newEntries: WhitelistEntry[]) => void,
): express.Application {
  const app = express()
  app.use(express.json())

  // Streamable HTTP transport（stateful）— 依 mcp-session-id 重複使用同一個 transport，
  // 讓 GET（SSE）/ DELETE（終止）能對應到正確的連線，並可統計目前連線數。
  const sessions = new Map<string, SessionEntry>()

  app.post(
    '/mcp',
    bearerAuth(config.bearerToken),
    async (req, res) => {
      captureSessionBaseUrl(req, config.host, config.port)
      logMcpRequest(req, res)
      const sessionId = req.headers['mcp-session-id'] as string | undefined

      if (sessionId && sessions.has(sessionId)) {
        await sessions.get(sessionId)!.transport.handleRequest(req, res, req.body)
        return
      }

      if (!sessionId && isInitializeRequest(req.body)) {
        const mcp = createMcpServer(config, whitelist, rgPath, endpointId, reloadWhitelistCallback)
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (newSessionId) => {
            sessions.set(newSessionId, { transport, connectedAt: Date.now() })
            emitConnectionChange(sessions.size)
          },
        })
        transport.onclose = () => {
          const sid = transport.sessionId
          if (sid && sessions.delete(sid)) {
            emitConnectionChange(sessions.size)
          }
        }
        await mcp.connect(transport)
        await transport.handleRequest(req, res, req.body)
        return
      }

      res.status(400).json({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Bad Request: No valid session ID provided' },
        id: null,
      })
    },
  )

  app.get(
    '/mcp',
    bearerAuth(config.bearerToken),
    async (req, res) => {
      const sessionId = req.headers['mcp-session-id'] as string | undefined
      const session = sessionId ? sessions.get(sessionId) : undefined
      if (!session) {
        res.status(400).send('Invalid or missing session ID')
        return
      }
      // GET 是 client 維持的長駐 SSE 串流，其底層 socket 關閉是偵測「client 異常斷線」
      // （程式被砍掉、斷網等，沒有送出 DELETE /mcp）唯一可靠的訊號 —— transport.onclose
      // 只在收到明確的 DELETE 時才會觸發，無法偵測這種情況。
      req.on('close', () => {
        if (sessionId && sessions.delete(sessionId)) {
          emitConnectionChange(sessions.size)
        }
      })
      await session.transport.handleRequest(req, res)
    },
  )

  app.delete(
    '/mcp',
    bearerAuth(config.bearerToken),
    async (req, res) => {
      const sessionId = req.headers['mcp-session-id'] as string | undefined
      const session = sessionId ? sessions.get(sessionId) : undefined
      if (!session) {
        res.status(400).send('Invalid or missing session ID')
        return
      }
      await session.transport.handleRequest(req, res)
    },
  )

  app.get('/health', (_req, res) => {
    res.json({
      status: 'ok',
      allowed_paths: config.allowedPaths,
      whitelist_count: whitelist.length,
      readonly_mode: config.readonlyMode,
      active_connections: sessions.size,
    })
  })

  app.use(createDownloadRouter())

  app.post(
    '/admin/reload-whitelist',
    adminAuth(config.adminToken),
    (_req, res) => {
      const newEntries = loadWhitelist(config.allowedPaths, config.whitelistFilename)
      reloadWhitelistCallback(newEntries)
      res.json({
        success: true,
        message: `白名單已重新載入，共 ${newEntries.length} 個命令。`,
        commands: newEntries.map(e => e.command),
      })
    },
  )

  app.post(
    '/admin/pending-reload/:id/resolve',
    adminAuth(config.adminToken),
    (req, res) => {
      const id = req.params['id']
      if (!id || Array.isArray(id)) {
        res.status(400).json({ error: 'Missing id' })
        return
      }
      const approved = Boolean((req.body as { approved?: boolean } | undefined)?.approved)
      const found = resolvePendingReload(id, approved)
      if (!found) {
        res.status(404).json({ error: 'No such pending request' })
        return
      }
      res.json({ success: true })
    },
  )

  return app
}
