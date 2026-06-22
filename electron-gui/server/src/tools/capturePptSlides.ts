import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import type { Canvas } from '@napi-rs/canvas'
import { createCanvas } from '@napi-rs/canvas'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { isPathAllowed } from '../config.js'
import { findSofficePath, SOFFICE_NOT_FOUND_MESSAGE, type SofficeLocation } from '../soffice.js'

const SUPPORTED_EXTENSIONS = ['.ppt', '.pptx', '.odp']
const RENDER_SCALE = 3.0
const INDIVIDUAL_THRESHOLD = 8
const GRID_COLS = 2
const MAX_PER_GRID = 6
const GRID_CELL_WIDTH = 1600
const GRID_PADDING = 12
const GRID_LABEL_HEIGHT = 24

// 內建可攜版的 bootstrap.ini 預設指向不存在的相對路徑，必須覆寫 UserInstallation
// 才能正常初始化；固定使用同一個 profile 目錄以避免每次呼叫都重新初始化。
const PORTABLE_PROFILE_DIR = path.join(os.tmpdir(), 'mcp-libreoffice-profile')

export function getTempDirForPptCapture(endpointId: string): string {
  return path.join(os.tmpdir(), `mcp-ppt-${endpointId}`)
}

function convertToPdf(soffice: SofficeLocation, src: string, outDir: string): string {
  const args: string[] = []
  if (soffice.portable) {
    const profileUrl = `file:///${PORTABLE_PROFILE_DIR.replace(/\\/g, '/')}`
    args.push(`-env:UserInstallation=${profileUrl}`)
  }
  args.push('--headless', '--convert-to', 'pdf', '--outdir', outDir, src)

  const proc = spawnSync(soffice.path, args, { encoding: 'utf-8', timeout: 120_000 })
  if (proc.error) throw new Error(`soffice 執行失敗：${String(proc.error)}`)

  const base = path.basename(src).replace(/\.[^.]+$/, '')
  const pdfPath = path.join(outDir, `${base}.pdf`)
  // 內建可攜版首次執行（建立 profile）時可能回傳非 0 但轉換實際成功，故以輸出檔案是否存在為準
  if (!fs.existsSync(pdfPath)) {
    throw new Error(`soffice 轉換失敗（exit ${proc.status}）：${proc.stderr || proc.stdout}`)
  }
  return pdfPath
}

async function renderPdfToCanvases(pdfPath: string): Promise<Canvas[]> {
  const pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const data = new Uint8Array(fs.readFileSync(pdfPath))
  const doc = await pdfjsLib.getDocument({ data }).promise

  const canvases: Canvas[] = []
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i)
    const viewport = page.getViewport({ scale: RENDER_SCALE })
    const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height))
    const ctx = canvas.getContext('2d')
    await page.render({
      canvasContext: ctx as unknown as CanvasRenderingContext2D,
      viewport,
      canvas: canvas as unknown as HTMLCanvasElement,
    }).promise
    canvases.push(canvas)
  }
  return canvases
}

function pickGridCols(requestedCols: number): number {
  return requestedCols > 0 ? requestedCols : GRID_COLS
}

function buildGridImages(canvases: Canvas[], cols: number): Buffer[] {
  const aspect = canvases[0]!.height / canvases[0]!.width
  const cellH = Math.round(GRID_CELL_WIDTH * aspect)
  const maxPerGrid = cols * Math.ceil(MAX_PER_GRID / cols)

  const chunks: Canvas[][] = []
  for (let i = 0; i < canvases.length; i += maxPerGrid) {
    chunks.push(canvases.slice(i, i + maxPerGrid))
  }

  return chunks.map((chunk, chunkIdx) => {
    const rows = Math.ceil(chunk.length / cols)
    const gridW = cols * GRID_CELL_WIDTH + (cols + 1) * GRID_PADDING
    const cellTotalH = cellH + GRID_LABEL_HEIGHT
    const gridH = rows * cellTotalH + (rows + 1) * GRID_PADDING

    const grid = createCanvas(gridW, gridH)
    const ctx = grid.getContext('2d')
    ctx.fillStyle = 'white'
    ctx.fillRect(0, 0, gridW, gridH)
    ctx.fillStyle = 'black'
    ctx.font = '16px sans-serif'
    ctx.textAlign = 'center'

    chunk.forEach((slideCanvas, i) => {
      const row = Math.floor(i / cols)
      const col = i % cols
      const x = col * GRID_CELL_WIDTH + (col + 1) * GRID_PADDING
      const yBase = row * cellTotalH + (row + 1) * GRID_PADDING
      const slideNum = chunkIdx * maxPerGrid + i + 1

      ctx.fillStyle = 'black'
      ctx.fillText(`#${slideNum}`, x + GRID_CELL_WIDTH / 2, yBase + GRID_LABEL_HEIGHT - 6)

      const yThumb = yBase + GRID_LABEL_HEIGHT
      ctx.drawImage(slideCanvas, x, yThumb, GRID_CELL_WIDTH, cellH)
      ctx.strokeStyle = 'gray'
      ctx.lineWidth = 1
      ctx.strokeRect(x, yThumb, GRID_CELL_WIDTH, cellH)
    })

    return grid.toBuffer('image/jpeg', 95)
  })
}

export function registerCapturePptSlides(
  mcp: McpServer,
  allowedPaths: string[],
  readonlyMode: boolean,
  endpointId: string,
) {
  return mcp.registerTool(
    'md_capture_ppt_slides',
    {
      description: [
        '將 PPT/PPTX/ODP 投影片轉換為 PNG/JPEG 圖片並寫入磁碟（需系統安裝 LibreOffice）。',
        '頁數較多時自動將多張投影片合併為格狀縮圖（grid）以減少檔案數量；可用 mode 強制指定。',
        '回傳的圖片路徑可搭配 file_get_download_uri 工具產生下載連結後讀取。',
        readonlyMode ? '⚠ 唯讀模式：輸出強制寫入暫存目錄。' : '輸出路徑預設為來源檔案同目錄下的 <檔名>_slides/ 子目錄。',
      ].join(' '),
      inputSchema: z.object({
        input_path: z.string().describe('來源 PPT/PPTX/ODP 檔案絕對路徑，必須在 allowed_paths 範圍內'),
        output_dir: z
          .string()
          .default('')
          .describe('輸出目錄；留空則自動決定（唯讀模式下強制寫入暫存目錄）'),
        mode: z
          .enum(['auto', 'individual', 'grid'])
          .default('auto')
          .describe(
            `輸出模式：auto（依頁數自動決定，頁數 <= ${INDIVIDUAL_THRESHOLD} 時逐頁輸出，否則合併為 grid）、individual（強制逐頁輸出單張圖片）、grid（強制合併為格狀縮圖）`,
          ),
        grid_cols: z.number().int().min(0).max(8).default(0).describe(`grid 模式每列欄數，0 表示使用預設值（${GRID_COLS} 欄，即 2x2/2x3 排版）`),
      }),
    },
    async ({ input_path, output_dir, mode, grid_cols }) => {
      const soffice = findSofficePath()
      if (!soffice) return err(SOFFICE_NOT_FOUND_MESSAGE)

      const src = path.resolve(input_path)
      if (!isPathAllowed(src, allowedPaths)) return err('input_path 不在允許的目錄範圍內')
      if (!fs.existsSync(src)) return err(`檔案不存在：${src}`)

      const ext = path.extname(src).toLowerCase()
      if (!SUPPORTED_EXTENSIONS.includes(ext)) {
        return err(`不支援的檔案格式：${ext}。支援的格式：${SUPPORTED_EXTENSIONS.join(', ')}`)
      }

      let outDir: string
      if (output_dir) {
        outDir = path.resolve(output_dir)
        if (!readonlyMode && !isPathAllowed(outDir, allowedPaths)) {
          return err('output_dir 不在允許的目錄範圍內')
        }
      } else if (readonlyMode) {
        outDir = path.join(getTempDirForPptCapture(endpointId), `${path.basename(src, ext)}_${randomUUID().slice(0, 8)}`)
      } else {
        outDir = path.join(path.dirname(src), `${path.basename(src, ext)}_slides`)
      }
      fs.mkdirSync(outDir, { recursive: true })

      const pdfWorkDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-ppt-pdf-'))
      try {
        let pdfPath: string
        try {
          pdfPath = convertToPdf(soffice, src, pdfWorkDir)
        } catch (e) {
          return err(`轉換失敗：${String(e instanceof Error ? e.message : e)}`)
        }

        let canvases: Canvas[]
        try {
          canvases = await renderPdfToCanvases(pdfPath)
        } catch (e) {
          return err(`PDF 渲染失敗：${String(e instanceof Error ? e.message : e)}`)
        }

        if (canvases.length === 0) return err('轉換失敗，投影片頁數為 0')

        const useGrid = mode === 'grid' || (mode === 'auto' && canvases.length > INDIVIDUAL_THRESHOLD)
        const baseName = path.basename(src, ext)
        const outputFiles: string[] = []

        if (useGrid) {
          const cols = pickGridCols(grid_cols)
          const gridBuffers = buildGridImages(canvases, cols)
          gridBuffers.forEach((buf, i) => {
            const name = gridBuffers.length > 1 ? `${baseName}_grid_${i + 1}.jpg` : `${baseName}_grid.jpg`
            const dst = path.join(outDir, name)
            fs.writeFileSync(dst, buf)
            outputFiles.push(dst)
          })
        } else {
          canvases.forEach((canvas, i) => {
            const name = `${baseName}_slide_${String(i + 1).padStart(3, '0')}.png`
            const dst = path.join(outDir, name)
            fs.writeFileSync(dst, canvas.toBuffer('image/png'))
            outputFiles.push(dst)
          })
        }

        return ok({
          success: true,
          slide_count: canvases.length,
          mode: useGrid ? 'grid' : 'individual',
          output_dir: outDir,
          output_files: outputFiles,
          readonly_mode: readonlyMode,
        })
      } finally {
        fs.rmSync(pdfWorkDir, { recursive: true, force: true })
      }
    },
  )
}

function ok(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data) }] }
}

function err(msg: string) {
  return ok({ success: false, error: msg })
}
