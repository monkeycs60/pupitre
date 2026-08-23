// Serveur MCP qui forke un petit-enfant puis se tait. Simule `npx mcp-remote` :
// tuer seulement le process lancé ne suffit pas, le petit-enfant survit.
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

if (process.env.FAKE_MCP_CHILD_PID) {
  const child = spawn("sleep", ["30"], { stdio: "ignore" });
  if (child.pid !== undefined) {
    writeFileSync(process.env.FAKE_MCP_CHILD_PID, String(child.pid));
  }
}

await Bun.sleep(120_000);
