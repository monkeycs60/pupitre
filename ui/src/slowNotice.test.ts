import { expect, test } from 'bun:test'
import { withSlowNotice } from './slowNotice'

test('prévient quand la promesse dépasse le délai, sans l’abandonner', async () => {
  let notified = 0
  let resolve!: (value: string) => void
  const pending = withSlowNotice(new Promise<string>((done) => { resolve = done }), () => { notified += 1 }, 10)

  await new Promise((done) => setTimeout(done, 30))
  expect(notified).toBe(1)

  resolve('créée')
  expect(await pending).toBe('créée')
})

test('reste muet quand la promesse aboutit à temps, même en échec', async () => {
  let notified = 0
  await withSlowNotice(Promise.resolve('ok'), () => { notified += 1 }, 10)
  await expect(withSlowNotice(Promise.reject(new Error('refus')), () => { notified += 1 }, 10)).rejects.toThrow('refus')

  await new Promise((done) => setTimeout(done, 30))
  expect(notified).toBe(0)
})
