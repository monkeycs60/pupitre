import type { Review } from './types'

export function reviewCoversHead(review: Review | null, currentHead: string | null): boolean {
  return review?.status === 'done'
    && currentHead !== null
    && review.git_ref_head === currentHead
}
