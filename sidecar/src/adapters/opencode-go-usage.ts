import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const USAGE_URL = "https://opencode.ai/zen/go/v1/usage";

function apiKey(): string | null {
  if (process.env.OPENCODE_API_KEY) return process.env.OPENCODE_API_KEY;
  try {
    const env = readFileSync(join(homedir(), ".reasonix", ".env"), "utf8");
    const match = env.match(/^OPENCODE_API_KEY\s*=\s*["']?([^\s"']+)/m);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

export async function readOpenCodeGoUsage(signal?: AbortSignal): Promise<unknown | null> {
  const key = apiKey();
  if (!key) return null;
  try {
    const response = await fetch(USAGE_URL, {
      headers: { authorization: `Bearer ${key}`, accept: "application/json" },
      signal: signal ?? AbortSignal.timeout(8_000),
    });
    return response.ok ? await response.json() : null;
  } catch {
    return null;
  }
}
