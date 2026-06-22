import { parseArgs } from 'node:util'
import { randomUUID } from 'node:crypto'
import { loadConfig } from './config.js'
import { loadWhitelist } from './whitelist.js'
import { ensureRipgrep } from './ripgrep.js'
import { buildApp } from './app.js'
import type { WhitelistEntry } from './whitelist.js'

async function main() {
  const { values } = parseArgs({
    options: {
      host: { type: 'string' },
      port: { type: 'string' },
      'bearer-token': { type: 'string' },
      config: { type: 'string' },
      'allowed-paths': { type: 'string', multiple: true },
    },
    strict: false,
  })

  const config = loadConfig({
    host: values['host'] as string | undefined,
    port: values['port'] ? parseInt(values['port'] as string, 10) : undefined,
    bearerToken: values['bearer-token'] as string | undefined,
    config: values['config'] as string | undefined,
    allowedPaths: values['allowed-paths'] as string[] | undefined,
  })

  const whitelist: WhitelistEntry[] = loadWhitelist(config.allowedPaths, config.whitelistFilename)
  const rgPath = await ensureRipgrep()
  const endpointId = process.env['MCP_ENDPOINT_ID'] ?? randomUUID()

  const reloadCallback = (newEntries: WhitelistEntry[]) => {
    whitelist.length = 0
    whitelist.push(...newEntries)
    console.log(`[INFO] 白名單已重新載入，共 ${whitelist.length} 個命令。`)
  }

  const app = buildApp(config, whitelist, rgPath, endpointId, reloadCallback)

  const server = app.listen(config.port, config.host === '0.0.0.0' ? undefined : config.host, () => {
    const displayHost =
      config.host === '0.0.0.0' ? '0.0.0.0' : config.host
    console.log(`[INFO] MCP Workspace Server 已啟動`)
    console.log(`[INFO] 監聽：http://${displayHost}:${config.port}/mcp`)
    console.log(`[INFO] 健康檢查：http://${displayHost}:${config.port}/health`)
    console.log(`[INFO] Allowed paths：${config.allowedPaths.join(', ')}`)
    console.log(`[INFO] 白名單命令數：${whitelist.length}`)
    console.log(`[INFO] Bearer Token：${config.bearerToken ? '已設定' : '未設定（無驗證）'}`)
    console.log(`[INFO] 唯讀模式：${config.readonlyMode ? '開啟' : '關閉'}`)
    console.log(`[INFO] ripgrep：${rgPath}`)
  })

  process.on('SIGINT', () => {
    console.log('\n[INFO] 收到 SIGINT，正在關閉...')
    server.close(() => process.exit(0))
  })

  process.on('SIGTERM', () => {
    console.log('\n[INFO] 收到 SIGTERM，正在關閉...')
    server.close(() => process.exit(0))
  })
}

main().catch(err => {
  console.error('[ERROR]', err)
  process.exit(1)
})
