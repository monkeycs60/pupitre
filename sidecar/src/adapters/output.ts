const DEFAULT_TOOL_OUTPUT_LIMIT = 60_000;

/**
 * Borne les sorties d'outils sans perdre leur fin, où se trouvent généralement
 * le résumé d'une suite de tests et la cause d'un échec.
 */
export function boundedToolOutput(
  value: unknown,
  limit = DEFAULT_TOOL_OUTPUT_LIMIT,
): string {
  const output = String(value ?? "");
  if (output.length <= limit) return output;
  const marker = "\n\n[… sortie intermédiaire tronquée …]\n\n";
  const available = Math.max(0, limit - marker.length);
  const headLength = Math.ceil(available / 2);
  const tailLength = Math.floor(available / 2);
  return `${output.slice(0, headLength)}${marker}${output.slice(-tailLength)}`;
}
