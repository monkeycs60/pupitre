export interface Point {
  x: number;
  y: number;
  elementX: number;
  elementY: number;
  documentX?: number;
  documentY?: number;
}

export interface CaptureRect { left: number; top: number; width: number; height: number; devicePixelRatio: number }

export interface Annotation {
  number: number;
  instruction: string;
  point: Point;
  selectors: string[];
  html: string;
  styles: Record<string, string>;
  captureRect?: CaptureRect;
  cropDataUrl?: string;
  viewportDataUrl?: string;
}

export type DraftAnnotation = Omit<Annotation, "number">;
export type Carts = Record<string, Annotation[]>;

export interface ProjectSummary { id: string; name: string }
export interface ConversationSummary {
  id: string;
  title: string;
  created_on_branch: string | null;
  worktree_path: string | null;
}

export type Resolution =
  | { status: "resolved"; project: ProjectSummary; destinations?: Destinations }
  | { status: "ambiguous" | "unresolved"; projects: ProjectSummary[] };

export interface Destinations {
  branches: string[];
  currentBranch: string | null;
  conversations: ConversationSummary[];
}
