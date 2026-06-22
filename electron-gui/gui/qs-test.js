const { app, BrowserWindow } = require('electron')
const fs = require('fs')
fs.writeFileSync('C:/Users/Chunbi/AppData/Local/Temp/qs-result.txt', 'electron loaded OK')
app.whenReady().then(() => {
  const win = new BrowserWindow({ width: 400, height: 300, show: false })
  win.loadURL('about:blank')
  fs.writeFileSync('C:/Users/Chunbi/AppData/Local/Temp/qs-result.txt', 'app ready OK')
  setTimeout(() => app.quit(), 2000)
})