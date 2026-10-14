export const SLOW_CREATION_MS = 10_000

export async function withSlowNotice<T>(
  pending: Promise<T>,
  onSlow: () => void,
  delayMs: number = SLOW_CREATION_MS,
): Promise<T> {
  const timer = setTimeout(onSlow, delayMs)
  try {
    return await pending
  } finally {
    clearTimeout(timer)
  }
}
