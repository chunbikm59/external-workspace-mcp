import { spawnSync } from 'node:child_process'
import os from 'node:os'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { parseCompositeCommand, getWhitelistCommands } from '../whitelist.js'
import type { WhitelistEntry } from '../whitelist.js'

function buildShellArgs(command: string): string[] {
  if (os.platform() === 'win32') {
    return ['powershell', '-NoProfile', '-NonInteractive', '-Command', command]
  }
  return ['/bin/sh', '-c', command]
}

export function registerRunCommand(
  mcp: McpServer,
  allowedPaths: string[],
  whitelist: WhitelistEntry[],
) {
  return mcp.registerTool(
    'cmd_run_command',
    {
      description:
        '執行白名單中的命令。支援以 ";" 串接多個命令。僅允許完全符合白名單的命令。',
      inputSchema: z.object({
        command: z.string().describe('要執行的命令（可用 ";" 串接多個）'),
        fail_fast: z.boolean().default(true).describe('遇到失敗時是否停止後續命令'),
      }),
    },
    ({ command, fail_fast }) => {
      const subCommands = parseCompositeCommand(command)
      if (subCommands.length === 0) {
        return err('命令為空')
      }

      const allowed = getWhitelistCommands(whitelist)
      const invalid = subCommands.filter(cmd => !allowed.includes(cmd))
      if (invalid.length > 0) {
        return err(
          `以下子命令不在白名單中：${JSON.stringify(invalid)}。\n允許的命令：${JSON.stringify(allowed)}`,
        )
      }

      const cwd = allowedPaths[0]
      const results: Array<{
        command: string
        success: boolean
        returncode?: number
        stdout?: string
        stderr?: string
        error?: string
      }> = []

      for (const sub of subCommands) {
        const shellArgs = buildShellArgs(sub)
        const proc = spawnSync(shellArgs[0]!, shellArgs.slice(1), {
          encoding: 'utf-8',
          cwd,
          timeout: 120_000,
          maxBuffer: 10 * 1024 * 1024,
        })

        if (proc.error) {
          const isTimeout = (proc.error as NodeJS.ErrnoException).code === 'ETIMEDOUT'
          results.push({
            command: sub,
            success: false,
            error: isTimeout ? '命令執行超時（120 秒）' : String(proc.error),
          })
          if (fail_fast) break
          continue
        }

        results.push({
          command: sub,
          success: proc.status === 0,
          returncode: proc.status ?? -1,
          stdout: proc.stdout,
          stderr: proc.stderr,
        })

        if (fail_fast && proc.status !== 0) break
      }

      if (subCommands.length === 1) {
        const r = results[0]!
        if (r.error) return ok({ success: false, error: r.error })
        return ok({ success: r.success, returncode: r.returncode, stdout: r.stdout, stderr: r.stderr })
      }

      const overallSuccess = results.every(r => r.success)
      return ok({
        success: overallSuccess,
        commands_executed: results.length,
        commands_total: subCommands.length,
        results,
      })
    },
  )
}

function ok(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data) }] }
}

function err(msg: string) {
  return ok({ success: false, error: msg })
}
