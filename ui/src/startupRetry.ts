interface RetryOptions {
  cancelled?: () => boolean
  delay?: () => Promise<void>
}

const retryDelay = () => new Promise<void>((resolve) => setTimeout(resolve, 1_000))

export async function retryUntilAvailable<T>(
  read: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T | null> {
  const cancelled = options.cancelled ?? (() => false)
  const delay = options.delay ?? retryDelay

  while (!cancelled()) {
    try {
      return await read()
    } catch {
      if (cancelled()) return null
      await delay()
    }
  }

  return null
}
