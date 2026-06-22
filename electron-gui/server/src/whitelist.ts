import fs from 'node:fs'
import path from 'node:path'

export interface WhitelistEntry {
  command: string
  description?: string
}

export function parseCompositeCommand(command: string): string[] {
  return command
    .split(/\s*;\s*/)
    .map(s => s.trim())
    .filter(s => s.length > 0)
}

export function loadWhitelist(allowedPaths: string[], filename: string): WhitelistEntry[] {
  const entries: WhitelistEntry[] = []

  for (const base of allowedPaths) {
    const whitelistPath = path.join(base, filename)
    if (!fs.existsSync(whitelistPath)) continue

    try {
      const raw = fs.readFileSync(whitelistPath, 'utf-8')
      const parsed = JSON.parse(raw) as { commands?: unknown[] }
      const commands = parsed.commands

      if (!Array.isArray(commands)) {
        console.warn(`[WARN] ${whitelistPath}: commands 欄位不是陣列`)
        continue
      }

      for (const item of commands) {
        if (typeof item === 'string') {
          entries.push({ command: item })
        } else if (typeof item === 'object' && item !== null && 'command' in item) {
          const obj = item as { command: string; description?: string }
          entries.push({ command: obj.command, description: obj.description })
        }
      }
    } catch (err) {
      console.warn(`[WARN] 白名單載入失敗：${whitelistPath}:`, err)
    }
  }

  return entries
}

export function getWhitelistCommands(entries: WhitelistEntry[]): string[] {
  return entries.map(e => e.command)
}
