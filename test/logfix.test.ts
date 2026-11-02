import { describe, expect, test } from "bun:test";
import { loadConfig } from "../src/config.ts";
import { Deployer } from "../src/deployer.ts";
import { Dokploy } from "../src/dokploy.ts";
import { GitHub } from "../src/github.ts";
import { classifyWithAi, composePorts, detectFault, errorLines, isErrorLine, parseNameMaps, parsePortMaps, pickFreeName, pickFreePort, renderPortPatch, rewriteContainerName, rewriteHostPort } from "../src/logfix.ts";

const REAL_LOG = [
  "#13 exporting to image",
  "Image graph-mail-viewer:latest Built",
  "Network hotmail_default Creating",
  "Container graph-mail-viewer Starting",
  "Error response from daemon: failed to set up container networking: driver failed programming external connectivity on endpoint graph-mail-viewer (54ba63ec): Bind for 0.0.0.0:3000 failed: port is already allocated",
  "Error: ❌ Docker command failed",
  "Error occurred ❌, check the logs for details.",
].join("\n");

describe("errorLines", () => {
  test("keeps only the lines Dokploy would color as errors", () => {
    const lines = errorLines(REAL_LOG);
    expect(lines).toHaveLength(3);
    expect(lines.every((l) => l.startsWith("Error"))).toBe(true);
  });
  test("ignores info, success and explicit non-error pairs", () => {
    expect(isErrorLine("Container x Starting")).toBe(false);
    expect(isErrorLine("failed: false")).toBe(false);
    expect(isErrorLine('{"level":"info","msg":"listening"}')).toBe(false);
    expect(isErrorLine('{"level":"error","msg":"boom"}')).toBe(true);
    expect(isErrorLine("level=error msg=boom")).toBe(true);
  });
  test("strips timestamps and ANSI colors and removes duplicates", () => {
    const esc = String.fromCharCode(27);
    const log = ["2026-11-02T05:59:09.000Z Error: boom", `${esc}[31mError: boom${esc}[0m`].join("\n");
    expect(errorLines(log)).toEqual(["Error: boom"]);
  });
});

describe("detectFault", () => {
  test("reads the taken host port from docker's message", () => {
    expect(detectFault(errorLines(REAL_LOG))).toEqual({ kind: "port_conflict", port: 3000 });
  });
  test("reads a taken container name from docker's conflict message", () => {
    const conflict = 'Error response from daemon: Conflict. The container name "/graph-mail-viewer" is already in use by container "435fc5e2c869". You have to remove (or rename) that container to be able to reuse that name.';
    expect(detectFault(errorLines(conflict))).toEqual({ kind: "name_conflict", name: "graph-mail-viewer" });
  });
  test("recognizes other wordings of the same problem", () => {
    expect(detectFault(["listen tcp 0.0.0.0:8080: bind: address already in use"])).toEqual({ kind: "port_conflict", port: 8080 });
    expect(detectFault(["Error: something else broke"])).toEqual({ kind: "unknown" });
  });
});

describe("compose port rewriting", () => {
  const compose = ["services:", "  web:", "    ports:", '      - "3000:3000"', "      - 127.0.0.1:8080:80", "    environment:", "      - PORT=3000", ""].join("\n");
  test("only the host side of a matching ports entry changes", () => {
    expect(composePorts(compose).map((p) => [p.host, p.container])).toEqual([
      [3000, 3000],
      [8080, 80],
    ]);
    const fixed = rewriteHostPort(compose, 3000, 3101) ?? "";
    expect(fixed).toContain('- "3101:3000"');
    expect(fixed).toContain("- PORT=3000");
    expect(fixed).toContain("127.0.0.1:8080:80");
  });
  test("returns null when the port is not written literally", () => {
    expect(rewriteHostPort(compose, 9999, 3101)).toBeNull();
    expect(rewriteHostPort('ports:\n  - "${PORT}:3000"\n', 3000, 3101)).toBeNull();
  });
  test("picks the next free port above the failed one", () => {
    expect(pickFreePort(3000, new Set([3100, 3101]))).toBe(3102);
  });
});

describe("port patch rendering", () => {
  const upstream = 'services:\n  web:\n    ports:\n      - "3000:3000"\n      - "9000:90"\n';
  test("records every mapping in a header so it can be re-applied to new upstream code", () => {
    const patch = renderPortPatch(upstream, new Map([[3000, 3100], [9000, 9100]])) ?? "";
    expect(patch.split("\n").slice(0, 2)).toEqual(["# deploy-bot port-map: 3000->3100", "# deploy-bot port-map: 9000->9100"]);
    expect(patch).toContain('"3100:3000"');
    expect(patch).toContain('"9100:90"');
    expect([...parsePortMaps(patch)]).toEqual([[3000, 3100], [9000, 9100]]);
  });
  test("a changed upstream file is re-rendered from its own text, not from the old patch", () => {
    const patch = renderPortPatch(upstream, new Map([[3000, 3100]])) ?? "";
    const newer = 'services:\n  web:\n    image: v2\n    ports:\n      - "3000:3000"\n';
    const fresh = renderPortPatch(newer, parsePortMaps(patch)) ?? "";
    expect(fresh).toContain("image: v2");
    expect(fresh).toContain('"3100:3000"');
  });
  test("returns null when no mapping applies any more", () => {
    expect(renderPortPatch('services:\n  web:\n    image: x\n', new Map([[3000, 3100]]))).toBeNull();
  });
});

describe("container name rewriting", () => {
  const compose = 'services:\n  web:\n    container_name: graph-mail-viewer\n  db:\n    container_name: "graph-mail-viewer-db"\n';
  test("only the exact container_name value changes, quotes are kept", () => {
    const out = rewriteContainerName(compose, "graph-mail-viewer", "graph-mail-viewer-x1") ?? "";
    expect(out).toContain("container_name: graph-mail-viewer-x1\n");
    expect(out).toContain('container_name: "graph-mail-viewer-db"');
    expect(rewriteContainerName(compose, "nope", "x")).toBeNull();
  });
  test("picks a name that is not taken, counting up when needed", () => {
    expect(pickFreeName("web", "ab", new Set(["web-ab"]))).toBe("web-ab2");
    expect(pickFreeName("web", "ab", new Set())).toBe("web-ab");
  });
  test("port and name maps live in one patch header and survive a re-render", () => {
    const upstream = 'services:\n  web:\n    container_name: web\n    ports:\n      - "3000:3000"\n';
    const patch = renderPortPatch(upstream, new Map([[3000, 3100]]), new Map([["web", "web-ab"]])) ?? "";
    expect([...parsePortMaps(patch)]).toEqual([[3000, 3100]]);
    expect([...parseNameMaps(patch)]).toEqual([["web", "web-ab"]]);
    const fresh = renderPortPatch(upstream.replace("web\n", "web\n    image: v2\n"), parsePortMaps(patch), parseNameMaps(patch)) ?? "";
    expect(fresh).toContain("container_name: web-ab");
    expect(fresh).toContain('"3100:3000"');
  });
});

describe("classifyWithAi", () => {
  const ai = { providers: [{ name: "p", baseUrl: "http://ai.test/v1", apiKey: "k", model: "m" }], maxAttempts: 1, timeoutMs: 1000 };
  const reply = (content: string) => async () => Response.json({ choices: [{ message: { content } }] });
  test("accepts a port_conflict verdict and rejects nonsense ports", async () => {
    const ok = await classifyWithAi(ai as never, ["x"], reply('{"cause":"port_conflict","hostPort":4000,"reason":"taken"}') as never);
    expect(ok?.fault).toEqual({ kind: "port_conflict", port: 4000 });
    const bad = await classifyWithAi(ai as never, ["x"], reply('{"cause":"port_conflict","hostPort":99999,"reason":"?"}') as never);
    expect(bad?.fault).toEqual({ kind: "unknown" });
  });
  test("only the error lines are sent to the model", async () => {
    let sent = "";
    await classifyWithAi(ai as never, ["Error: only this"], (async (_url: string, init?: { body?: string }) => {
      sent = String(init?.body);
      return Response.json({ choices: [{ message: { content: '{"cause":"other","hostPort":null,"reason":""}' } }] });
    }) as never);
    expect(sent).toContain("Error: only this");
    expect(sent).not.toContain("exporting to image");
  });
});

describe("compose port repair in a deployment", () => {
  const service = { kind: "compose", id: "c1", name: "hello", appName: "hello-x", repo: "acme/hello", status: "idle", projectId: "p", projectName: "p", environmentId: "e", environmentName: "production" } as const;
  const upstreamV1 = 'services:\n  web:\n    image: x\n    ports:\n      - "3000:3000"\n';
  const upstreamV2 = 'services:\n  web:\n    image: v2\n    ports:\n      - "3000:3000"\n';

  function harness(opts: { upstream: () => string; patches: () => { patchId: string; filePath: string; content: string }[]; failFirst: boolean }) {
    const calls: { path: string; body: Record<string, unknown> }[] = [];
    let deploys = 0;
    const dkFetch = async (input: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(input)).pathname.replace(/^\/api\//, "");
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
      calls.push({ path, body });
      if (path === "compose.deploy" || path === "compose.redeploy") deploys++;
      if (path === "deployment.allByCompose") {
        const failed = opts.failFirst && deploys === 1;
        return Response.json(deploys === 0 ? [] : [{ deploymentId: `d${deploys}`, status: failed ? "error" : "done", title: "t", createdAt: "", errorMessage: null }]);
      }
      if (path === "deployment.readLogs") return Response.json(REAL_LOG);
      if (path === "docker.getContainers") return Response.json([{ ports: "0.0.0.0:3101->80/tcp, [::]:3101->80/tcp" }]);
      if (path === "compose.one") return Response.json({ owner: "acme", repository: "hello", composePath: "./docker-compose.yml", branch: "main", customGitBranch: null });
      if (path === "patch.byEntityId") return Response.json(opts.patches());
      if (path === "patch.create") return Response.json({ patchId: "pt1" });
      return Response.json(true);
    };
    const cfg = loadConfig({ TELEGRAM_BOT_TOKEN: "1:x", DOKPLOY_URL: "http://dokploy.test", DOKPLOY_API_KEY: "k", BASE_DOMAIN: "example.test", POLL_INTERVAL_MS: "10" });
    const github = (async (input: string | URL | Request) => {
      if (new URL(String(input)).pathname.endsWith("/contents/docker-compose.yml")) return new Response(opts.upstream());
      return new Response("not found", { status: 404 });
    }) as never;
    const deployer = new Deployer(cfg, new Dokploy(cfg.dokployUrl, cfg.dokployApiKey, dkFetch as never), new GitHub(cfg.githubApiUrl, null, github), { sleep: async () => {}, now: () => 0 });
    const steps: string[] = [];
    return { deployer, calls, steps, reporter: { step: (s: string) => void steps.push(s) }, deploys: () => deploys };
  }

  test("an update that hits a port clash fixes it with a patch and redeploys", async () => {
    const h = harness({ upstream: () => upstreamV1, patches: () => [], failFirst: true });
    const result = await h.deployer.rerun(service, "deploy", h.reporter);
    expect(result.status).toBe("done");
    const patch = h.calls.find((c) => c.path === "patch.create")?.body;
    expect(patch).toMatchObject({ composeId: "c1", filePath: "docker-compose.yml", type: "update" });
    expect(String(patch?.content)).toContain('"3100:3000"');
    expect(String(patch?.content).startsWith("# deploy-bot port-map: 3000->3100")).toBe(true);
    expect(h.steps.join("\n")).toContain("3000 충돌 → 3100");
    expect(h.deploys()).toBe(2);
  });

  test("an old port patch is re-rendered from the new upstream file before an update, so it cannot overwrite new code", async () => {
    const stale = { patchId: "old", filePath: "docker-compose.yml", content: `# deploy-bot port-map: 3000->3100\n${upstreamV1.replace('"3000:3000"', '"3100:3000"')}` };
    const h = harness({ upstream: () => upstreamV2, patches: () => [stale], failFirst: false });
    const result = await h.deployer.rerun(service, "deploy", h.reporter);
    expect(result.status).toBe("done");
    const update = h.calls.find((c) => c.path === "patch.update")?.body;
    expect(update?.patchId).toBe("old");
    expect(String(update?.content)).toContain("image: v2");
    expect(String(update?.content)).toContain('"3100:3000"');
    const order = h.calls.map((c) => c.path);
    expect(order.indexOf("patch.update")).toBeLessThan(order.indexOf("compose.deploy"));
  });

  test("a container-name clash renames only that container_name through a patch and redeploys", async () => {
    const nameLog = 'Error response from daemon: Conflict. The container name "/graph-mail-viewer" is already in use by container "435fc5e2c869".\nError: ❌ Docker command failed';
    const upstream = 'services:\n  web:\n    image: x\n    container_name: graph-mail-viewer\n    ports:\n      - "3000:3000"\n';
    const calls: { path: string; body: Record<string, unknown> }[] = [];
    let deploys = 0;
    const dkFetch = async (input: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(input)).pathname.replace(/^\/api\//, "");
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
      calls.push({ path, body });
      if (path === "compose.deploy") deploys++;
      if (path === "deployment.allByCompose") return Response.json(deploys === 0 ? [] : [{ deploymentId: `d${deploys}`, status: deploys === 1 ? "error" : "done", title: "t", createdAt: "", errorMessage: null }]);
      if (path === "deployment.readLogs") return Response.json(nameLog);
      if (path === "compose.one") return Response.json({ owner: "acme", repository: "hello", composePath: "./docker-compose.yml", branch: "main", customGitBranch: null });
      if (path === "patch.byEntityId") return Response.json([]);
      if (path === "docker.getContainers") return Response.json([{ name: "/graph-mail-viewer", ports: "" }]);
      return Response.json(true);
    };
    const cfg = loadConfig({ TELEGRAM_BOT_TOKEN: "1:x", DOKPLOY_URL: "http://dokploy.test", DOKPLOY_API_KEY: "k", BASE_DOMAIN: "example.test", POLL_INTERVAL_MS: "10" });
    const github = (async () => new Response(upstream)) as never;
    const deployer = new Deployer(cfg, new Dokploy(cfg.dokployUrl, cfg.dokployApiKey, dkFetch as never), new GitHub(cfg.githubApiUrl, null, github), { sleep: async () => {}, now: () => 0 });
    const steps: string[] = [];
    const result = await deployer.rerun({ ...service, appName: "hello-ab12cd" }, "deploy", { step: (s: string) => void steps.push(s) });
    expect(result.status).toBe("done");
    const patch = calls.find((c) => c.path === "patch.create")?.body;
    expect(patch).toMatchObject({ composeId: "c1", filePath: "docker-compose.yml", type: "update" });
    const content = String(patch?.content);
    expect(content.startsWith("# deploy-bot name-map: graph-mail-viewer->graph-mail-viewer-ab12cd")).toBe(true);
    expect(content).toContain("container_name: graph-mail-viewer-ab12cd");
    expect(content).toContain('"3000:3000"');
    expect(calls.map((c) => c.path)).not.toContain("compose.update");
    expect(steps.join("\n")).toContain("graph-mail-viewer-ab12cd");
    expect(deploys).toBe(2);
  });

  test("a port patch that no longer applies is removed instead of being left to break the build", async () => {
    const stale = { patchId: "old", filePath: "docker-compose.yml", content: "# deploy-bot port-map: 3000->3100\nservices: {}\n" };
    const h = harness({ upstream: () => "services:\n  web:\n    image: x\n", patches: () => [stale], failFirst: false });
    await h.deployer.rerun(service, "deploy", h.reporter);
    expect(h.calls.find((c) => c.path === "patch.delete")?.body).toEqual({ patchId: "old" });
  });

  test("a redeploy does not touch patches (it rebuilds the code that is already cloned)", async () => {
    const h = harness({ upstream: () => upstreamV2, patches: () => [], failFirst: false });
    await h.deployer.rerun(service, "redeploy", h.reporter);
    expect(h.calls.map((c) => c.path)).not.toContain("patch.update");
    expect(h.calls.map((c) => c.path)).toContain("compose.redeploy");
  });
});
