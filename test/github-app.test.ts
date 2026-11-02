import { describe, expect, test } from "bun:test";
import { createVerify, generateKeyPairSync } from "node:crypto";
import { Dokploy } from "../src/dokploy.ts";
import { GitHub } from "../src/github.ts";
import { createAppJwt, GitHubAppTokens } from "../src/github-app.ts";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PEM = privateKey.export({ type: "pkcs1", format: "pem" }).toString();
const NOW = Date.parse("2026-11-02T00:00:00Z");

describe("GitHub App fallback for private repos", () => {
  test("app JWT is RS256-signed with the app id as issuer", () => {
    const jwt = createAppJwt(4406416, PEM, NOW);
    const [header, payload, signature] = jwt.split(".");
    const verified = createVerify("RSA-SHA256").update(`${header}.${payload}`).verify(publicKey, Buffer.from(signature ?? "", "base64url"));
    expect(verified).toBe(true);
    expect(JSON.parse(Buffer.from(payload ?? "", "base64url").toString())).toEqual({ iat: NOW / 1000 - 60, exp: NOW / 1000 + 540, iss: "4406416" });
  });

  test("404 without a token retries with the installation token; public repos never mint one", async () => {
    const dkCalls: string[] = [];
    const dkFetch = async (input: string | URL | Request) => {
      const path = new URL(String(input)).pathname.replace("/api/", "");
      dkCalls.push(path);
      if (path === "github.githubProviders") return Response.json([{ githubId: "gh1" }]);
      if (path === "github.getGithubRepositories") return Response.json([{ name: "website", owner: { login: "acme-org" } }]);
      if (path === "github.one") return Response.json({ githubAppId: 4406416, githubInstallationId: "149364421", githubPrivateKey: PEM });
      return new Response("nope", { status: 500 });
    };
    const ghCalls: string[] = [];
    let minted = 0;
    const ghFetch = async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      const auth = new Headers(init?.headers).get("authorization");
      ghCalls.push(`${init?.method ?? "GET"} ${url.pathname} ${auth?.startsWith("Bearer ey") ? "jwt" : auth ?? "anon"}`);
      if (url.pathname === "/app/installations/149364421/access_tokens") {
        minted++;
        return Response.json({ token: "ghs_install", expires_at: new Date(NOW + 3600_000).toISOString() });
      }
      if (url.pathname.startsWith("/repos/render-examples/express-hello-world")) {
        return Response.json({ name: "express-hello-world", owner: { login: "render-examples" }, default_branch: "main", private: false, clone_url: "c", html_url: "h" });
      }
      if (auth !== "Bearer ghs_install") return new Response("Not Found", { status: 404 });
      if (url.pathname === "/repos/acme-org/website") {
        return Response.json({ name: "website", owner: { login: "acme-org" }, default_branch: "main", private: true, clone_url: "c", html_url: "h" });
      }
      if (url.pathname === "/repos/acme-org/website/git/trees/main") return Response.json({ tree: [{ path: "package.json", type: "blob" }] });
      return new Response("Not Found", { status: 404 });
    };

    const apps = new GitHubAppTokens(new Dokploy("http://dk", "k", dkFetch), "https://api.github.test", ghFetch, () => NOW);
    const gh = new GitHub("https://api.github.test", null, ghFetch, (ref) => apps.tokenFor(ref));

    const pub = await gh.repo({ owner: "render-examples", repo: "express-hello-world" });
    expect(pub.private).toBe(false);
    expect(minted).toBe(0);

    const info = await gh.repo({ owner: "acme-org", repo: "website" });
    expect(info.private).toBe(true);
    expect(await gh.treeBlobs(info, "main")).toEqual(["package.json"]);
    expect(minted).toBe(1);
    expect(ghCalls.filter((c) => c.includes("acme-org"))).toEqual([
      "GET /repos/acme-org/website anon",
      "GET /repos/acme-org/website Bearer ghs_install",
      "GET /repos/acme-org/website/git/trees/main Bearer ghs_install",
    ]);
    expect(ghCalls).toContain("POST /app/installations/149364421/access_tokens jwt");

    const gh2 = new GitHub("https://api.github.test", null, ghFetch, (ref) => apps.tokenFor(ref));
    await gh2.repo({ owner: "acme-org", repo: "website" });
    expect(minted).toBe(1);
  });

  test("repo outside every app installation still reports a clear not-found", async () => {
    const dkFetch = async (input: string | URL | Request) => {
      const path = new URL(String(input)).pathname.replace("/api/", "");
      if (path === "github.githubProviders") return Response.json([{ githubId: "gh1" }]);
      if (path === "github.getGithubRepositories") return Response.json([{ name: "website", owner: { login: "acme-org" } }]);
      return new Response("nope", { status: 500 });
    };
    const ghFetch = async () => new Response("Not Found", { status: 404 });
    const apps = new GitHubAppTokens(new Dokploy("http://dk", "k", dkFetch), "https://api.github.test", ghFetch, () => NOW);
    const gh = new GitHub("https://api.github.test", null, ghFetch, (ref) => apps.tokenFor(ref));
    const error = await gh.repo({ owner: "someone", repo: "secret" }).catch((e: Error) => e);
    expect((error as Error).message).toContain("Dokploy GitHub App 설치 범위");
  });
});
