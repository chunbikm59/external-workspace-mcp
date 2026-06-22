import fs from 'node:fs'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { isPathAllowed } from '../config.js'
import {
  createDownloadToken,
  getDownloadUrl,
  sessionBaseUrls,
  DOWNLOAD_TOKEN_TTL,
} from '../download.js'

export function registerGetDownloadUri(
  mcp: McpServer,
  allowedPaths: string[],
  host: string,
  port: number,
  tempDirs?: string[],
) {
  return mcp.registerTool(
    'file_get_download_uri',
    {
      description:
        '為指定檔案產生 10 分鐘有效的臨時 HTTP 下載連結。檔案位於遠端工作站，本工具集其他工具回傳的檔案路徑無法用內建檔案讀取工具直接開啟，需先用此工具取得下載連結並下載到本機後才能讀取內容。',
      inputSchema: z.object({
        file_path: z.string().describe('檔案絕對路徑，必須在 allowed_paths 範圍內'),
        session_id: z.string().default('').describe('MCP session ID（用於組裝正確的下載 URL）'),
      }),
    },
    ({ file_path, session_id }) => {
      if (!isPathAllowed(file_path, allowedPaths, tempDirs)) {
        return err('file_path 不在允許的目錄範圍內')
      }

      if (!fs.existsSync(file_path)) {
        return err(`檔案不存在：${file_path}`)
      }

      const token = createDownloadToken(file_path)
      const sessionId = session_id || undefined
      const uri = getDownloadUrl(token, sessionId, host, port)
      const fileName = file_path.split(/[/\\]/).pop() ?? ''

      return ok({ success: true, uri, expires_in_seconds: DOWNLOAD_TOKEN_TTL, file_name: fileName })
    },
  )
}

function ok(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data) }] }
}

function err(msg: string) {
  return ok({ success: false, error: msg })
}
