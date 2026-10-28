#!/usr/bin/env bun
/**
 * Mesure la fluidité d'une vue du fil dans WebKitGTK, le moteur de l'app
 * Linux, qui saccade là où Chrome reste fluide.
 *
 *   bun run measure:webkit --project affilae-mono --conversation "Interactivité sur la carte"
 *
 * Joue d'abord le témoin (défilement du fil seul), puis le scénario, chacun
 * `--runs` fois, et échoue si le 95e centile du scénario dépasse `--budget`.
 * `--scenario live` attend un tour en cours dans la conversation, mesure le
 * défilement pendant que l'orbe tourne, puis une fois le tour terminé.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

const HERE = import.meta.dir;
const UI_SRC = resolve(HERE, "../../ui/src");

export interface ProbeResult {
  step: string;
  message?: string;
  renderMs?: number | null;
  nodes?: number | null;
  frames?: number;
  p50?: number;
  p95?: number;
  max?: number;
  fps?: number;
  heightShift?: number;
  live?: Omit<ProbeResult, "step" | "live"> & { canvases?: number };
}

export function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length === 0 ? 0 : sorted[Math.floor((sorted.length - 1) / 2)]!;
}

export function summarize(results: ProbeResult[]): Required<Pick<ProbeResult, "p50" | "p95" | "max" | "fps" | "heightShift">> & { renderMs: number | null; nodes: number | null } {
  const done = results.filter((result) => result.step === "done");
  const pick = (key: keyof ProbeResult) => median(done.map((result) => Number(result[key] ?? 0)));
  const render = done.map((result) => result.renderMs).filter((value): value is number => typeof value === "number");
  return {
    p50: pick("p50"),
    p95: pick("p95"),
    max: pick("max"),
    fps: pick("fps"),
    heightShift: Math.max(0, ...done.map((result) => Math.abs(result.heightShift ?? 0))),
    renderMs: render.length ? median(render) : null,
    nodes: done.length && typeof done[0]!.nodes === "number" ? done[0]!.nodes : null,
  };
}

/**
 * Vrai si le Vite visé sert le fichier tel qu'il est sur le disque : un Vite
 * lancé sans surveillance des fichiers continue de servir une version figée,
 * et la mesure porterait alors sur un autre code que celui qu'on croit.
 */
export function servesCurrentSource(served: string, onDisk: string): boolean {
  const map = served.match(/sourceMappingURL=data:application\/json;(?:charset=utf-8;)?base64,([A-Za-z0-9+/=]+)/)?.[1];
  if (!map) return false;
  const decoded = JSON.parse(Buffer.from(map, "base64").toString("utf8")) as { sourcesContent?: string[] };
  return decoded.sourcesContent?.[0] === onDisk;
}

async function probe(url: string, params: Record<string, unknown>, timeoutSeconds: number): Promise<ProbeResult> {
  const script = join(tmpdir(), `pupitre-measure-${process.pid}.js`);
  writeFileSync(script, `window.__params = ${JSON.stringify(params)};\n${readFileSync(join(HERE, "scenario.js"), "utf8")}`);
  const child = Bun.spawn(["python3", "-I", join(HERE, "probe.py"), url, script, String(timeoutSeconds)], { stdout: "pipe", stderr: "pipe" });
  const output = await new Response(child.stdout).text();
  await child.exited;
  const line = output.trim().split("\n").at(-1) ?? "";
  try {
    return JSON.parse(line) as ProbeResult;
  } catch {
    return { step: "error", message: `sonde illisible : ${line || (await new Response(child.stderr).text()).slice(-300)}` };
  }
}

async function preflight(url: string, checkedModule: string): Promise<string | null> {
  const gi = Bun.spawnSync(["python3", "-I", "-c", "import gi; gi.require_version('WebKit2', '4.1'); from gi.repository import WebKit2"]);
  if (gi.exitCode !== 0) return "python3-gi et WebKit2 4.1 sont requis (paquets python3-gi et gir1.2-webkit2-4.1).";
  let served: string;
  try {
    served = await (await fetch(`${url}/src/${checkedModule}`)).text();
  } catch {
    return `${url} ne répond pas : lance Vite (et le sidecar dev sur 4821).`;
  }
  const onDisk = join(UI_SRC, checkedModule);
  if (existsSync(onDisk) && !servesCurrentSource(served, readFileSync(onDisk, "utf8"))) {
    return `${url} sert une version de ${checkedModule} différente du disque (Vite sans surveillance des fichiers ?) : vise un Vite à jour avec --url.`;
  }
  return null;
}

function row(label: string, stats: ReturnType<typeof summarize>): string {
  const render = stats.renderMs === null ? "—" : `${stats.renderMs} ms`;
  return `${label.padEnd(10)} ${String(stats.fps).padStart(4)} img/s   p50 ${String(stats.p50).padStart(5)} ms   p95 ${String(stats.p95).padStart(5)} ms   max ${String(stats.max).padStart(5)} ms   rendu ${render}${stats.nodes ? `   ${stats.nodes} nœuds` : ""}`;
}

async function main() {
  const { values } = parseArgs({
    options: {
      url: { type: "string", default: "http://localhost:5173" },
      project: { type: "string" },
      conversation: { type: "string" },
      scenario: { type: "string", default: "changes" },
      runs: { type: "string", default: "2" },
      frames: { type: "string", default: "150" },
      "step-px": { type: "string", default: "60" },
      budget: { type: "string", default: "80" },
      json: { type: "boolean", default: false },
    },
  });
  if (!values.project || !values.conversation) {
    console.error("Usage : bun run measure:webkit --project <nom> --conversation <début du titre> [--scenario changes|thread|live] [--url http://localhost:5173] [--runs 2] [--budget 80]");
    process.exit(2);
  }
  const url = values.url!.replace(/\/$/, "");
  const problem = await preflight(url, values.scenario === "changes" ? "ConversationChangesView.tsx" : "Chat.tsx");
  if (problem) {
    console.error(problem);
    process.exit(2);
  }
  const runs = Math.max(1, Number(values.runs));
  const base = { project: values.project, conversation: values.conversation, frames: Number(values.frames), stepPx: Number(values["step-px"]), settleMs: 1_500 };
  const collect = async (scenario: string) => {
    const results: ProbeResult[] = [];
    for (let index = 0; index < runs; index += 1) {
      const result = await probe(url, { ...base, scenario }, 240);
      if (result.step !== "done") {
        console.error(`${scenario} : ${result.step}${result.message ? ` — ${result.message}` : ""}`);
        process.exit(2);
      }
      results.push(result);
    }
    return summarize(results);
  };

  if (values.scenario === "live") {
    const result = await probe(url, { ...base, scenario: "live" }, 420);
    if (result.step !== "done" || !result.live) {
      console.error(`live : ${result.step}${result.message ? ` — ${result.message}` : ""}`);
      process.exit(2);
    }
    const live = summarize([{ ...result.live, step: "done" }]);
    const idle = summarize([result]);
    const budget = Number(values.budget);
    const failed = live.p95 > budget;
    if (values.json) {
      console.log(JSON.stringify({ live, idle, canvases: result.live.canvases, budget, failed }));
    } else {
      console.log(`WebKitGTK · ${values.project} · ${values.conversation} · tour en cours puis terminé`);
      console.log(row("orbe", live) + `   ${result.live.canvases ?? 0} canvas`);
      console.log(row("sans orbe", idle));
      console.log(failed ? `ÉCHEC : p95 ${live.p95} ms au-dessus du budget de ${budget} ms.` : `OK : p95 ${live.p95} ms dans le budget de ${budget} ms.`);
    }
    process.exit(failed ? 1 : 0);
  }

  const baseline = await collect("thread");
  const measured = values.scenario === "thread" ? baseline : await collect(values.scenario!);
  const budget = Number(values.budget);
  const failed = measured.p95 > budget || measured.heightShift !== 0;
  if (values.json) {
    console.log(JSON.stringify({ baseline, measured, budget, failed }));
  } else {
    console.log(`WebKitGTK · ${values.project} · ${values.conversation} · ${runs} passage${runs > 1 ? "s" : ""} (médianes)`);
    console.log(row("témoin", baseline));
    if (values.scenario !== "thread") console.log(row(values.scenario!, measured));
    if (measured.heightShift !== 0) console.log(`La hauteur de la vue a bougé de ${measured.heightShift} px pendant le défilement : le fil saute.`);
    console.log(failed ? `ÉCHEC : p95 ${measured.p95} ms au-dessus du budget de ${budget} ms (témoin ${baseline.p95} ms).` : `OK : p95 ${measured.p95} ms dans le budget de ${budget} ms.`);
  }
  process.exit(failed ? 1 : 0);
}

if (import.meta.main) await main();
