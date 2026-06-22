import { ipcMain, dialog, shell, BrowserWindow } from 'electron'
import net from 'node:net'
import {
  getEndpoints,
  saveEndpoint,
  deleteEndpoint,
  createEndpoint,
} from './configManager.js'
import {
  startServer,
  stopServer,
  restartServer,
  reloadWhitelist,
  getServerStatus,
  getServerLogs,
  getConnectionStats,
  emitLog,
} from './serverManager.js'
import type { EndpointConfig } from '../shared/types.js'

function checkPort(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const srv = net.createServer()
    srv.once('error', () => resolve(false))
    srv.once('listening', () => srv.close(() => resolve(true)))
    srv.listen(port)
  })
}

export function registerIpcHandlers(): void {
  ipcMain.handle('endpoint:getAll', () => getEndpoints())

  ipcMain.handle('endpoint:save', (_e, endpoint: EndpointConfig) => {
    saveEndpoint(endpoint)
    emitLog(endpoint.id, '端點設定已儲存', 'info')
  })

  ipcMain.handle('endpoint:delete', (_e, id: string) => {
    deleteEndpoint(id)
    emitLog(id, '端點已刪除', 'info')
  })

  ipcMain.handle('endpoint:create', (_e, name: string) => {
    const ep = createEndpoint(name)
    emitLog(ep.id, `已新增端點「${name}」`, 'info')
    return ep
  })

  ipcMain.handle('server:start', async (_e, endpoint: EndpointConfig) => {
    return startServer(endpoint)
  })

  ipcMain.handle('server:stop', async (_e, endpointId: string) => {
    await stopServer(endpointId)
  })

  ipcMain.handle('server:restart', async (_e, endpoint: EndpointConfig) => {
    return restartServer(endpoint)
  })

  ipcMain.handle('server:getStatus', (_e, endpointId: string) => {
    return getServerStatus(endpointId)
  })

  ipcMain.handle('server:getLogs', (_e, endpointId: string) => {
    return getServerLogs(endpointId)
  })

  ipcMain.handle('server:getConnectionStats', (_e, endpointId: string) => {
    return getConnectionStats(endpointId)
  })

  ipcMain.handle('dialog:browseFolder', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory'],
      title: '選擇工作資料夾',
    })
    return result.canceled ? null : result.filePaths[0] ?? null
  })

  ipcMain.handle('system:checkPort', async (_e, port: number) => {
    const available = await checkPort(port)
    return { available }
  })

  ipcMain.handle('shell:openPath', (_e, p: string) => {
    shell.openPath(p)
  })

  ipcMain.handle('shell:copyToClipboard', async (_e, text: string) => {
    const { clipboard } = await import('electron')
    clipboard.writeText(text)
  })

  ipcMain.handle('whitelist:reload', async (_e, endpoint: EndpointConfig) => {
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
    const { response } = await dialog.showMessageBox(win!, {
      type: 'question',
      title: '重新載入白名單',
      message: '重新從磁碟載入白名單，是否繼續？',
      detail: '伺服器將就地套用新白名單，不會中斷現有連線。',
      buttons: ['重新載入', '取消'],
      defaultId: 0,
      cancelId: 1,
    })
    if (response !== 0) {
      emitLog(endpoint.id, '使用者取消白名單重載', 'info')
      return { ok: false, cancelled: true }
    }
    return reloadWhitelist(endpoint)
  })
}
