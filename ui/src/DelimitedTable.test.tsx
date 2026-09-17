import { expect, test } from 'bun:test'
import { parseDelimited } from './delimited'

test('parse les cellules CSV échappées et les retours à la ligne', () => {
  const result = parseDelimited('\uFEFFname,notes\r\nAlice,"bonjour, monde"\r\nBob,"ligne 1\nligne 2"', 'csv')

  expect(result.headers).toEqual(['name', 'notes'])
  expect(result.rows).toEqual([
    ['Alice', 'bonjour, monde'],
    ['Bob', 'ligne 1\nligne 2'],
  ])
  expect(result.totalRows).toBe(2)
})

test('détecte les CSV séparés par des points-virgules', () => {
  const result = parseDelimited('name;city\nAlice;Paris', 'csv')

  expect(result.headers).toEqual(['name', 'city'])
  expect(result.rows).toEqual([['Alice', 'Paris']])
})
