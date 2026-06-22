import type { Request, Response, NextFunction } from 'express'

export function bearerAuth(token: string | undefined) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!token) {
      next()
      return
    }
    const auth = req.headers['authorization'] ?? ''
    if (!auth.startsWith('Bearer ') || auth.slice(7) !== token) {
      res.status(401).json({ error: 'Unauthorized' })
      return
    }
    next()
  }
}

// Admin routes are only ever called by the local GUI process, never exposed
// to remote MCP clients — require an explicit token rather than allowing
// open access when unset.
export function adminAuth(token: string | undefined) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!token) {
      res.status(503).json({ error: 'Admin interface not enabled' })
      return
    }
    const auth = req.headers['authorization'] ?? ''
    if (!auth.startsWith('Bearer ') || auth.slice(7) !== token) {
      res.status(401).json({ error: 'Unauthorized' })
      return
    }
    next()
  }
}
