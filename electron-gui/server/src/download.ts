import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Request, Response, Router } from 'express'
import { Router as createRouter } from 'express'

export const DOWNLOAD_TOKEN_TTL = 600

interface TokenEntry {
  filePath: string
  expiresAt: number
}

const tokenStore = new Map<string, TokenEntry>()

export const sessionBaseUrls = new Map<string, string>()

function purgeExpired(): void {
  const now = Date.now() / 1000
  for (const [token, entry] of tokenStore) {
    if (now > entry.expiresAt) tokenStore.delete(token)
  }
}

export function createDownloadToken(filePath: string): string {
  purgeExpired()
  const token = randomUUID()
  tokenStore.set(token, {
    filePath,
    expiresAt: Date.now() / 1000 + DOWNLOAD_TOKEN_TTL,
  })
  return token
}

export function buildBaseUrl(req: Request, fallbackHost: string, port: number): string {
  const proto = (req.headers['x-forwarded-proto'] as string | undefined) ?? req.protocol ?? 'http'
  const host =
    (req.headers['x-forwarded-host'] as string | undefined) ??
    (req.headers['host'] as string | undefined) ??
    `${fallbackHost === '0.0.0.0' || !fallbackHost ? 'localhost' : fallbackHost}:${port}`
  return `${proto}://${host}`
}

export function captureSessionBaseUrl(req: Request, fallbackHost: string, port: number): void {
  const sessionId = req.headers['mcp-session-id'] as string | undefined
  if (sessionId) {
    sessionBaseUrls.set(sessionId, buildBaseUrl(req, fallbackHost, port))
  }
}

export function getDownloadUrl(
  token: string,
  sessionId: string | undefined,
  fallbackHost: string,
  port: number,
): string {
  const base =
    (sessionId ? sessionBaseUrls.get(sessionId) : undefined) ??
    `http://${fallbackHost === '0.0.0.0' || !fallbackHost ? 'localhost' : fallbackHost}:${port}`
  return `${base}/download/${token}`
}

export function createDownloadRouter(): Router {
  const router = createRouter()

  router.get('/download/:token', (req: Request, res: Response): void => {
    purgeExpired()
    const token = req.params['token']
    if (!token) {
      res.status(404).json({ error: 'Token 無效或已過期' })
      return
    }
    const entry = tokenStore.get(token)

    if (!entry) {
      res.status(404).json({ error: 'Token 無效或已過期' })
      return
    }

    if (Date.now() / 1000 > entry.expiresAt) {
      tokenStore.delete(token)
      res.status(410).json({ error: 'Token 已過期' })
      return
    }

    if (!fs.existsSync(entry.filePath)) {
      res.status(404).json({ error: '檔案不存在' })
      return
    }

    const filename = path.basename(entry.filePath)
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`)
    res.sendFile(path.resolve(entry.filePath))
  })

  return router
}
