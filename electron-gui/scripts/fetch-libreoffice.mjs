// 下載 LibreOffice Portable（Standard, Windows）並解壓至 resources/libreoffice-portable/
// 供 electron-builder 的 extraResources 打包進安裝包，讓使用者免手動安裝 LibreOffice。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import https from 'node:https'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { retryFsOp } from './fsRetry.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const LO_VERSION = '26.2.1'
const ASSET = `LibreOfficePortable_${LO_VERSION}_MultilingualStandard.paf.exe`
const URL = `https://download.documentfoundation.org/libreoffice/portable/${LO_VERSION}/${ASSET}`

const RESOURCES_DIR = path.join(__dirname, '..', 'resources')
const DEST_DIR = path.join(RESOURCES_DIR, 'libreoffice-portable')
const MARKER = path.join(DEST_DIR, '.version')

function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest)
    const request = u =>
      https.get(u, res => {
        if (res.statusCode === 301 || res.statusCode === 302) {
          file.close()
          return request(res.headers.location)
        }
        if (res.statusCode !== 200) {
          reject(new Error(`下載失敗 HTTP ${res.statusCode}：${u}`))
          return
        }
        const total = Number(res.headers['content-length'] || 0)
        let received = 0
        res.on('data', chunk => {
          received += chunk.length
          if (total) {
            const pct = ((received / total) * 100).toFixed(1)
            process.stdout.write(`\r下載中... ${pct}%`)
          }
        })
        res.pipe(file)
        file.on('finish', () => file.close(() => { process.stdout.write('\n'); resolve() }))
        file.on('error', reject)
      })
    request(url)
  })
}

function find7z() {
  const candidates = [
    'C:\\Program Files\\7-Zip\\7z.exe',
    'C:\\Program Files (x86)\\7-Zip\\7z.exe',
  ]
  for (const c of candidates) {
    if (fs.existsSync(c)) return c
  }
  try {
    const found = execFileSync('where', ['7z'], { encoding: 'utf-8' }).trim().split('\n')[0]?.trim()
    if (found && fs.existsSync(found)) return found
  } catch {
    // not on PATH
  }
  throw new Error('找不到 7-Zip（7z.exe）。請安裝 7-Zip（https://www.7-zip.org/）後再執行此腳本。')
}

async function main() {
  if (os.platform() !== 'win32') {
    console.log('[INFO] 非 Windows 平台，略過 LibreOffice Portable 下載。')
    return
  }

  if (fs.existsSync(MARKER) && fs.readFileSync(MARKER, 'utf-8').trim() === LO_VERSION) {
    console.log(`[INFO] LibreOffice Portable ${LO_VERSION} 已存在，略過下載。`)
    return
  }

  const sevenZip = find7z()

  await retryFsOp(() => fs.rmSync(DEST_DIR, { recursive: true, force: true }))
  fs.mkdirSync(RESOURCES_DIR, { recursive: true })

  const tmpArchive = path.join(os.tmpdir(), ASSET)
  if (fs.existsSync(tmpArchive)) {
    console.log('[INFO] 使用暫存目錄中已存在的安裝包，略過下載。')
  } else {
    console.log(`[INFO] 下載 LibreOffice Portable ${LO_VERSION}...`)
    await downloadFile(URL, tmpArchive)
  }

  // 解壓到 resources/ 底下（與最終目的地同一磁碟），避免大量檔案跨磁碟搬移
  const extractTmp = fs.mkdtempSync(path.join(RESOURCES_DIR, '.lo-extract-'))
  console.log('[INFO] 解壓中...')
  try {
    execFileSync(sevenZip, ['x', tmpArchive, `-o${extractTmp}`, '-y', 'App\\libreoffice\\*'], { stdio: 'inherit' })

    const extractedLibreoffice = path.join(extractTmp, 'App', 'libreoffice')
    if (!fs.existsSync(extractedLibreoffice)) {
      throw new Error('解壓後找不到 App\\libreoffice 目錄，封裝結構可能已變更')
    }

    await retryFsOp(() => fs.renameSync(extractedLibreoffice, DEST_DIR))
    fs.writeFileSync(MARKER, LO_VERSION)

    const sofficeExe = path.join(DEST_DIR, 'program', 'soffice.exe')
    if (!fs.existsSync(sofficeExe)) {
      throw new Error('解壓完成但找不到 program\\soffice.exe')
    }
    console.log(`[INFO] LibreOffice Portable ${LO_VERSION} 已就緒：${DEST_DIR}`)
  } finally {
    await retryFsOp(() => fs.rmSync(extractTmp, { recursive: true, force: true }))
    fs.rmSync(tmpArchive, { force: true })
  }
}

main().catch(err => {
  console.error(`[ERROR] ${err.message}`)
  process.exit(1)
})
