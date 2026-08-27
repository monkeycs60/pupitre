import { spawn, type ChildProcess } from "node:child_process";

/**
 * Tout ce qui lance un provider ou un serveur MCP passe par ici.
 *
 * Un provider démarre sa propre flotte de serveurs MCP, et `npx` fork un
 * `sh` puis un `node`. Ces petits-enfants ne reçoivent pas un signal visé sur
 * le pid du parent : ils sont simplement reparentés et survivent. Des
 * centaines s'accumulaient ainsi jusqu'à saturer la mémoire de la machine.
 */

/**
 * Isole le process et sa descendance dans un groupe joignable d'un signal.
 *
 * Le type reprend celui de `spawn` : ce sont ses surcharges qui déduisent des
 * flux non nullables à partir du `stdio` passé, et une signature propre les
 * perdrait sur tous les appelants.
 */
export const spawnGroup: typeof spawn = ((
  command: string,
  args: readonly string[],
  options: Record<string, unknown>,
) => spawn(command, args, { ...options, detached: true })) as typeof spawn;

/**
 * Vise le groupe entier via le pid négatif. Le groupe survit au process lancé
 * tant qu'un serveur MCP y tourne, donc l'échec du signal de groupe est le
 * seul indice fiable qu'il ne reste plus rien à tuer.
 */
export function killGroup(
  child: ChildProcess,
  signal: NodeJS.Signals = "SIGTERM",
): boolean {
  const pid = child.pid;
  if (pid === undefined) return false;
  try {
    process.kill(-pid, signal);
    return true;
  } catch {
    try {
      return child.kill(signal);
    } catch {
      return false;
    }
  }
}
