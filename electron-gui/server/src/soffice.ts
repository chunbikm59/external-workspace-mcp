import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const WINDOWS_CANDIDATES = [
  'C:\\Program Files\\LibreOffice\\program\\soffice.exe',
  'C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe',
]

const MACOS_CANDIDATES = ['/Applications/LibreOffice.app/Contents/MacOS/soffice']

const LINUX_CANDIDATES = ['/usr/bin/soffice', '/usr/lib/libreoffice/program/soffice', '/opt/libreoffice/program/soffice']

// 內建可攜版相對於 server bundle 的位置：
// - 開發模式：server/src/soffice.ts -> ../../resources/libreoffice-portable
// - 打包後：  resources/server/dist/main.js -> ../../libreoffice-portable
const PORTABLE_CANDIDATES = [
  path.join(__dirname, '..', '..', 'resources', 'libreoffice-portable', 'program', 'soffice.exe'),
  path.join(__dirname, '..', '..', 'libreoffice-portable', 'program', 'soffice.exe'),
]

export interface SofficeLocation {
  path: string
  portable: boolean
}

let cached: SofficeLocation | null | undefined

export function findSofficePath(): SofficeLocation | null {
  if (cached !== undefined) return cached

  try {
    const which = os.platform() === 'win32' ? 'where soffice' : 'which soffice'
    const found = execSync(which, { encoding: 'utf-8' }).trim().split('\n')[0]?.trim()
    if (found && fs.existsSync(found)) {
      cached = { path: found, portable: false }
      return cached
    }
  } catch {
    // not on PATH
  }

  const candidates =
    os.platform() === 'win32' ? WINDOWS_CANDIDATES : os.platform() === 'darwin' ? MACOS_CANDIDATES : LINUX_CANDIDATES

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      cached = { path: candidate, portable: false }
      return cached
    }
  }

  if (os.platform() === 'win32') {
    for (const candidate of PORTABLE_CANDIDATES) {
      if (fs.existsSync(candidate)) {
        cached = { path: candidate, portable: true }
        return cached
      }
    }
  }

  cached = null
  return cached
}

export const SOFFICE_NOT_FOUND_MESSAGE =
  '找不到 LibreOffice（soffice）。此功能需要安裝 LibreOffice 才能將 PPT/PPTX 轉換為圖片，請至 https://www.libreoffice.org/download/ 安裝後重試。'
