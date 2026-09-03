import type { Carts, DraftAnnotation } from "./types";

export function addAnnotation(carts: Carts, projectId: string, annotation: DraftAnnotation): Carts {
  const current = carts[projectId] ?? [];
  return { ...carts, [projectId]: [...current, { ...annotation, number: current.length + 1 }] };
}

export function removeAnnotation(carts: Carts, projectId: string, number: number): Carts {
  const remaining = (carts[projectId] ?? [])
    .filter((annotation) => annotation.number !== number)
    .map((annotation, index) => ({ ...annotation, number: index + 1 }));
  return { ...carts, [projectId]: remaining };
}
