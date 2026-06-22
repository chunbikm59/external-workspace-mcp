import fs from 'node:fs'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { isPathAllowed } from '../config.js'

export function registerReadFile(mcp: McpServer, allowedPaths: string[], tempDirs?: string[]) {
  return mcp.registerTool(
    'read_file',
    {
      description:
        '讀取文字檔案內容，回傳帶行號格式（"{行號}\\t{內容}"）。支援 offset/limit 分段讀取大型檔案。',
      inputSchema: z.object({
        path: z.string().describe('檔案絕對路徑，必須在 allowed_paths 範圍內'),
        offset: z.number().int().min(0).default(0).describe('起始行（0-indexed）'),
        limit: z.number().int().min(0).default(0).describe('讀取行數，0 表示讀到底'),
      }),
    },
    ({ path: filePath, offset, limit }) => {
      if (!isPathAllowed(filePath, allowedPaths, tempDirs)) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: '[ERROR] 路徑不在允許範圍內' }) }] }
      }

      if (!fs.existsSync(filePath)) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: `[ERROR] 檔案不存在：${filePath}` }) }] }
      }

      try {
        const allLines = fs.readFileSync(filePath, { encoding: 'utf-8' }).split('\n')
        const totalLines = allLines.length
        const chunk = limit > 0 ? allLines.slice(offset, offset + limit) : allLines.slice(offset)
        const startLine = offset + 1
        const content = chunk.map((line, i) => `${startLine + i}\t${line}`).join('\n')

        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              file_path: filePath,
              content,
              num_lines: chunk.length,
              start_line: startLine,
              total_lines: totalLines,
            }),
          }],
        }
      } catch (err) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: `[ERROR] 讀取失敗：${String(err)}` }) }] }
      }
    },
  )
}
