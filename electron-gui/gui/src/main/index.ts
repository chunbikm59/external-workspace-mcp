import { app, BrowserWindow, shell, Menu } from 'electron'
import path from 'node:path'
import { registerIpcHandlers } from './ipcHandlers.js'
import { getAutoStartEndpoints } from './configManager.js'
import { startServer, stopAllServers } from './serverManager.js'

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1100,
    height: 720,
    minWidth: 800,
    minHeight: 550,
    title: 'External Workspace for Agents',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
    },
    backgroundColor: '#0f172a',
    show: false,
  })

  win.on('ready-to-show', () => win.show())

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  const rendererUrl = process.env['ELECTRON_RENDERER_URL']
  if (!app.isPackaged && rendererUrl) {
    win.loadURL(rendererUrl)
  } else {
    win.loadFile(path.join(__dirname, '../renderer/index.html'))
  }

  return win
}

app.whenReady().then(async () => {
  app.setAppUserModelId('com.mcp-workspace.gui')

  registerIpcHandlers()

  Menu.setApplicationMenu(null)

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })

  // Auto-start configured endpoints
  const autoStart = getAutoStartEndpoints()
  for (const endpoint of autoStart) {
    await startServer(endpoint)
  }
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', async () => {
  await stopAllServers()
})
