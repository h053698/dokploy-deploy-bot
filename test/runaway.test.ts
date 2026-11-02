import { expect, test } from "bun:test";
import { loadConfig } from "../src/config.ts";
import { Deployer } from "../src/deployer.ts";
import { Dokploy } from "../src/dokploy.ts";
import { GitHub } from "../src/github.ts";

test("a deployment that never shows up times out after a bounded number of polls", async () => {
  const cfg = loadConfig({ TELEGRAM_BOT_TOKEN: "1:x", DOKPLOY_URL: "http://dk.test", DOKPLOY_API_KEY: "k", DEPLOY_TIMEOUT_MIN: "30", POLL_INTERVAL_MS: "5000" });
  let calls = 0;
  const dkFetch = async (input: string | URL | Request) => {
    calls++;
    return new URL(String(input)).pathname.includes("deployment.all") ? Response.json([]) : Response.json(true);
  };
  const deployer = new Deployer(cfg, new Dokploy(cfg.dokployUrl, cfg.dokployApiKey, dkFetch), new GitHub(cfg.githubApiUrl, null), {
    sleep: async () => {},
  });
  const service = { kind: "application", id: "a1", name: "n", appName: "n", repo: "o/r", status: "idle", projectId: "p", projectName: "p", environmentId: "e", environmentName: "production" } as const;
  const outcome = await deployer.runAndWait(service, "deploy", { step: () => {} });
  expect(outcome.status).toBe("timeout");
  expect(calls).toBeLessThanOrEqual(2 + Math.ceil((30 * 60_000) / 5000) + 1);
});
