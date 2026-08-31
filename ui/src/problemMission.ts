import type { Problem, ProblemPlan } from './types'

export type ProblemMissionMode = 'agent' | 'conversation'

export interface ProblemMissionSeed {
  problems: Problem[]
  /** Axes retenus par problématique ; absent = tous les axes. */
  planIndices?: Record<string, number[]>
  missionTitle: string
  mode?: ProblemMissionMode
}

export function missionPlans(
  problem: Problem,
  planIndices?: Record<string, number[]>,
): ProblemPlan[] {
  const indices = planIndices?.[problem.id]
  if (indices === undefined) return problem.plans
  return indices
    .map((index) => problem.plans[index])
    .filter((plan): plan is ProblemPlan => plan !== undefined)
}

export function problemMissionDraft(seed: ProblemMissionSeed): string {
  const sections = seed.problems.map((problem) => [
    `${problem.public_id} — ${problem.title}`,
    ...missionPlans(problem, seed.planIndices).map((plan) => `- ${plan.title} : ${plan.instruction}`),
  ].join('\n'))
  const markers = seed.problems.map((problem) => `[${problem.public_id}]`).join(' ')
  return [`Mission : ${seed.missionTitle}`, ...sections, markers].join('\n\n')
}
