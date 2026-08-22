import type { AppEvent } from "../events";
import { parseClaudeLine } from "./claude-parser";

/** `streaming-messages-json` : même fil Messages que Claude Code. */
export function parseGrokLine(line: string): AppEvent[] {
  return parseClaudeLine(line, "grok");
}
