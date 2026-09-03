import { cpSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const dist = join(root, "dist");
rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

for (const file of ["manifest.json", "src/popup.html", "src/popup.css", "src/content.css"]) {
  cpSync(join(root, file), join(dist, file.split("/").at(-1)!));
}

for (const entrypoint of ["src/background.ts", "src/content.ts", "src/popup.ts"]) {
  const result = await Bun.build({ entrypoints: [join(root, entrypoint)], outdir: dist, target: "browser", format: "esm", minify: false });
  if (!result.success) throw new AggregateError(result.logs, `Build impossible : ${entrypoint}`);
}
