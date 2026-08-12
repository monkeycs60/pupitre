import type { Project } from "./stores/projects";
import type { Conversation } from "./stores/conversations";

/**
 * Où travaillent les agents.
 *
 * Une conversation peut naître sur une branche : Pupitre lui crée alors un
 * worktree git dédié, et tout ce qu'elle lance — tours, sous-tâches, débriefs,
 * tests, reviews — doit s'exécuter dedans. Sans quoi deux conversations sur des
 * branches différentes se contaminent, et un agent qui change de branche casse
 * les autres.
 *
 * Passer par ces deux fonctions plutôt que par `project.path` rend le choix
 * explicite : `sidecar/tests/workspace-cwd.test.ts` refuse tout nouveau site qui
 * figerait son répertoire sur le projet.
 */

/** Le répertoire de travail d'une conversation : son worktree, sinon le dépôt. */
export function conversationCwd(
  project: Project,
  conversation: Conversation | null | undefined,
): string {
  return conversation?.worktree_path ?? project.path;
}

/**
 * Le dépôt principal, pour ce qui n'appartient à aucune conversation — la
 * composition de skills et les suggestions travaillent sur le projet entier.
 */
export function projectCwd(project: Project): string {
  return project.path;
}
