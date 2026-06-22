import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { isPathAllowed } from '../config.js'

export function registerGlobFiles(mcp: McpServer, allowedPaths: string[], rgPath: string, tempDirs?: string[]) {
  return mcp.registerTool(
    'glob_files',
    {
      description:
        '以 glob pattern 搜尋符合的檔名，結果依修改時間排序（最新在前）。自動尊重 .gitignore。',
      inputSchema: z.object({
        pattern: z.string().describe('glob pattern，例如 "**/*.ts"'),
        path: z.string().default('').describe('搜尋根目錄，留空使用第一個 allowed_path'),
        limit: z.number().int().min(1).default(100).describe('最大結果數'),
      }),
    },
    ({ pattern, path: searchPathArg, limit }) => {
      const searchPath = searchPathArg
        ? path.resolve(searchPathArg)
        : (allowedPaths[0] ?? process.cwd())

      if (searchPathArg && !isPathAllowed(searchPath, allowedPaths, tempDirs)) {
        return err('路徑不在允許範圍內')
      }

      if (!fs.existsSync(searchPath)) {
        return err(`路徑不存在：${searchPath}`)
      }

      const result = spawnSync(rgPath, ['--files', '--glob', pattern, searchPath], {
        encoding: 'utf-8',
        timeout: 30_000,
        maxBuffer: 20 * 1024 * 1024,
      })

      if (result.error) {
        if ((result.error as NodeJS.ErrnoException).code === 'ETIMEDOUT') {
          return err('[ERROR] 搜尋超時（30 秒）')
        }
        return err(`[ERROR] ${String(result.error)}`)
      }

      const filenames = (result.stdout ?? '')
        .split('\n')
        .map(f => f.trim())
        .filter(f => f.length > 0)

      // sort by mtime descending
      type FileMtime = { file: string; mtime: number }
      const withMtime: FileMtime[] = filenames.map(file => {
        try {
          const stat = fs.statSync(file)
          return { file, mtime: stat.mtimeMs }
        } catch {
          return { file, mtime: 0 }
        }
      })
      withMtime.sort((a, b) => b.mtime - a.mtime)

      const sorted = withMtime.map(e => e.file)
      const truncated = sorted.length > limit
      const resultFiles = truncated ? sorted.slice(0, limit) : sorted

      return ok({ num_files: sorted.length, filenames: resultFiles, truncated })
    },
  )
}

function ok(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data) }] }
}

function err(msg: string) {
  return { content: [{ type: 'text' as const, text: JSON.stringify({ error: msg }) }] }
}
