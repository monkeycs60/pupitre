import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  GitLabAuthError,
  GitLabClient,
  GitLabHttpError,
  mergeRequestIidOfRef,
  parseDeployment,
  parseMergeRequest,
  readGlabToken,
} from "../src/integrations/gitlab";

test("lit le token glab pour un hôte donné", () => {
  const home = mkdtempSync(join(tmpdir(), "pupitre-glab-"));
  mkdirSync(join(home, ".config/glab-cli"), { recursive: true });
  writeFileSync(join(home, ".config/glab-cli/config.yml"), [
    "host: gitlab.com",
    "hosts:",
    "  gitlab.com:",
    "    token: glpat-other",
    "  git.kaizen-hosting.com:",
    "    token: glpat-kaizen",
    "    api_protocol: https",
    "",
  ].join("\n"));

  expect(readGlabToken("https://git.kaizen-hosting.com", home)).toBe("glpat-kaizen");
  expect(readGlabToken("https://absent.example", home)).toBeNull();
});

test("ignore un token caché dans un sous-bloc YAML imbriqué", () => {
  const home = mkdtempSync(join(tmpdir(), "pupitre-glab-nested-"));
  mkdirSync(join(home, ".config/glab-cli"), { recursive: true });
  writeFileSync(join(home, ".config/glab-cli/config.yml"), [
    "hosts:",
    "  gitlab.com:",
    "    aliases:",
    "      git.kaizen-hosting.com:",
    "        token: glpat-leak",
    "    token: glpat-other",
    "",
  ].join("\n"));

  expect(readGlabToken("https://git.kaizen-hosting.com", home)).toBeNull();
});

test("parse une MR de la liste", () => {
  const mr = parseMergeRequest({
    iid: 1862,
    title: "TECH-24657 / Replace content types",
    source_branch: "feature/TECH-24657",
    target_branch: "develop",
    state: "opened",
    web_url: "https://git/x/-/merge_requests/1862",
    updated_at: "2026-08-19T11:36:57.763+02:00",
    draft: false,
    has_conflicts: false,
    detailed_merge_status: "mergeable",
    labels: ["deploy:testing"],
    author: { username: "clement.serizay" },
    reviewers: [{ username: "louis.quellier" }],
    assignees: [],
  });

  expect(mr).toEqual({
    iid: 1862,
    title: "TECH-24657 / Replace content types",
    sourceBranch: "feature/TECH-24657",
    targetBranch: "develop",
    state: "opened",
    url: "https://git/x/-/merge_requests/1862",
    updatedAt: "2026-08-19T11:36:57.763+02:00",
    draft: false,
    hasConflicts: false,
    mergeStatus: "mergeable",
    labels: ["deploy:testing"],
    author: "clement.serizay",
    reviewers: ["louis.quellier"],
  });
});

test("résout l'iid de MR d'une ref de déploiement", () => {
  expect(mergeRequestIidOfRef("refs/merge-requests/1815/head")).toBe(1815);
  expect(mergeRequestIidOfRef("develop")).toBeNull();
});

test("parse un déploiement d'environnement", () => {
  expect(parseDeployment({
    ref: "refs/merge-requests/1815/head",
    sha: "a3bb6b78",
    status: "success",
    created_at: "2026-08-18T08:44:45.595+02:00",
    user: { username: "theo.micaletti" },
    deployable: { name: "deploy:preprod", status: "success", web_url: "https://git/j/1" },
  })).toEqual({
    ref: "refs/merge-requests/1815/head",
    mergeRequestIid: 1815,
    sha: "a3bb6b78",
    status: "success",
    createdAt: "2026-08-18T08:44:45.595+02:00",
    user: "theo.micaletti",
    job: "deploy:preprod",
    jobUrl: "https://git/j/1",
  });
});

test("le client envoie PRIVATE-TOKEN, résout un projet par chemin et lit MR, pipelines et environnements", async () => {
  const calls: string[] = [];
  const client = new GitLabClient({ host: "https://git.example", token: "glpat-x" }, async (input, init) => {
    const url = new URL(String(input));
    calls.push(url.toString());
    expect((init?.headers as Record<string, string>)["PRIVATE-TOKEN"]).toBe("glpat-x");
    if (url.pathname === "/api/v4/user" && url.search === "") return Response.json({ id: 123, username: "clement.serizay" });
    if (url.pathname === "/api/v4/projects/Affilae%2Fsymfony" && url.search === "") {
      return Response.json({ id: 187, path_with_namespace: "Affilae/symfony" });
    }
    if (url.pathname === "/api/v4/projects/187/merge_requests" && url.searchParams.get("state") === "opened"
      && url.searchParams.get("scope") === "all" && url.searchParams.get("per_page") === "50"
      && [...url.searchParams.keys()].sort().join(",") === "per_page,scope,state") {
      return Response.json([{
        iid: 1862,
        title: "TECH-24657 / Replace content types",
        source_branch: "feature/TECH-24657",
        target_branch: "develop",
        state: "opened",
        web_url: "https://git/x/-/merge_requests/1862",
        updated_at: "2026-08-19T11:36:57.763+02:00",
        draft: false,
        has_conflicts: false,
        detailed_merge_status: "mergeable",
        labels: ["deploy:testing"],
        author: { username: "clement.serizay" },
        reviewers: [{ username: "louis.quellier" }],
        assignees: [],
      }]);
    }
    if (url.pathname === "/api/v4/projects/187/merge_requests/1862/pipelines"
      && url.searchParams.get("per_page") === "1"
      && [...url.searchParams.keys()].join(",") === "per_page") {
      return Response.json([{ id: 119728, status: "manual", web_url: "https://git/p/119728", updated_at: "2026-08-19T10:00:00Z", ref: "feature/TECH-24657", sha: "abc" }]);
    }
    if (url.pathname === "/api/v4/projects/187/environments"
      && url.searchParams.get("search") === "preprod"
      && url.searchParams.get("states") === "available"
      && url.searchParams.get("per_page") === "50"
      && [...url.searchParams.keys()].sort().join(",") === "per_page,search,states") {
      return Response.json([
        { id: 283, name: "preprod", state: "available" },
        { id: 999, name: "preprod-old", state: "available" },
      ]);
    }
    if (url.pathname === "/api/v4/projects/187/environments/283" && url.search === "") {
      return Response.json({
        id: 283,
        name: "preprod",
        last_deployment: {
          ref: "refs/merge-requests/1815/head",
          sha: "a",
          status: "success",
          created_at: "2026-08-18T08:44:45Z",
          user: { username: "theo" },
          deployable: { name: "deploy:preprod", status: "success", web_url: "u" },
        },
      });
    }
    if (url.pathname === "/api/v4/projects/187/merge_requests/1815" && url.search === "") {
      return Response.json({
        iid: 1815,
        title: "t",
        source_branch: "feature/TECH-23903",
        target_branch: "develop",
        state: "merged",
        web_url: "w",
        updated_at: "x",
        draft: false,
        has_conflicts: false,
        detailed_merge_status: "not_open",
        labels: [],
        author: { username: "theo" },
        reviewers: [],
        assignees: [],
      });
    }
    return new Response("{}", { status: 404 });
  });

  expect(await client.me()).toEqual({ id: 123, username: "clement.serizay" });
  expect(await client.projectId("Affilae/symfony")).toBe(187);
  expect(await client.openMergeRequests(187)).toEqual([
    expect.objectContaining({ iid: 1862, sourceBranch: "feature/TECH-24657" }),
  ]);
  expect(await client.latestPipeline(187, 1862)).toEqual({
    id: 119728,
    status: "manual",
    url: "https://git/p/119728",
    updatedAt: "2026-08-19T10:00:00Z",
    ref: "feature/TECH-24657",
    sha: "abc",
  });
  expect(await client.environmentByName(187, "preprod")).toEqual({ id: 283, name: "preprod" });
  expect(await client.lastDeployment(187, 283)).toEqual({
    ref: "refs/merge-requests/1815/head",
    mergeRequestIid: 1815,
    sha: "a",
    status: "success",
    createdAt: "2026-08-18T08:44:45Z",
    user: "theo",
    job: "deploy:preprod",
    jobUrl: "u",
  });
  expect((await client.mergeRequest(187, 1815)).sourceBranch).toBe("feature/TECH-23903");
  expect(calls).toContain("https://git.example/api/v4/projects/187/merge_requests?state=opened&scope=all&per_page=50");
  expect(calls).toContain("https://git.example/api/v4/projects/187/merge_requests/1862/pipelines?per_page=1");
  expect(calls).toContain("https://git.example/api/v4/projects/187/merge_requests/1815");
  expect(calls).toContain("https://git.example/api/v4/projects/187/environments?search=preprod&states=available&per_page=50");
});

test("401 et 403 deviennent des GitLabAuthError", async () => {
  const unauthorized = new GitLabClient({ host: "https://git.example", token: "bad" }, async () => new Response("{}", { status: 401 }));
  const forbidden = new GitLabClient({ host: "https://git.example", token: "bad" }, async () => new Response("{}", { status: 403 }));

  await expect(unauthorized.me()).rejects.toBeInstanceOf(GitLabAuthError);
  await expect(forbidden.me()).rejects.toBeInstanceOf(GitLabAuthError);
});

test("un HTTP non-auth devient une GitLabHttpError", async () => {
  const client = new GitLabClient({ host: "https://git.example", token: "bad" }, async () => new Response("{}", { status: 500 }));
  await expect(client.me()).rejects.toBeInstanceOf(GitLabHttpError);
});
