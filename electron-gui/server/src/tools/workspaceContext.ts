import fs from 'node:fs'
import path from 'node:path'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import type { WhitelistEntry } from '../whitelist.js'

function listTopLevel(dirPath: string): string[] {
  try {
    return fs.readdirSync(dirPath)
  } catch {
    return []
  }
}

export function registerWorkspaceContext(
  mcp: McpServer,
  allowedPaths: string[],
  whitelist: WhitelistEntry[],
) {
  return mcp.registerTool(
    'cmd_workspace_context',
    {
      description: '一次取得工作區概覽：allowed_paths、白名單命令、各目錄的頂層結構。',
      inputSchema: z.object({}),
    },
    () => {
      const directoryTrees: Record<string, string[]> = {}
      for (const p of allowedPaths) {
        directoryTrees[p] = listTopLevel(p)
      }

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            allowed_paths: allowedPaths,
            allowed_commands: whitelist.map(e => ({ command: e.command, description: e.description ?? '' })),
            directory_trees: directoryTrees,
          }),
        }],
      }
    },
  )
}

export function registerListCommands(mcp: McpServer, whitelist: WhitelistEntry[]) {
  return mcp.registerTool(
    'cmd_list_allowed_commands',
    {
      description: '列出所有白名單命令及說明。',
      inputSchema: z.object({}),
    },
    () => {
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            allowed_commands: whitelist.map(e => ({ command: e.command, description: e.description ?? '' })),
            total: whitelist.length,
          }),
        }],
      }
    },
  )
}

export function registerReloadWhitelist(
  mcp: McpServer,
  allowedPaths: string[],
  whitelist: WhitelistEntry[],
  whitelistFilename: string,
  guiMode: boolean,
  reloadCallback: (newEntries: WhitelistEntry[]) => void,
) {
  return mcp.registerTool(
    'cmd_reload_whitelist',
    {
      description: guiMode
        ? '重新從磁碟載入白名單命令（需要在 GUI 介面中由使用者確認）。'
        : '重新從磁碟載入白名單命令（無使用者確認，非 GUI 模式無互動介面可確認）。',
      inputSchema: z.object({}),
    },
    async () => {
      const { loadWhitelist } = await import('../whitelist.js')
      const newEntries = loadWhitelist(allowedPaths, whitelistFilename)

      if (guiMode) {
        const { createPendingReload } = await import('../pendingReload.js')
        const { id, wait } = createPendingReload()

        // GUI 監聽 stdout 抓這個標記來跳出確認對話框，使用者選擇後
        // 透過 /admin/pending-reload/:id/resolve 回傳結果，此處會一直等待。
        console.log(
          `__MCP_RELOAD_REQUEST__ ${JSON.stringify({ id, commands: newEntries.map(e => e.command) })}`,
        )

        const approved = await wait

        if (!approved) {
          return {
            content: [{
              type: 'text',
              text: JSON.stringify({ success: false, message: '使用者拒絕重載，白名單維持不變。' }),
            }],
          }
        }
      }

      reloadCallback(newEntries)

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            success: true,
            message: `白名單已重新載入，共 ${newEntries.length} 個命令。`,
            commands: newEntries.map(e => e.command),
          }),
        }],
      }
    },
  )
}

export function registerWorkspaceTools(
  mcp: McpServer,
  allowedPaths: string[],
  whitelist: WhitelistEntry[],
  whitelistFilename: string,
  guiMode: boolean,
  reloadCallback: (newEntries: WhitelistEntry[]) => void,
) {
  return {
    cmd_workspace_context: registerWorkspaceContext(mcp, allowedPaths, whitelist),
    cmd_list_allowed_commands: registerListCommands(mcp, whitelist),
    cmd_reload_whitelist: registerReloadWhitelist(
      mcp,
      allowedPaths,
      whitelist,
      whitelistFilename,
      guiMode,
      reloadCallback,
    ),
  }
}
