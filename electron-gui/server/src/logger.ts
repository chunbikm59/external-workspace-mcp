export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export const LOG_MARKER = '__MCP_LOG__ '

export function emitStructuredLog(level: LogLevel, message: string): void {
  console.log(`${LOG_MARKER}${JSON.stringify({ level, message })}`)
}
