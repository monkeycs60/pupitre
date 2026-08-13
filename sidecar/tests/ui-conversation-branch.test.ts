import { expect, test } from "bun:test";
import { branchOfWorktree, conversationSubtitle } from "../../ui/src/conversationBranch";

test("une conversation du dépôt principal garde son preset sous le titre", () => {
  // Afficher « master » sur toutes les lignes n'apprendrait rien et coûterait
  // le preset, qui lui distingue les conversations entre elles.
  expect(conversationSubtitle({ worktree_path: null }, "Vitesse"))
    .toEqual({ kind: "preset", label: "Vitesse" });
});

test("une conversation isolée affiche sa branche à la place du preset", () => {
  expect(conversationSubtitle(
    { worktree_path: "/home/x/.local/share/pupitre/worktrees/projet/ticket-42" },
    "Vitesse",
  )).toEqual({ kind: "branch", label: "ticket-42" });
});

test("le nom de branche se lit sur le dernier segment du chemin", () => {
  expect(branchOfWorktree("/wt/projet/codex-refonte")).toBe("codex-refonte");
  expect(branchOfWorktree("/wt/projet/ticket-7/")).toBe("ticket-7");
  expect(branchOfWorktree(null)).toBeNull();
  expect(branchOfWorktree("   ")).toBeNull();
});

test("un champ absent vaut « pas de worktree » plutôt qu'un plantage", () => {
  // Une réponse d'API antérieure au champ ne doit pas casser le rendu.
  expect(branchOfWorktree(undefined)).toBeNull();
  expect(conversationSubtitle({}, "Vitesse")).toEqual({ kind: "preset", label: "Vitesse" });
});
