import { describe, expect, test } from "bun:test";
import {
  analyzeRepo,
  exposedPort,
  findComposeFile,
  normalizeDomain,
  parseComposeServices,
  pickWebService,
  subdomainFor,
} from "../src/analyze.ts";
import { extractDockerfile } from "../src/ai.ts";
import { repoFromDescription } from "../src/deployer.ts";
import { parseRepoUrl } from "../src/github.ts";

const reader = (files: Record<string, string>) => async (path: string) => files[path] ?? null;

describe("parseRepoUrl", () => {
  test.each([
    ["https://github.com/acme/dokploy-deploy-bot", "acme", "dokploy-deploy-bot"],
    ["https://github.com/acme/dokploy-deploy-bot.git", "acme", "dokploy-deploy-bot"],
    ["github.com/o/r/tree/main/src", "o", "r"],
    ["git@github.com:o/my.repo.git", "o", "my.repo"],
    ["o/r", "o", "r"],
  ])("%s", (input, owner, repo) => {
    expect(parseRepoUrl(input)).toEqual({ owner, repo });
  });

  test("rejects non-GitHub input", () => {
    expect(parseRepoUrl("https://gitlab.com/o/r")).toBeNull();
    expect(parseRepoUrl("just-a-name")).toBeNull();
  });
});

describe("analyzeRepo", () => {
  test("compose wins over Dockerfile and picks the web service port", async () => {
    const compose = `services:
  db:
    image: postgres:17
  web:
    build: .
    ports:
      - "8080:3000"
`;
    const plan = await analyzeRepo(["Dockerfile", "docker-compose.yml"], reader({ "docker-compose.yml": compose }));
    expect(plan).toMatchObject({ kind: "compose", composePath: "./docker-compose.yml", serviceName: "web", port: 3000 });
  });

  test("compose with only an image service still targets it", async () => {
    const plan = await analyzeRepo(["compose.yaml"], reader({ "compose.yaml": "services:\n  whoami:\n    image: traefik/whoami\n" }));
    expect(plan).toMatchObject({ kind: "compose", serviceName: "whoami", port: 3000 });
  });

  test("warns when compose binds host port 80", async () => {
    const yaml = "services:\n  proxy:\n    image: nginx\n    ports: ['80:80']\n";
    const plan = await analyzeRepo(["docker-compose.yml"], reader({ "docker-compose.yml": yaml }));
    expect(plan.warnings).toHaveLength(1);
  });

  test("Dockerfile uses its EXPOSE port", async () => {
    const plan = await analyzeRepo(["Dockerfile", "main.go"], reader({ Dockerfile: "FROM golang\nEXPOSE 8080\n" }));
    expect(plan).toMatchObject({ kind: "application", buildType: "dockerfile", dockerfile: "Dockerfile", port: 8080, setPortEnv: false });
  });

  test("nested Dockerfile is found", async () => {
    const plan = await analyzeRepo(["docker/Dockerfile", "a/b/c/Dockerfile"], reader({ "docker/Dockerfile": "FROM x" }));
    expect(plan).toMatchObject({ buildType: "dockerfile", dockerfile: "docker/Dockerfile", port: 3000, setPortEnv: true });
  });

  test("no Docker config falls back to railpack with a language port guess", async () => {
    expect(await analyzeRepo(["package.json", "index.js"], reader({}))).toMatchObject({ buildType: "railpack", port: 3000 });
    expect(await analyzeRepo(["requirements.txt", "app.py"], reader({}))).toMatchObject({ buildType: "railpack", port: 8000 });
  });
});

describe("compose parsing", () => {
  test("long and short port syntax", () => {
    const services = parseComposeServices(`services:
  api:
    ports:
      - target: 4000
        published: 4001
  ui:
    expose: ["5173"]
`);
    expect(services).toEqual([
      { name: "api", ports: [{ container: 4000, host: 4001 }], expose: [] },
      { name: "ui", ports: [], expose: [5173] },
    ]);
    expect(pickWebService(services)?.service.name).toBe("api");
  });

  test("root compose preferred over nested", () => {
    expect(findComposeFile(["deploy/docker-compose.yml", "compose.yml"])).toBe("compose.yml");
    expect(findComposeFile(["deploy/docker-compose.yml"])).toBe("deploy/docker-compose.yml");
  });

  test("exposedPort", () => {
    expect(exposedPort("FROM a\n  expose 9000/tcp\n")).toBe(9000);
    expect(exposedPort("FROM a\n")).toBeNull();
  });
});

describe("domains", () => {
  test("subdomain from repo name", () => {
    expect(subdomainFor("Dokploy_Deploy.Bot")).toBe("dokploy-deploy-bot");
    expect(subdomainFor("___")).toBe("app");
  });

  test("normalizeDomain", () => {
    expect(normalizeDomain("myapp", "example.test")).toBe("myapp.example.test");
    expect(normalizeDomain("https://App.Example.com/path", "example.test")).toBe("app.example.com");
    expect(normalizeDomain("bad domain", "example.test")).toBeNull();
    expect(normalizeDomain("-x.example.test", "example.test")).toBeNull();
  });
});

describe("misc", () => {
  test("extractDockerfile", () => {
    expect(extractDockerfile("Here:\n```dockerfile\nFROM node:22\nCMD [\"node\"]\n```")).toBe('FROM node:22\nCMD ["node"]\n');
    expect(extractDockerfile("```\n# comment\nARG V=1\nFROM python:3.13\n```")).toContain("FROM python");
    expect(extractDockerfile("sorry, I can't")).toBeNull();
  });

  test("repoFromDescription", () => {
    expect(repoFromDescription("deploy-bot repo:o/r")).toBe("o/r");
    expect(repoFromDescription("manual app")).toBeNull();
    expect(repoFromDescription(null)).toBeNull();
  });
});
