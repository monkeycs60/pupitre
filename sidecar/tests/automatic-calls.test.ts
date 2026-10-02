import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { AutomaticCalls } from "../src/automatic-calls";

test("le plafond compte les tentatives et isole les types d’appel", async () => {
  const db = new Database(":memory:");
  try {
    const calls = new AutomaticCalls(db);
    for (let i = 0; i < 10; i++)
      await calls.run("classement", async () => null);
    await expect(
      calls.run("classement", async () => {
        throw new Error("ne doit pas démarrer");
      }),
    ).rejects.toThrow("Plafond");
    await expect(
      calls.run("récolte", async () => {
        throw new Error("modèle indisponible");
      }),
    ).rejects.toThrow("modèle indisponible");
    expect(calls.list()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "classement", count: 10 }),
        expect.objectContaining({ kind: "récolte", count: 1 }),
      ]),
    );
  } finally {
    db.close();
  }
});
