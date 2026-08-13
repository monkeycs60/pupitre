import { expect, test } from 'bun:test'
import { reviewCoversHead } from './reviewFreshness'
import type { Review } from './types'

const reviewedHead = 'a'.repeat(40)
const review = {
  status: 'done',
  git_ref_head: reviewedHead,
} as Review

test('une review conforme ne couvre que le HEAD réellement analysé', () => {
  expect(reviewCoversHead(review, reviewedHead)).toBe(true)
  expect(reviewCoversHead(review, 'b'.repeat(40))).toBe(false)
  expect(reviewCoversHead({ ...review, status: 'running' }, reviewedHead)).toBe(false)
  expect(reviewCoversHead(review, null)).toBe(false)
})
