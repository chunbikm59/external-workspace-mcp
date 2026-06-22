import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import https from 'node:https'
import { execSync } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const RG_LOCAL_DIR = path.join(__dirname, 'bin')
const RG_VERSION = '14.1.0'

export const VCS_EXCLUDE_GLOBS = ['!.svn', '!.hg', '!.jj', '!.bzr']

function getAssetName(): string {
  const plat = os.platform()
  const arch = os.arch()

  if (plat === 'win32') {
    if (arch === 'x64') return `ripgrep-${RG_VERSION}-x86_64-pc-windows-msvc.zip`
    if (arch === 'arm64') return `ripgrep-${RG_VERSION}-aarch64-pc-windows-msvc.zip`
    throw new Error(`不支援的 Windows 架構：${arch}`)
  }
  if (plat === 'darwin') {
    if (arch === 'arm64') return `ripgrep-${RG_VERSION}-aarch64-apple-darwin.tar.gz`
    return `ripgrep-${RG_VERSION}-x86_64-apple-darwin.tar.gz`
  }
  if (plat === 'linux') {
    if (arch === 'x64') return `ripgrep-${RG_VERSION}-x86_64-unknown-linux-musl.tar.gz`
    if (arch === 'arm64') return `ripgrep-${RG_VERSION}-aarch64-unknown-linux-gnu.tar.gz`
    throw new Error(`不支援的 Linux 架構：${arch}`)
  }
  throw new Error(`不支援的平台：${plat}`)
}

function downloadFile(url: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const file = createWriteStream(dest)
    const request = (u: string) =>
      https.get(u, res => {
        if (res.statusCode === 301 || res.statusCode === 302) {
          file.close()
          return request(res.headers.location!)
        }
        if (res.statusCode !== 200) {
          reject(new Error(`下載失敗 HTTP ${res.statusCode}：${u}`))
          return
        }
        res.pipe(file)
        file.on('finish', () => file.close(() => resolve()))
        file.on('error', reject)
      })
    request(url)
  })
}

async function extractRg(archivePath: string, destDir: string): Promise<string> {
  const isZip = archivePath.endsWith('.zip')
  const rgBin = os.platform() === 'win32' ? 'rg.exe' : 'rg'
  const destBin = path.join(destDir, rgBin)

  if (isZip) {
    // Use PowerShell on Windows to extract ZIP
    execSync(
      `powershell -NoProfile -NonInteractive -Command "Expand-Archive -Path '${archivePath}' -DestinationPath '${destDir}' -Force"`,
    )
    // Find rg.exe recursively in extracted folder
    const findResult = execSync(
      `powershell -NoProfile -NonInteractive -Command "Get-ChildItem -Path '${destDir}' -Recurse -Filter 'rg.exe' | Select-Object -First 1 -ExpandProperty FullName"`,
      { encoding: 'utf-8' },
    ).trim()
    if (!findResult) throw new Error('ZIP 中找不到 rg.exe')
    if (findResult !== destBin) fs.renameSync(findResult, destBin)
  } else {
    execSync(`tar -xzf "${archivePath}" -C "${destDir}" --strip-components=1`)
  }

  if (os.platform() !== 'win32') {
    fs.chmodSync(destBin, 0o755)
  }

  return destBin
}

export async function ensureRipgrep(): Promise<string> {
  try {
    const systemRg = execSync('where rg 2>nul || which rg 2>/dev/null', { encoding: 'utf-8' })
      .trim()
      .split('\n')[0]
      ?.trim()
    if (systemRg && fs.existsSync(systemRg)) {
      return systemRg
    }
  } catch {
    // not found in PATH
  }

  const rgBin = os.platform() === 'win32' ? 'rg.exe' : 'rg'
  const localRg = path.join(RG_LOCAL_DIR, rgBin)
  if (fs.existsSync(localRg)) {
    return localRg
  }

  console.log(`[INFO] 未找到 ripgrep，正在從 GitHub 下載 v${RG_VERSION}...`)

  const asset = getAssetName()
  const url = `https://github.com/BurntSushi/ripgrep/releases/download/${RG_VERSION}/${asset}`
  const tmpPath = path.join(os.tmpdir(), asset)

  fs.mkdirSync(RG_LOCAL_DIR, { recursive: true })
  await downloadFile(url, tmpPath)

  const result = await extractRg(tmpPath, RG_LOCAL_DIR)
  fs.unlinkSync(tmpPath)

  console.log(`[INFO] ripgrep 已安裝至：${result}`)
  return result
}
