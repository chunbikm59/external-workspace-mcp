import { spawnSync } from 'node:child_process'
import path from 'node:path'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { isPathAllowed } from '../config.js'
import { VCS_EXCLUDE_GLOBS } from '../ripgrep.js'

export function registerGrepFiles(mcp: McpServer, allowedPaths: string[], rgPath: string, tempDirs?: string[]) {
  return mcp.registerTool(
    'grep_files',
    {
      description:
        '以 ripgrep 搜尋檔案內容。output_mode: "content"（預設）回傳匹配行，"files_with_matches" 只回傳檔案路徑，"count" 回傳各檔案匹配數。',
      inputSchema: z.object({
        pattern: z.string().describe('搜尋 pattern（正規表達式）'),
        path: z.string().default('').describe('搜尋根目錄，留空使用第一個 allowed_path'),
        output_mode: z
          .enum(['content', 'files_with_matches', 'count'])
          .default('content')
          .describe('輸出模式'),
        glob: z.string().default('').describe('檔案 glob 過濾（例 "*.py"）'),
        file_type: z.string().default('').describe('ripgrep 內建類型（例 "py"）'),
        context_lines: z.number().int().min(0).max(10).default(0).describe('前後文行數 (-C)'),
        before_context: z.number().int().min(0).max(10).default(0).describe('前文行數 (-B)'),
        after_context: z.number().int().min(0).max(10).default(0).describe('後文行數 (-A)'),
        ignore_case: z.boolean().default(false).describe('不分大小寫'),
        head_limit: z.number().int().min(0).default(250).describe('最大結果行數，0 不限制'),
        offset: z.number().int().min(0).default(0).describe('跳過前 N 筆（分頁）'),
        fixed_strings: z.boolean().default(false).describe('純字串比對（不使用 regex）'),
        multiline: z.boolean().default(false).describe('多行模式（. 匹配 \\n）'),
      }),
    },
    ({
      pattern,
      path: searchPathArg,
      output_mode,
      glob,
      file_type,
      context_lines,
      before_context,
      after_context,
      ignore_case,
      head_limit,
      offset,
      fixed_strings,
      multiline,
    }) => {
      const searchPath = searchPathArg
        ? path.resolve(searchPathArg)
        : (allowedPaths[0] ?? process.cwd())

      if (searchPathArg && !isPathAllowed(searchPath, allowedPaths, tempDirs)) {
        return err('路徑不在允許範圍內')
      }

      const args: string[] = ['--color=never']

      if (output_mode === 'files_with_matches') {
        args.push('--files-with-matches')
      } else if (output_mode === 'count') {
        args.push('--count')
      } else {
        args.push('--heading', '--line-number')
        if (context_lines > 0) {
          args.push(`--context=${context_lines}`)
        } else {
          if (before_context > 0) args.push(`--before-context=${before_context}`)
          if (after_context > 0) args.push(`--after-context=${after_context}`)
        }
      }

      if (ignore_case) args.push('--ignore-case')
      if (fixed_strings) args.push('--fixed-strings')
      if (multiline) args.push('--multiline', '--multiline-dotall')
      if (glob) args.push('--glob', glob)
      if (file_type) args.push('--type', file_type)

      for (const vcs of VCS_EXCLUDE_GLOBS) {
        args.push('--glob', vcs)
      }

      args.push(pattern, searchPath)

      const result = spawnSync(rgPath, args, {
        encoding: 'utf-8',
        timeout: 30_000,
        maxBuffer: 50 * 1024 * 1024,
      })

      if (result.error) {
        if ((result.error as NodeJS.ErrnoException).code === 'ETIMEDOUT') {
          return err('[ERROR] 搜尋超時（30 秒）')
        }
        return err(`[ERROR] ${String(result.error)}`)
      }

      if (result.status === 2) {
        return err(`[ERROR] ${result.stderr ?? '未知錯誤'}`)
      }

      const stdout = result.stdout ?? ''

      if (result.status === 1) {
        if (output_mode === 'files_with_matches')
          return ok({ mode: output_mode, num_files: 0, filenames: [] })
        if (output_mode === 'count')
          return ok({ mode: output_mode, num_matches: 0, per_file: [] })
        return ok({
          mode: 'content',
          num_files: 0,
          filenames: [],
          content: '',
          num_lines: 0,
          applied_limit: 0,
          applied_offset: offset,
        })
      }

      if (output_mode === 'files_with_matches') {
        let filenames = stdout.split('\n').filter(f => f.trim())
        if (offset > 0) filenames = filenames.slice(offset)
        const applied_limit = head_limit > 0 ? head_limit : filenames.length
        if (head_limit > 0) filenames = filenames.slice(0, head_limit)
        return ok({ mode: output_mode, num_files: filenames.length, filenames, applied_limit })
      }

      if (output_mode === 'count') {
        const per_file: Array<{ file: string; count: number }> = []
        let total = 0
        for (const line of stdout.split('\n').filter(l => l.trim())) {
          const idx = line.lastIndexOf(':')
          if (idx !== -1) {
            const file = line.slice(0, idx)
            const count = parseInt(line.slice(idx + 1), 10)
            per_file.push({ file, count })
            total += count
          }
        }
        return ok({ mode: output_mode, num_matches: total, per_file })
      }

      // content mode
      let lines = stdout.split('\n')
      if (offset > 0) lines = lines.slice(offset)
      const applied_limit = head_limit > 0 ? head_limit : lines.length
      let truncated = false
      if (head_limit > 0 && lines.length > head_limit) {
        lines = lines.slice(0, head_limit)
        truncated = true
      }
      if (truncated) lines.push(`... [結果已截斷，使用 offset=${offset + head_limit} 取得後續內容]`)

      const fileSet = new Set<string>()
      for (const line of lines) {
        if (line && !/^\d+[:\-]/.test(line) && !line.startsWith('--')) {
          fileSet.add(line)
        }
      }

      return ok({
        mode: 'content',
        num_files: fileSet.size,
        filenames: [...fileSet],
        content: lines.join('\n'),
        num_lines: lines.length,
        applied_limit,
        applied_offset: offset,
      })
    },
  )
}

function ok(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data) }] }
}

function err(msg: string) {
  return { content: [{ type: 'text' as const, text: JSON.stringify({ error: msg }) }] }
}
