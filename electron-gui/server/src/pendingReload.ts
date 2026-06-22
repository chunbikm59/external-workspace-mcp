import { randomUUID } from 'node:crypto'

interface PendingRequest {
  resolve: (approved: boolean) => void
}

const pending = new Map<string, PendingRequest>()

export function createPendingReload(): { id: string; wait: Promise<boolean> } {
  const id = randomUUID()
  const wait = new Promise<boolean>(resolve => {
    pending.set(id, { resolve })
  })
  return { id, wait }
}

export function resolvePendingReload(id: string, approved: boolean): boolean {
  const req = pending.get(id)
  if (!req) return false
  pending.delete(id)
  req.resolve(approved)
  return true
}
