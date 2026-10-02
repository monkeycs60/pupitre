import { realpathSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'

export function canonicalPath(...parts: string[]): string {
  const absolute = resolve(...parts)
  const missing: string[] = []
  let current = absolute
  while (true) {
    try { return join(realpathSync(current), ...missing) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return absolute
    }
    const parent = dirname(current)
    if (parent === current) return absolute
    missing.unshift(basename(current))
    current = parent
  }
}
