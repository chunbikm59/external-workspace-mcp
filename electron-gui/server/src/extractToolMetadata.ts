import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js'
import { zodToJsonSchema } from 'zod-to-json-schema'
import { registerReadFile } from './tools/readFile.js'
import { registerGrepFiles } from './tools/grepFiles.js'
import { registerGlobFiles } from './tools/globFiles.js'
import { registerRunCommand } from './tools/runCommand.js'
import { registerWorkspaceTools } from './tools/workspaceContext.js'
import { registerGetDownloadUri } from './tools/getDownloadUri.js'
import { registerFsTools } from './tools/fsTools.js'
import { registerConvertToMarkdown } from './tools/convertToMarkdown.js'
import { registerCapturePptSlides } from './tools/capturePptSlides.js'

// 與 tools/list 回傳的格式對齊，方便未來改接 runtime 查詢時無痛切換。
interface ToolParamMetadata {
  name: string
  type: string
  required: boolean
  default?: unknown
  description?: string
  enumValues?: unknown[]
}

interface ToolMetadata {
  name: string
  description: string
  params: ToolParamMetadata[]
}

function extractParams(inputSchema: unknown): ToolParamMetadata[] {
  const jsonSchema = zodToJsonSchema(inputSchema as Parameters<typeof zodToJsonSchema>[0], {
    target: 'jsonSchema7',
  }) as {
    properties?: Record<string, Record<string, unknown>>
    required?: string[]
  }

  const properties = jsonSchema.properties ?? {}
  const required = new Set(jsonSchema.required ?? [])

  return Object.entries(properties).map(([name, schema]) => ({
    name,
    type: typeof schema['type'] === 'string' ? (schema['type'] as string) : 'any',
    required: required.has(name),
    default: schema['default'],
    description: typeof schema['description'] === 'string' ? (schema['description'] as string) : undefined,
    enumValues: Array.isArray(schema['enum']) ? (schema['enum'] as unknown[]) : undefined,
  }))
}

function toMetadata(name: string, tool: RegisteredTool): ToolMetadata {
  return {
    name,
    description: tool.description ?? '',
    params: extractParams(tool.inputSchema),
  }
}

function collectAllTools(): Map<string, RegisteredTool> {
  const mcp = new McpServer({ name: 'metadata-extraction', version: '0.0.0' })
  const tools = new Map<string, RegisteredTool>()
  const allowedPaths = [process.cwd()]

  tools.set('read_file', registerReadFile(mcp, allowedPaths))
  tools.set('grep_files', registerGrepFiles(mcp, allowedPaths, 'rg'))
  tools.set('glob_files', registerGlobFiles(mcp, allowedPaths, 'rg'))
  tools.set('cmd_run_command', registerRunCommand(mcp, allowedPaths, []))

  const workspaceTools = registerWorkspaceTools(mcp, allowedPaths, [], 'whitelist.json', true, () => {})
  for (const [name, tool] of Object.entries(workspaceTools)) {
    tools.set(name, tool)
  }

  tools.set('file_get_download_uri', registerGetDownloadUri(mcp, allowedPaths, '127.0.0.1', 0))
  registerFsTools(mcp, allowedPaths, tools)
  tools.set('md_convert_to_markdown', registerConvertToMarkdown(mcp, allowedPaths, false, 'metadata'))
  tools.set('md_capture_ppt_slides', registerCapturePptSlides(mcp, allowedPaths, false, 'metadata'))

  return tools
}

// 與 toolFilter.ts 隱藏的內部別名工具一致，這些工具不對外暴露，GUI 不應顯示。
const ALWAYS_HIDDEN = new Set(['fs_read_file', 'fs_read_text_file', 'fs_search_files'])

function main(): void {
  const tools = collectAllTools()
  const metadata: ToolMetadata[] = []

  for (const [name, tool] of tools) {
    if (ALWAYS_HIDDEN.has(name)) continue
    metadata.push(toMetadata(name, tool))
  }

  metadata.sort((a, b) => a.name.localeCompare(b.name))

  const here = path.dirname(fileURLToPath(import.meta.url))
  const outPath = path.resolve(here, '../../gui/src/shared/toolMetadata.json')
  fs.mkdirSync(path.dirname(outPath), { recursive: true })
  fs.writeFileSync(outPath, JSON.stringify(metadata, null, 2) + '\n', 'utf-8')
  console.log(`已寫入 ${metadata.length} 個工具的 metadata 至 ${outPath}`)
}

main()
