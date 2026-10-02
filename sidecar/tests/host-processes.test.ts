import { expect, test } from 'bun:test'
import { parseMacSockets } from '../src/host-processes'

test('lsof associe chaque port au bon processus et déduplique IPv4/IPv6', () => {
  expect(parseMacSockets([
    'p123', 'cnode', 'n127.0.0.1:5173', 'n[::1]:5173', 'n*:9229',
    'p456', 'cBun', 'n*:4821', 'p789', 'n*:3000',
    'p900', 'cnode', 'nlocalhost:0', 'n*:65536', 'ninvalid',
  ].join('\n'))).toEqual([
    { pid: 123, process: 'node', port: 5173 },
    { pid: 123, process: 'node', port: 9229 },
    { pid: 456, process: 'Bun', port: 4821 },
  ])
})
