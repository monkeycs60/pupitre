import { readFileSync, readlinkSync } from 'node:fs'

export interface ListeningSocket { pid: number; port: number; process: string }

export function parseLinuxSockets(output: string): ListeningSocket[] {
  const sockets: ListeningSocket[] = []
  const seen = new Set<string>()
  for (const line of output.split('\n')) {
    const port = Number(line.trim().split(/\s+/u)[3]?.match(/:(\d+)$/u)?.[1])
    const pid = Number(line.match(/pid=(\d+)/u)?.[1])
    const process = line.match(/users:\(\("([^"]+)/u)?.[1]
    const id = `${pid}:${port}`
    if (!Number.isInteger(port) || !Number.isInteger(pid) || !process || seen.has(id)) continue
    seen.add(id)
    sockets.push({ pid, port, process })
  }
  return sockets
}

export function parseMacSockets(output: string): ListeningSocket[] {
  const sockets: ListeningSocket[] = []
  const seen = new Set<string>()
  let pid = 0
  let command = ''
  for (const line of output.split('\n')) {
    if (line.startsWith('p')) { pid = Number(line.slice(1)); command = '' }
    if (line.startsWith('c')) command = line.slice(1)
    if (!line.startsWith('n')) continue
    const port = Number(line.match(/:(\d+)$/u)?.[1])
    const id = `${pid}:${port}`
    if (!Number.isInteger(pid) || pid < 1 || !Number.isInteger(port) || port < 1 || port > 65535 || !command || seen.has(id)) continue
    seen.add(id)
    sockets.push({ pid, port, process: command })
  }
  return sockets
}

function output(command: string[]): string {
  try {
    const result = Bun.spawnSync(command, { stderr: 'ignore', timeout: 5_000 })
    return result.exitCode === 0 ? result.stdout.toString() : ''
  } catch { return '' }
}

export function listeningSockets(platform = process.platform): ListeningSocket[] {
  return platform === 'darwin'
    ? parseMacSockets(output(['/usr/sbin/lsof', '-nP', '-iTCP', '-sTCP:LISTEN', '-Fpcn']))
    : parseLinuxSockets(output(['ss', '-ltnpH']))
}

export function processCwd(pid: number, platform = process.platform): string | null {
  if (!Number.isInteger(pid) || pid < 1) return null
  if (platform === 'darwin') {
    return output(['/usr/sbin/lsof', '-a', '-p', String(pid), '-d', 'cwd', '-Fn'])
      .split('\n').find((line) => line.startsWith('n/'))?.slice(1) ?? null
  }
  try { return readlinkSync(`/proc/${pid}/cwd`) } catch { return null }
}

export function processCommand(pid: number, platform = process.platform): string {
  if (!Number.isInteger(pid) || pid < 1) return ''
  if (platform === 'darwin') return output(['/bin/ps', '-p', String(pid), '-o', 'command=']).trim()
  try { return readFileSync(`/proc/${pid}/cmdline`, 'utf8').replaceAll('\0', ' ') } catch { return '' }
}
