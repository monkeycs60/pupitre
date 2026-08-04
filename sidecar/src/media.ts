import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";

export class MediaStore {
  private dir: string;
  constructor(dataDir: string) {
    this.dir = join(dataDir, "media");
    mkdirSync(this.dir, { recursive: true });
  }
  importFile(absPath: string): string {
    const name = crypto.randomUUID() + (extname(absPath) || ".png");
    copyFileSync(absPath, join(this.dir, name));
    return name;
  }
  importFromBase64(b64: string, ext: string): string {
    const name = `${crypto.randomUUID()}.${ext}`;
    writeFileSync(join(this.dir, name), Buffer.from(b64, "base64"));
    return name;
  }
  absolutePath(name: string): string {
    if (name.includes("/") || name.includes("..")) throw new Error("nom media invalide");
    return join(this.dir, name);
  }
}
