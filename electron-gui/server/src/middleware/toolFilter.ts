import type { RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js'
import { FS_ALWAYS_HIDDEN } from '../tools/fsTools.js'

const WRITE_TOOLS = [
  'fs_write_file',
  'fs_edit_file',
  'fs_move_file',
  'cmd_run_command',
  'cmd_reload_whitelist',
]

export function applyToolFilter(
  tools: Map<string, RegisteredTool>,
  disabledTools: string[],
  readonlyMode: boolean,
): void {
  for (const name of FS_ALWAYS_HIDDEN) {
    tools.get(name)?.disable()
  }

  if (readonlyMode) {
    for (const name of WRITE_TOOLS) {
      tools.get(name)?.disable()
    }
  }

  for (const name of disabledTools) {
    tools.get(name)?.disable()
  }
}
