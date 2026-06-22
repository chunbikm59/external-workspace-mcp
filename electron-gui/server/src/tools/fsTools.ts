import fs from 'node:fs'
import path from 'node:path'
import type { McpServer, RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { isPathAllowed } from '../config.js'

// ── 工具名稱常數 ──────────────────────────────────────────────────────────────

export const FS_ALWAYS_HIDDEN = ['fs_read_file', 'fs_read_text_file', 'fs_search_files']

// ── 輔助 ──────────────────────────────────────────────────────────────────────

function ok(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data) }] }
}

function err(msg: string) {
  return ok({ error: msg })
}

function guardPath(p: string, allowedPaths: string[], tempDirs?: string[]): string | null {
  const resolved = path.resolve(p)
  if (!isPathAllowed(resolved, allowedPaths, tempDirs)) return null
  return resolved
}

function gitignoreToGlobs(line: string): string[] {
  const p = line.trim()
  if (!p || p.startsWith('#') || p.startsWith('!')) return []
  const isDir = p.endsWith('/')
  const clean = p.replace(/\/$/, '')
  if (clean.startsWith('/')) {
    const base = clean.slice(1)
    return isDir ? [base, `${base}/**`] : [base]
  }
  if (clean.includes('/')) {
    return isDir ? [clean, `${clean}/**`] : [clean]
  }
  return isDir ? [`**/${clean}`, `**/${clean}/**`] : [`**/${clean}`]
}

function loadGitignorePatterns(allowedPaths: string[]): string[] {
  const patterns: string[] = []
  for (const base of allowedPaths) {
    const gi = path.join(base, '.gitignore')
    if (!fs.existsSync(gi)) continue
    try {
      const lines = fs.readFileSync(gi, 'utf-8').split('\n')
      for (const line of lines) {
        patterns.push(...gitignoreToGlobs(line))
      }
    } catch {
      // ignore
    }
  }
  return patterns
}

function buildDirectoryTree(
  dirPath: string,
  exclude: string[],
  depth: number = 0,
  maxDepth: number = 4,
): unknown {
  if (depth > maxDepth) return '...'
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true })
    const result: Record<string, unknown> = {}
    for (const entry of entries) {
      const name = entry.name
      if (exclude.some(pat => name === pat || name.startsWith('.'))) continue
      if (entry.isDirectory()) {
        result[name + '/'] = buildDirectoryTree(path.join(dirPath, name), exclude, depth + 1, maxDepth)
      } else {
        result[name] = null
      }
    }
    return result
  } catch {
    return null
  }
}

// ── 工具登錄 ──────────────────────────────────────────────────────────────────

export function registerFsTools(
  mcp: McpServer,
  allowedPaths: string[],
  tools: Map<string, RegisteredTool>,
  tempDirs?: string[],
): void {

  // fs_write_file
  tools.set('fs_write_file', mcp.registerTool(
    'fs_write_file',
    {
      description: '將內容寫入檔案（完整覆蓋）。',
      inputSchema: z.object({
        path: z.string().describe('目標檔案路徑'),
        content: z.string().describe('要寫入的內容'),
      }),
    },
    ({ path: p, content }) => {
      const resolved = guardPath(p, allowedPaths, tempDirs)
      if (!resolved) return err('路徑不在允許範圍內')
      try {
        fs.mkdirSync(path.dirname(resolved), { recursive: true })
        fs.writeFileSync(resolved, content, 'utf-8')
        return ok({ success: true, path: resolved })
      } catch (e) {
        return err(`寫入失敗：${String(e)}`)
      }
    },
  ))

  // fs_edit_file（精確字串替換）
  tools.set('fs_edit_file', mcp.registerTool(
    'fs_edit_file',
    {
      description: '對檔案進行精確字串替換。',
      inputSchema: z.object({
        path: z.string().describe('目標檔案路徑'),
        old_text: z.string().describe('要被替換的精確文字'),
        new_text: z.string().describe('替換後的文字'),
      }),
    },
    ({ path: p, old_text, new_text }) => {
      const resolved = guardPath(p, allowedPaths, tempDirs)
      if (!resolved) return err('路徑不在允許範圍內')
      if (!fs.existsSync(resolved)) return err(`檔案不存在：${resolved}`)
      try {
        const original = fs.readFileSync(resolved, 'utf-8')
        if (!original.includes(old_text)) return err('找不到要替換的文字（必須完全符合）')
        const updated = original.replace(old_text, new_text)
        fs.writeFileSync(resolved, updated, 'utf-8')
        return ok({ success: true, path: resolved })
      } catch (e) {
        return err(`編輯失敗：${String(e)}`)
      }
    },
  ))

  // fs_directory_tree（含 gitignore 注入）
  tools.set('fs_directory_tree', mcp.registerTool(
    'fs_directory_tree',
    {
      description: '遞迴展開目錄結構，自動套用 .gitignore 排除規則。',
      inputSchema: z.object({
        path: z.string().describe('目錄路徑，必須在 allowed_paths 範圍內'),
        max_depth: z.number().int().min(1).max(10).default(4).describe('最大展開深度'),
        exclude_patterns: z.array(z.string()).default([]).describe('額外排除的 glob pattern'),
      }),
    },
    ({ path: p, max_depth, exclude_patterns }) => {
      const resolved = guardPath(p, allowedPaths, tempDirs)
      if (!resolved) return err('路徑不在允許範圍內')
      if (!fs.existsSync(resolved)) return err(`路徑不存在：${resolved}`)

      const giPatterns = loadGitignorePatterns(allowedPaths)
      const allExclude = [...exclude_patterns, ...giPatterns]

      const tree = buildDirectoryTree(resolved, allExclude, 0, max_depth)
      return ok({ path: resolved, tree })
    },
  ))

  // fs_list_directory
  tools.set('fs_list_directory', mcp.registerTool(
    'fs_list_directory',
    {
      description: '列出目錄內容（檔案與子目錄）。',
      inputSchema: z.object({
        path: z.string().describe('目錄路徑'),
      }),
    },
    ({ path: p }) => {
      const resolved = guardPath(p, allowedPaths, tempDirs)
      if (!resolved) return err('路徑不在允許範圍內')
      try {
        const entries = fs.readdirSync(resolved, { withFileTypes: true })
        return ok({
          path: resolved,
          entries: entries.map(e => ({
            name: e.name,
            type: e.isDirectory() ? 'directory' : 'file',
          })),
        })
      } catch (e) {
        return err(`讀取目錄失敗：${String(e)}`)
      }
    },
  ))

  // fs_read_media_file（base64）
  tools.set('fs_read_media_file', mcp.registerTool(
    'fs_read_media_file',
    {
      description: '讀取圖片或其他媒體檔案，回傳 base64 編碼內容。',
      inputSchema: z.object({
        path: z.string().describe('媒體檔案路徑'),
      }),
    },
    ({ path: p }) => {
      const resolved = guardPath(p, allowedPaths, tempDirs)
      if (!resolved) return err('路徑不在允許範圍內')
      if (!fs.existsSync(resolved)) return err(`檔案不存在：${resolved}`)
      try {
        const buffer = fs.readFileSync(resolved)
        const base64 = buffer.toString('base64')
        const ext = path.extname(resolved).slice(1).toLowerCase()
        const mimeMap: Record<string, string> = {
          png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
          gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
          mp3: 'audio/mpeg', wav: 'audio/wav', mp4: 'video/mp4',
        }
        const mimeType = mimeMap[ext] ?? 'application/octet-stream'
        return ok({ path: resolved, mimeType, base64, size: buffer.length })
      } catch (e) {
        return err(`讀取失敗：${String(e)}`)
      }
    },
  ))

  // fs_get_file_info
  tools.set('fs_get_file_info', mcp.registerTool(
    'fs_get_file_info',
    {
      description: '取得檔案或目錄的元資訊（大小、修改時間、類型）。',
      inputSchema: z.object({
        path: z.string().describe('檔案或目錄路徑'),
      }),
    },
    ({ path: p }) => {
      const resolved = guardPath(p, allowedPaths, tempDirs)
      if (!resolved) return err('路徑不在允許範圍內')
      try {
        const stat = fs.statSync(resolved)
        return ok({
          path: resolved,
          type: stat.isDirectory() ? 'directory' : 'file',
          size: stat.size,
          created: stat.birthtime.toISOString(),
          modified: stat.mtime.toISOString(),
          accessed: stat.atime.toISOString(),
        })
      } catch (e) {
        return err(`取得資訊失敗：${String(e)}`)
      }
    },
  ))

  // fs_move_file
  tools.set('fs_move_file', mcp.registerTool(
    'fs_move_file',
    {
      description: '移動或重新命名檔案/目錄。',
      inputSchema: z.object({
        source: z.string().describe('來源路徑'),
        destination: z.string().describe('目標路徑'),
      }),
    },
    ({ source, destination }) => {
      const src = guardPath(source, allowedPaths, tempDirs)
      const dst = guardPath(destination, allowedPaths, tempDirs)
      if (!src) return err('來源路徑不在允許範圍內')
      if (!dst) return err('目標路徑不在允許範圍內')
      if (!fs.existsSync(src)) return err(`來源不存在：${src}`)
      try {
        fs.mkdirSync(path.dirname(dst), { recursive: true })
        fs.renameSync(src, dst)
        return ok({ success: true, source: src, destination: dst })
      } catch (e) {
        return err(`移動失敗：${String(e)}`)
      }
    },
  ))

  // 隱藏工具（不對外暴露，但需要在 list_tools 被過濾掉）
  tools.set('fs_read_file', mcp.registerTool(
    'fs_read_file',
    {
      description: '（已停用）請改用 read_file。',
      inputSchema: z.object({ path: z.string() }),
    },
    () => err('工具 fs_read_file 已停用，請改用 read_file。'),
  ))

  tools.set('fs_read_text_file', mcp.registerTool(
    'fs_read_text_file',
    {
      description: '（已停用）請改用 read_file。',
      inputSchema: z.object({ path: z.string() }),
    },
    () => err('工具 fs_read_text_file 已停用，請改用 read_file。'),
  ))

  tools.set('fs_search_files', mcp.registerTool(
    'fs_search_files',
    {
      description: '（已停用）請改用 glob_files。',
      inputSchema: z.object({ pattern: z.string() }),
    },
    () => err('工具 fs_search_files 已停用，請改用 glob_files。'),
  ))
}
