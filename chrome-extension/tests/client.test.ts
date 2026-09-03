import { expect, test } from "bun:test";
import { PupitreClient } from "../src/client";

test("envoie le jeton seulement depuis le client privilégié", async () => {
  let request: Request | null = null;
  const client = new PupitreClient("http://127.0.0.1:4821", "secret", async (input, init) => {
    request = new Request(input, init);
    return Response.json({ status: "unresolved", projects: [] });
  });
  await client.resolve("http://localhost:5173", "/settings");
  expect(request!.headers.get("authorization")).toBe("Bearer secret");
  expect(await request!.json()).toEqual({ origin: "http://localhost:5173", pathname: "/settings" });
});

test("rend le message d'erreur du sidecar", async () => {
  const client = new PupitreClient("http://127.0.0.1:4821", "bad", async () =>
    Response.json({ error: "appairage requis" }, { status: 401 }));
  expect(client.resolve("http://localhost:5173", "/")).rejects.toThrow("appairage requis");
});
