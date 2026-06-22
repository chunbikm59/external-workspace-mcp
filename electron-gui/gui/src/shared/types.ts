export interface EndpointConfig {
  id: string
  name: string
  enabled: boolean
  host: string
  port: number
  bearerToken: string | null
  allowedPaths: string[]
  whitelistFilename: string
  readonlyMode: boolean
  disabledTools: string[]
  autoStart: boolean
}

export type ServerStatus = 'stopped' | 'starting' | 'running' | 'stopping' | 'error'

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export interface LogLine {
  endpointId: string
  line: string
  level: LogLevel
  isError: boolean
  timestamp: number
}

export interface StatusChange {
  endpointId: string
  status: ServerStatus
}

export interface ConnectionStats {
  active: number
}

export interface ConnectionStatsChange {
  endpointId: string
  stats: ConnectionStats
}

// All MCP tools grouped by category
export const TOOL_GROUPS = {
  readonly: [
    'read_file',
    'grep_files',
    'glob_files',
    'fs_directory_tree',
    'fs_list_directory',
    'fs_read_media_file',
    'fs_get_file_info',
    'cmd_workspace_context',
    'cmd_list_allowed_commands',
    'file_get_download_uri',
  ],
  write: [
    'fs_write_file',
    'fs_edit_file',
    'fs_move_file',
    'cmd_run_command',
    'cmd_reload_whitelist',
  ],
  special: ['md_convert_to_markdown', 'md_capture_ppt_slides'],
} as const

export const ALL_TOOLS = [
  ...TOOL_GROUPS.readonly,
  ...TOOL_GROUPS.write,
  ...TOOL_GROUPS.special,
]

// 由 server/src/extractToolMetadata.ts 在 build 時從工具的 zod schema 產生，
// 對應到 toolMetadata.json 的結構。
export interface ToolParamMetadata {
  name: string
  type: string
  required: boolean
  default?: unknown
  description?: string
  enumValues?: unknown[]
}

export interface ToolMetadata {
  name: string
  description: string
  params: ToolParamMetadata[]
}
