import type { Annotation } from "./types";

export interface LocatedAnnotation {
  left: number;
  top: number;
  width: number;
  height: number;
  pointX: number;
  pointY: number;
}

export function locateAnnotation(annotation: Annotation, root: ParentNode = document): LocatedAnnotation | null {
  let element: Element | null = null;
  for (const selector of annotation.selectors) {
    try {
      element = root.querySelector(selector);
      if (element) break;
    } catch {}
  }
  if (!element) return null;
  const rect = element.getBoundingClientRect();
  return {
    left: rect.left,
    top: rect.top,
    width: rect.width,
    height: rect.height,
    pointX: rect.left + Math.min(Math.max(annotation.point.elementX, 0), rect.width),
    pointY: rect.top + Math.min(Math.max(annotation.point.elementY, 0), rect.height),
  };
}
