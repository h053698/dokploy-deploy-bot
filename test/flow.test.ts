import { beforeEach, describe, expect, test } from "bun:test";
import { Bot } from "grammy";
import type { Update, UserFromGetMe } from "grammy/types";
import { createBot } from "../src/bot.ts";
import { loadConfig } from "../src/config.ts";
import { Deployer } from "../src/deployer.ts";
import { Dokploy } from "../src/dokploy.ts";
import { GitHub } from "../src/github.ts";

const OWNER_ID = 111;
const STRANGER_ID = 999;
const CHAT_ID = 5000;
const GROUP_ID = -100777;
const OTHER_GROUP_ID = -100888;

interface Call {
  path: string;
  body: Record<string, unknown>;
}

interface FakeApp {
  applicationId: string;
  name: string;
  appName: string;
  description: string;
  buildType: string;
  dockerfile: string;
  patches: string[];
}

class FakeDokploy {
  calls: Call[] = [];
  projects: { projectId: string; name: string; environmentId: string }[] = [];
  apps: FakeApp[] = [];
  deployments: { deploymentId: string; applicationId: string; status: string }[] = [];
  id = 0;

  fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const path = url.pathname.replace(/^\/api\//, "");
    if (new Headers(init?.headers).get("x-api-key") !== "dk-key") return new Response("unauthorized", { status: 401 });
    const body = (init?.body ? JSON.parse(String(init.body)) : Object.fromEntries(url.searchParams)) as Record<string, unknown>;
    this.calls.push({ path, body });
    return Response.json(this.handle(path, body));
  };

  private handle(path: string, body: Record<string, unknown>): unknown {
    const app = () => {
      const found = this.apps.find((a) => a.applicationId === body.applicationId);
      if (!found) throw new Error(`unknown app ${String(body.applicationId)}`);
      return found;
    };
    switch (path) {
      case "project.all":
        return this.projects.map((p) => ({
          projectId: p.projectId,
          name: p.name,
          environments: [
            {
              environmentId: p.environmentId,
              name: "production",
              isDefault: true,
              compose: [],
              applications: this.apps.map((a) => ({ applicationId: a.applicationId, name: a.name, applicationStatus: "done" })),
            },
          ],
        }));
      case "project.one": {
        const p = this.projects.find((x) => x.projectId === body.projectId);
        if (!p) throw new Error(`unknown project ${String(body.projectId)}`);
        return {
          projectId: p.projectId,
          name: p.name,
          environments: [
            {
              environmentId: p.environmentId,
              name: "production",
              isDefault: true,
              compose: [],
              applications: this.apps.map((a) => ({
                applicationId: a.applicationId,
                name: a.name,
                appName: a.appName,
                description: a.description,
                applicationStatus: "done",
              })),
            },
          ],
        };
      }
      case "project.create": {
        const project = { projectId: `p${++this.id}`, name: String(body.name), environmentId: `e${++this.id}` };
        this.projects.push(project);
        return { project, environment: { environmentId: project.environmentId } };
      }
      case "github.githubProviders":
        return [];
      case "application.create": {
        const created: FakeApp = {
          applicationId: `a${++this.id}`,
          name: String(body.name),
          appName: `${String(body.appName)}-x1y2z3`,
          description: String(body.description),
          buildType: "nixpacks",
          dockerfile: "",
          patches: [],
        };
        this.apps.push(created);
        return created;
      }
      case "application.saveBuildType":
        app().buildType = String(body.buildType);
        app().dockerfile = String(body.dockerfile);
        return true;
      case "patch.create":
        app().patches.push(String(body.filePath));
        return { patchId: `patch${++this.id}`, filePath: body.filePath, type: body.type, enabled: true };
      case "application.deploy":
      case "application.redeploy": {
        const a = app();
        const ok = a.buildType === "dockerfile" && (a.dockerfile === "Dockerfile" || a.patches.includes(a.dockerfile));
        this.deployments.unshift({ deploymentId: `d${++this.id}`, applicationId: a.applicationId, status: ok ? "done" : "error" });
        return true;
      }
      case "deployment.all":
        return this.deployments
          .filter((d) => d.applicationId === body.applicationId)
          .map((d) => ({ ...d, title: "t", createdAt: "", errorMessage: null }));
      case "deployment.readLogs":
        return "railpack: could not determine how to build the app";
      case "domain.byApplicationId":
        return [{ domainId: "dom1", host: "hello.arpa.page", https: true, port: 3000 }];
      default:
        return true;
    }
  }

  paths() {
    return this.calls.map((c) => c.path);
  }
}

const REPO = {
  name: "hello",
  owner: { login: "h053698" },
  default_branch: "main",
  private: false,
  clone_url: "https://github.com/h053698/hello.git",
  html_url: "https://github.com/h053698/hello",
};

const fakeGithub = async (input: string | URL | Request): Promise<Response> => {
  const url = new URL(String(input));
  if (url.pathname === "/repos/h053698/hello") return Response.json(REPO);
  if (url.pathname === "/repos/h053698/hello/git/trees/main") {
    return Response.json({ tree: [{ path: "package.json", type: "blob" }, { path: "index.js", type: "blob" }] });
  }
  if (url.pathname === "/repos/h053698/hello/contents/package.json") return new Response('{"name":"hello"}');
  return new Response("not found", { status: 404 });
};

const aiPrompts: string[] = [];
const fakeAi = async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
  aiPrompts.push(String(init?.body));
  return Response.json({ choices: [{ message: { content: "```dockerfile\nFROM node:22-alpine\nEXPOSE 3000\nCMD [\"node\",\"index.js\"]\n```" } }] });
};

interface Sent {
  method: string;
  payload: Record<string, unknown>;
}

function setup() {
  const cfg = loadConfig({
    TELEGRAM_BOT_TOKEN: "123:abc",
    ALLOWED_USER_IDS: String(OWNER_ID),
    ALLOWED_CHAT_IDS: String(GROUP_ID),
    DOKPLOY_URL: "http://dokploy.test",
    DOKPLOY_API_KEY: "dk-key",
    AI_API_KEY: "ai-key",
    AI_BASE_URL: "http://ai.test/v1",
    AI_MODEL: "test-model",
    AI_MAX_ATTEMPTS: "1",
  });
  const dk = new FakeDokploy();
  const deployer = new Deployer(cfg, new Dokploy(cfg.dokployUrl, cfg.dokployApiKey, dk.fetch), new GitHub(cfg.githubApiUrl, null, fakeGithub), {
    sleep: async () => {},
    resolveHost: async () => false,
    aiFetch: fakeAi,
  });
  const botInfo = { id: 1, is_bot: true, first_name: "deploy", username: "deploy_bot" } as UserFromGetMe;
  const bot = new Bot(cfg.telegramToken, { botInfo });
  const sent: Sent[] = [];
  let messageId = 100;
  bot.api.config.use(async (_prev, method, payload) => {
    sent.push({ method, payload: payload as Record<string, unknown> });
    const result =
      method === "sendMessage"
        ? { message_id: ++messageId, date: 0, chat: { id: CHAT_ID, type: "private" }, text: (payload as { text: string }).text }
        : true;
    return { ok: true, result } as never;
  });
  const { idle } = createBot({ cfg, deployer, gh: new GitHub(cfg.githubApiUrl, null, fakeGithub) }, bot);
  return { bot, dk, sent, idle };
}

let updateId = 0;
const from = (id: number) => ({ id, is_bot: false, first_name: "u" });
const chat = { id: CHAT_ID, type: "private" as const, first_name: "u" };

type AnyChat = typeof chat | { id: number; type: "supergroup"; title: string };
const group = (id: number): AnyChat => ({ id, type: "supergroup", title: "team" });

function command(text: string, userId = OWNER_ID, inChat: AnyChat = chat): Update {
  const name = text.split(" ")[0] ?? text;
  return {
    update_id: ++updateId,
    message: { message_id: ++updateId, date: 0, chat: inChat, from: from(userId), text, entities: [{ type: "bot_command", offset: 0, length: name.length }] },
  } as Update;
}

function click(data: string, userId = OWNER_ID): Update {
  return {
    update_id: ++updateId,
    callback_query: {
      id: String(++updateId),
      from: from(userId),
      chat_instance: "ci",
      data,
      message: { message_id: 101, date: 0, chat, text: "x" },
    },
  };
}

const texts = (sent: Sent[]) => sent.filter((s) => s.method === "sendMessage" || s.method === "editMessageText").map((s) => String(s.payload.text));
const buttons = (s: Sent | undefined) =>
  ((s?.payload.reply_markup as { inline_keyboard?: { text: string; callback_data: string }[][] })?.inline_keyboard ?? []).flat();

describe("telegram flow", () => {
  beforeEach(() => {
    aiPrompts.length = 0;
  });

  test("/deploy asks domain, shows plan, deploys with railpack, falls back to AI Dockerfile", async () => {
    const { bot, dk, sent, idle } = setup();
    await bot.handleUpdate(command("/deploy https://github.com/h053698/hello"));

    const domainPrompt = sent.find((s) => s.method === "editMessageText");
    expect(String(domainPrompt?.payload.text)).toContain("도메인은 어떻게 할까?");
    const choices = buttons(domainPrompt);
    expect(choices.map((b) => b.text)).toEqual(["✅ hello.arpa.page", "✏️ 직접 입력", "🚫 도메인 없이", "취소"]);
    expect(dk.paths()).not.toContain("application.create");

    await bot.handleUpdate(click(choices[0]?.callback_data ?? ""));
    await idle();

    const all = texts(sent);
    const summary = all.find((t) => t.startsWith("🚀"));
    expect(summary).toContain("Railpack v0.15.4");
    expect(summary).toContain("https://hello.arpa.page");
    expect(summary).toContain("DNS가 아직 안 잡혀");

    const mutations = dk.paths().filter((p) => !["project.all", "project.one", "deployment.all", "github.githubProviders", "deployment.readLogs"].includes(p));
    expect(mutations).toEqual([
      "project.create",
      "application.create",
      "application.saveGitProvider",
      "application.saveBuildType",
      "application.saveEnvironment",
      "domain.create",
      "application.deploy",
      "patch.create",
      "application.saveBuildType",
      "application.deploy",
    ]);
    const call = (p: string) => dk.calls.find((c) => c.path === p)?.body;
    expect(call("application.saveGitProvider")).toMatchObject({ customGitUrl: "https://github.com/h053698/hello.git", customGitBranch: "main" });
    expect(call("domain.create")).toMatchObject({ host: "hello.arpa.page", port: 3000, https: true, certificateType: "letsencrypt" });
    expect(call("patch.create")).toMatchObject({ filePath: "Dockerfile.deploy-bot", type: "create" });
    expect(String(call("patch.create")?.content)).toContain("FROM node:22-alpine");
    expect(aiPrompts[0]).toContain("could not determine how to build");

    const final = all.at(-1);
    expect(final).toContain("✅ 배포 완료");
    expect(final).toContain("https://hello.arpa.page");
    expect(final).toContain("AI가 만든 Dockerfile");
  });

  test("custom domain text input is normalized", async () => {
    const { bot, dk, sent, idle } = setup();
    await bot.handleUpdate(command("/deploy h053698/hello"));
    const custom = buttons(sent.find((s) => s.method === "editMessageText"))[1];
    await bot.handleUpdate(click(custom?.callback_data ?? ""));
    await bot.handleUpdate({ update_id: ++updateId, message: { message_id: ++updateId, date: 0, chat, from: from(OWNER_ID), text: "my-api" } });
    await idle();
    expect(dk.calls.find((c) => c.path === "domain.create")?.body).toMatchObject({ host: "my-api.arpa.page" });
  });

  test("/update with partial name shows a picker, click runs deploy (pull latest)", async () => {
    const { bot, dk, sent, idle } = setup();
    dk.projects.push({ projectId: "p0", name: "deploy-bot", environmentId: "e0" });
    for (const name of ["hello", "hello-api"]) {
      dk.apps.push({ applicationId: `id-${name}`, name, appName: name, description: `deploy-bot repo:h053698/${name}`, buildType: "dockerfile", dockerfile: "Dockerfile", patches: [] });
    }

    await bot.handleUpdate(command("/update hel"));
    const picker = sent.at(-1);
    expect(picker?.payload.text).toBe("어떤 서비스?");
    expect(buttons(picker).map((b) => b.text)).toEqual(["h053698/hello", "h053698/hello-api"]);

    await bot.handleUpdate(click(buttons(picker)[1]?.callback_data ?? ""));
    await idle();
    expect(dk.calls.filter((c) => c.path === "application.deploy").map((c) => c.body.applicationId)).toEqual(["id-hello-api"]);
    expect(texts(sent).at(-1)).toContain("✅ 배포 완료: h053698/hello-api");
  });

  test("/redeploy with exact name rebuilds without a picker", async () => {
    const { bot, dk, idle } = setup();
    dk.projects.push({ projectId: "p0", name: "deploy-bot", environmentId: "e0" });
    for (const name of ["hello", "hello-api"]) {
      dk.apps.push({ applicationId: `id-${name}`, name, appName: name, description: `deploy-bot repo:h053698/${name}`, buildType: "dockerfile", dockerfile: "Dockerfile", patches: [] });
    }
    await bot.handleUpdate(command("/redeploy hello"));
    await idle();
    expect(dk.calls.filter((c) => c.path === "application.redeploy").map((c) => c.body.applicationId)).toEqual(["id-hello"]);
    expect(dk.paths()).not.toContain("application.deploy");
  });

  test("/deploy of an already managed repo offers update/redeploy instead of creating", async () => {
    const { bot, dk, sent } = setup();
    dk.projects.push({ projectId: "p0", name: "deploy-bot", environmentId: "e0" });
    dk.apps.push({ applicationId: "id-hello", name: "hello", appName: "hello", description: "deploy-bot repo:h053698/hello", buildType: "dockerfile", dockerfile: "Dockerfile", patches: [] });
    await bot.handleUpdate(command("/deploy https://github.com/h053698/hello"));
    expect(buttons(sent.at(-1)).map((b) => b.callback_data)).toEqual(["run:u:a:id-hello", "run:r:a:id-hello"]);
    expect(dk.paths()).not.toContain("application.create");
  });

  test("any member of an allowed group can use the bot there", async () => {
    const { bot, dk, sent } = setup();
    await bot.handleUpdate(command("/deploy@deploy_bot https://github.com/h053698/hello", STRANGER_ID, group(GROUP_ID)));
    expect(String(sent.find((s) => s.method === "editMessageText")?.payload.text)).toContain("도메인은 어떻게 할까?");
    expect(dk.paths()).toContain("project.all");
  });

  test("other groups are rejected even for allowed users, and the reply shows the group id", async () => {
    const { bot, dk, sent } = setup();
    await bot.handleUpdate(command("/deploy https://github.com/h053698/hello", OWNER_ID, group(OTHER_GROUP_ID)));
    expect(String(sent[0]?.payload.text)).toContain(String(OTHER_GROUP_ID));
    expect(dk.calls).toEqual([]);
  });

  test("plain group chatter from a non-allowed group gets no reply", async () => {
    const { bot, sent } = setup();
    await bot.handleUpdate({ update_id: ++updateId, message: { message_id: ++updateId, date: 0, chat: group(OTHER_GROUP_ID), from: from(OWNER_ID), text: "hello" } } as Update);
    expect(sent).toEqual([]);
  });

  test("unauthorized users are rejected and nothing reaches Dokploy", async () => {
    const { bot, dk, sent } = setup();
    await bot.handleUpdate(command("/deploy https://github.com/h053698/hello", STRANGER_ID));
    await bot.handleUpdate(click("run:u:a:id-hello", STRANGER_ID));
    expect(String(sent[0]?.payload.text)).toContain(String(STRANGER_ID));
    expect(sent[1]).toMatchObject({ method: "answerCallbackQuery", payload: { text: "권한 없음" } });
    expect(dk.calls).toEqual([]);
  });
});
