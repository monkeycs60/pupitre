import { expect, test } from 'bun:test'
import { retryUntilAvailable } from './startupRetry'

test('rejoue une lecture de démarrage après un échec transitoire', async () => {
  let attempts = 0

  const result = await retryUntilAvailable(
    async () => {
      attempts += 1
      if (attempts === 1) throw new TypeError('sidecar indisponible')
      return ['pupitre']
    },
    { delay: async () => {} },
  )

  expect(result).toEqual(['pupitre'])
  expect(attempts).toBe(2)
})

test('arrête les reprises lorsque le composant est démonté', async () => {
  let attempts = 0

  const result = await retryUntilAvailable(
    async () => {
      attempts += 1
      throw new TypeError('sidecar indisponible')
    },
    {
      cancelled: () => attempts === 1,
      delay: async () => {},
    },
  )

  expect(result).toBeNull()
  expect(attempts).toBe(1)
})
