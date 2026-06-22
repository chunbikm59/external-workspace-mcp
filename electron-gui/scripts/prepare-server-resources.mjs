// 在獨立暫存目錄安裝 server 的 production-only 依賴，供 electron-builder extraResources 打包。
// 不會動到開發用的 server/node_modules。
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { retryFsOp } from './fsRetry.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SERVER_DIR = path.join(__dirname, '..', 'server')
const BUILD_TMP_DIR = path.join(__dirname, '..', 'build-tmp', 'server')

async function main() {
  const distDir = path.join(SERVER_DIR, 'dist')
  if (!fs.existsSync(distDir)) {
    throw new Error(`找不到 server/dist，請先執行 npm run build:server（${distDir}）`)
  }

  // build-tmp 的 node_modules 可能因防毒軟體掃描殘留檔案鎖定，重試以化解 EBUSY
  await retryFsOp(() => fs.rmSync(BUILD_TMP_DIR, { recursive: true, force: true }))
  fs.mkdirSync(BUILD_TMP_DIR, { recursive: true })

  fs.cpSync(distDir, path.join(BUILD_TMP_DIR, 'dist'), { recursive: true })
  fs.copyFileSync(path.join(SERVER_DIR, 'package.json'), path.join(BUILD_TMP_DIR, 'package.json'))
  fs.copyFileSync(path.join(SERVER_DIR, 'package-lock.json'), path.join(BUILD_TMP_DIR, 'package-lock.json'))

  console.log('[INFO] 安裝 server production 依賴...')
  execFileSync('npm', ['ci', '--omit=dev'], { cwd: BUILD_TMP_DIR, stdio: 'inherit', shell: true })

  console.log(`[INFO] server production 資源已就緒：${BUILD_TMP_DIR}`)
}

main().catch(err => {
  console.error(`[ERROR] ${err.message}`)
  process.exit(1)
})
