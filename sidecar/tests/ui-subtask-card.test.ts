// Logique d'abonnement des cartes de sous-tâches (aucun DOM requis) : quand la
// carte ouvre un WebSocket, et ce qu'elle affiche tant qu'elle ne sait rien.
import { expect, test } from "bun:test";
import {
  lastStreamStatus,
  shouldStreamSubtask,
  subtaskFailure,
  subtaskStatus,
} from "../../ui/src/subtaskStream";
import type { StoredEvent } from "../../ui/src/types";

const running: StoredEvent = { id: 1, type: "status", state: "running" };
const done: StoredEvent = { id: 2, type: "status", state: "done" };
const failed: StoredEvent = { id: 3, type: "status", state: "error", error: "annulé" };

test("carte repliée sur une sous-tâche terminée : aucun WebSocket", () => {
  expect(shouldStreamSubtask(false, "done")).toBe(false);
  expect(shouldStreamSubtask(false, "error")).toBe(false);
});

test("carte dépliée : le WebSocket est ouvert même si la sous-tâche est terminée", () => {
  expect(shouldStreamSubtask(true, "done")).toBe(true);
  expect(shouldStreamSubtask(true, "error")).toBe(true);
});

test("sous-tâche encore en cours : le WebSocket est ouvert même repliée (statut live)", () => {
  expect(shouldStreamSubtask(false, "running")).toBe(true);
});

test("tant que le snapshot n'est pas revenu, on n'ouvre rien et on n'affiche pas « en cours »", () => {
  expect(shouldStreamSubtask(false, null)).toBe(false);
  // Le point clé : null, PAS 'running' — sinon toute carte historique compte
  // comme un sub-agent en vol dans la sidebar au chargement du fil.
  expect(subtaskStatus([], null)).toBeNull();
});

test("le flux prime sur le snapshot dès qu'il porte un statut", () => {
  expect(subtaskStatus([running], "done")).toBe("running");
  expect(subtaskStatus([running, done], "running")).toBe("done");
  expect(lastStreamStatus([running, done, failed])).toBe("error");
  // Flux non abonné (carte repliée) : le snapshot fait foi.
  expect(subtaskStatus([], "error")).toBe("error");
});

test("le message d'échec vient du flux, sinon du snapshot", () => {
  expect(subtaskFailure("error", [failed], null)).toBe("annulé");
  expect(subtaskFailure("error", [], "exit 1")).toBe("exit 1");
  expect(subtaskFailure("error", [], null)).toBe("Une erreur est survenue.");
  expect(subtaskFailure("done", [], "exit 1")).toBeNull();
  expect(subtaskFailure(null, [], "exit 1")).toBeNull();
});
