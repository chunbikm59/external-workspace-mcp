import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { randomUUID } from 'node:crypto'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { isPathAllowed } from '../config.js'

const SUPPORTED_EXTENSIONS = ['.pdf', '.docx', '.html', '.htm', '.xlsx', '.xls']

export function getTempDirForMarkdown(endpointId: string): string {
  return path.join(os.tmpdir(), `mcp-md-${endpointId}`)
}

async function convertPdf(srcPath: string): Promise<string> {
  const { default: pdfParse } = await import('pdf-parse')
  const buffer = fs.readFileSync(srcPath)
  const data = await pdfParse(buffer)
  return data.text
}

async function convertDocx(srcPath: string): Promise<string> {
  const mammoth = await import('mammoth')
  const result = await mammoth.extractRawText({ path: srcPath })
  return result.value
}

async function convertHtml(srcPath: string): Promise<string> {
  const TurndownService = (await import('turndown')).default
  const html = fs.readFileSync(srcPath, 'utf-8')
  const td = new TurndownService()
  return td.turndown(html)
}

async function convertXlsx(srcPath: string): Promise<string> {
  const XLSX = await import('xlsx')
  const wb = XLSX.readFile(srcPath)
  const lines: string[] = []
  for (const sheetName of wb.SheetNames) {
    lines.push(`## ${sheetName}\n`)
    const ws = wb.Sheets[sheetName]!
    const csv = XLSX.utils.sheet_to_csv(ws)
    const rows = csv.split('\n')
    if (rows.length > 0) {
      lines.push('| ' + (rows[0]?.split(',').join(' | ') ?? '') + ' |')
      lines.push('| ' + (rows[0]?.split(',').map(() => '---').join(' | ') ?? '') + ' |')
      for (const row of rows.slice(1)) {
        if (row.trim()) lines.push('| ' + row.split(',').join(' | ') + ' |')
      }
    }
    lines.push('')
  }
  return lines.join('\n')
}

export function registerConvertToMarkdown(
  mcp: McpServer,
  allowedPaths: string[],
  readonlyMode: boolean,
  endpointId: string,
) {
  return mcp.registerTool(
    'md_convert_to_markdown',
    {
      description: [
        '將檔案（PDF、DOCX、HTML、XLSX）轉換為 Markdown 並寫入磁碟。',
        readonlyMode
          ? '⚠ 唯讀模式：輸出強制寫入暫存目錄，不會修改原始資料夾。'
          : '輸出路徑預設為同目錄同檔名加 .md 副檔名。',
      ].join(' '),
      inputSchema: z.object({
        input_path: z.string().describe('來源檔案絕對路徑，必須在 allowed_paths 範圍內'),
        output_path: z
          .string()
          .default('')
          .describe('輸出 .md 檔案路徑；留空則自動決定（唯讀模式下強制寫入暫存目錄）'),
      }),
    },
    async ({ input_path, output_path }) => {
      const src = path.resolve(input_path)

      if (!isPathAllowed(src, allowedPaths)) {
        return err('input_path 不在允許的目錄範圍內')
      }

      if (!fs.existsSync(src)) {
        return err(`檔案不存在：${src}`)
      }

      const ext = path.extname(src).toLowerCase()
      if (!SUPPORTED_EXTENSIONS.includes(ext)) {
        return err(
          `不支援的檔案格式：${ext}。支援的格式：${SUPPORTED_EXTENSIONS.join(', ')}`,
        )
      }

      let dst: string
      if (output_path) {
        dst = path.resolve(output_path)
        if (!readonlyMode && !isPathAllowed(path.dirname(dst), allowedPaths)) {
          return err('output_path 不在允許的目錄範圍內')
        }
      } else if (readonlyMode) {
        const tempDir = getTempDirForMarkdown(endpointId)
        fs.mkdirSync(tempDir, { recursive: true })
        dst = path.join(tempDir, path.basename(src).replace(/\.[^.]+$/, '') + `_${randomUUID().slice(0, 8)}.md`)
      } else {
        dst = src.replace(/\.[^.]+$/, '.md')
      }

      try {
        let markdown = ''

        if (ext === '.pdf') {
          markdown = await convertPdf(src)
        } else if (ext === '.docx') {
          markdown = await convertDocx(src)
        } else if (ext === '.html' || ext === '.htm') {
          markdown = await convertHtml(src)
        } else if (ext === '.xlsx' || ext === '.xls') {
          markdown = await convertXlsx(src)
        }

        fs.mkdirSync(path.dirname(dst), { recursive: true })
        fs.writeFileSync(dst, markdown, 'utf-8')

        return ok({
          success: true,
          output_path: dst,
          char_count: markdown.length,
          readonly_mode: readonlyMode,
        })
      } catch (e) {
        return err(`轉換失敗：${String(e)}`)
      }
    },
  )
}

function ok(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data) }] }
}

function err(msg: string) {
  return ok({ success: false, error: msg })
}
