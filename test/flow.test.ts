import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { Bot } from "grammy";
import type { Update, UserFromGetMe } from "grammy/types";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Access } from "../src/access.ts";
import type { BuildPlan } from "../src/analyze.ts";
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
const ADMIN_ID = 222;
const tempDirs: string[] = [];
afterAll(async () => {
  await Promise.all(tempDirs.map((d) => rm(d, { recursive: true, force: true })));
});

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

interface FakeEnv {
  environmentId: string;
  name: string;
  isDefault: boolean;
}

class FakeDokploy {
  calls: Call[] = [];
  projects: { projectId: string; name: string; envs: FakeEnv[] }[] = [];
  apps: (FakeApp & { environmentId: string })[] = [];
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

  addProject(name: string, envNames: string[] = ["production"]) {
    const project = {
      projectId: `p${++this.id}`,
      name,
      envs: envNames.map((n, i) => ({ environmentId: `e${++this.id}`, name: n, isDefault: i === 0 })),
    };
    this.projects.push(project);
    return project;
  }

  addApp(name: string, environmentId: string, repo = `h053698/${name}`) {
    const app = { applicationId: `id-${name}-${environmentId}`, name, appName: name, description: `deploy-bot repo:${repo}`, buildType: "dockerfile", dockerfile: "Dockerfile", patches: [], environmentId };
    this.apps.push(app);
    return app;
  }

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
          environments: p.envs.map((e) => ({ ...e, compose: [], applications: [] })),
        }));
      case "project.create": {
        const project = this.addProject(String(body.name));
        const env = project.envs[0];
        return { project: { projectId: project.projectId, name: project.name }, environment: env };
      }
      case "environment.create": {
        const project = this.projects.find((p) => p.projectId === body.projectId);
        if (!project) throw new Error("unknown project");
        const env = { environmentId: `e${++this.id}`, name: String(body.name), isDefault: false };
        project.envs.push(env);
        return env;
      }
      case "application.search": {
        const needle = String(body.description ?? "");
        const items = this.apps
          .filter((a) => a.description.includes(needle))
          .map((a) => ({ applicationId: a.applicationId, name: a.name, appName: a.appName, description: a.description, environmentId: a.environmentId, applicationStatus: "done" }));
        return { items, total: items.length };
      }
      case "compose.search":
        return { items: [], total: 0 };
      case "github.githubProviders":
        return [];
      case "application.create": {
        const created = {
          applicationId: `a${++this.id}`,
          name: String(body.name),
          appName: `${String(body.appName)}-x1y2z3`,
          description: String(body.description),
          buildType: "nixpacks",
          dockerfile: "",
          patches: [],
          environmentId: String(body.environmentId),
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
        return "#7 RUN npm ci\nrailpack: could not determine how to build the app <script>";
      case "application.readLogs":
        return "2026-11-02T00:00:00Z listening on :3000\n2026-11-02T00:00:01Z GET / 200";
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

async function setup() {
  const cfg = loadConfig({
    TELEGRAM_BOT_TOKEN: "123:abc",
    ALLOWED_USER_IDS: String(OWNER_ID),
    ALLOWED_CHAT_IDS: String(GROUP_ID),
    ADMIN_USER_IDS: String(ADMIN_ID),
    DOMAIN_TLS: "cloudflare",
    DOKPLOY_URL: "http://dokploy.test",
    DOKPLOY_API_KEY: "dk-key",
    AI_API_KEY: "ai-key",
    AI_BASE_URL: "http://ai.test/v1",
    AI_MODEL: "test-model",
    AI_MAX_ATTEMPTS: "1",
  });
  const dk = new FakeDokploy();
  let clock = 0;
  const deployer = new Deployer(cfg, new Dokploy(cfg.dokployUrl, cfg.dokployApiKey, dk.fetch), new GitHub(cfg.githubApiUrl, null, fakeGithub), {
    sleep: async (ms) => {
      clock += ms;
    },
    now: () => clock,
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
      method === "sendMessage" || method === "sendRichMessage"
        ? { message_id: ++messageId, date: 0, chat: { id: CHAT_ID, type: "private" }, text: (payload as { text?: string }).text ?? "" }
        : true;
    return { ok: true, result } as never;
  });
  const dir = await mkdtemp(join(tmpdir(), "deploy-bot-acl-"));
  tempDirs.push(dir);
  const accessFile = join(dir, "access.json");
  const access = await Access.load(accessFile, cfg.allowedUserIds, cfg.adminUserIds);
  const { idle } = createBot({ cfg, access, deployer, gh: new GitHub(cfg.githubApiUrl, null, fakeGithub) }, bot);
  return { bot, dk, sent, idle, accessFile, cfg };
}

let updateId = 0;
const from = (id: number) => ({ id, is_bot: false, first_name: "u" });
const chat = { id: CHAT_ID, type: "private" as const, first_name: "u" };

type AnyChat = typeof chat | { id: number; type: "supergroup"; title: string };
const group = (id: number): AnyChat => ({ id, type: "supergroup", title: "team" });

function command(text: string, userId = OWNER_ID, inChat: AnyChat = chat, topic = false): Update {
  const name = text.split(" ")[0] ?? text;
  const message = { message_id: ++updateId, date: 0, chat: inChat, from: from(userId), text, entities: [{ type: "bot_command", offset: 0, length: name.length }] };
  return { update_id: ++updateId, message: topic ? inTopic(message) : message } as Update;
}

const TOPIC = 42;
const inTopic = <T extends object>(extra: T) => ({ is_topic_message: true as const, message_thread_id: TOPIC, ...extra });

function click(data: string, userId = OWNER_ID, inChat: AnyChat = chat, topic = false): Update {
  const message = { message_id: 101, date: 0, chat: inChat, text: "x" };
  return {
    update_id: ++updateId,
    callback_query: {
      id: String(++updateId),
      from: from(userId),
      chat_instance: "ci",
      data,
      message: topic ? inTopic(message) : message,
    },
  } as Update;
}

interface Btn {
  text: string;
  callback_data?: string;
  url?: string;
  copy_text?: { text: string };
  style?: string;
}
const buttons = (s: Sent | undefined): Btn[] => ((s?.payload.reply_markup as { inline_keyboard?: Btn[][] })?.inline_keyboard ?? []).flat();
const lastWith = (sent: Sent[], pred: (s: Sent) => boolean) => [...sent].reverse().find(pred);
const bodyOf = (s: Sent | undefined) => String(s?.payload.text ?? (s?.payload.rich_message as { html?: string } | undefined)?.html ?? "");
const resultCard = (sent: Sent[], needle: string) => lastWith(sent, (s) => s.method === "sendRichMessage" && bodyOf(s).includes(needle));
const wizard = (sent: Sent[]) => lastWith(sent, (s) => s.method === "editMessageText" && buttons(s).some((b) => b.callback_data?.startsWith("wz:")));
const press = (s: Sent | undefined, label: string | RegExp, userId = OWNER_ID, inChat: AnyChat = chat, topic = false) => {
  const b = buttons(s).find((x) => (typeof label === "string" ? x.text === label : label.test(x.text)));
  if (!b?.callback_data) throw new Error(`no button ${String(label)} in ${JSON.stringify(buttons(s).map((x) => x.text))}`);
  return click(b.callback_data, userId, inChat, topic);
};
const RAILPACK = "🚂 Railpack";
const railpack = (sent: Sent[]) => press(wizard(sent), /Railpack/);
const reply = (text: string, userId = OWNER_ID): Update => ({ update_id: ++updateId, message: { message_id: ++updateId, date: 0, chat, from: from(userId), text } }) as Update;

describe("telegram flow", () => {
  beforeEach(() => {
    aiPrompts.length = 0;
  });

  test("/deploy wizard: build, project, env, domain, confirm, railpack then AI fallback (Cloudflare mode)", async () => {
    const { bot, dk, sent, idle } = await setup();
    dk.addProject("solix-web", ["production", "dev"]);
    await bot.handleUpdate(command("/deploy https://github.com/h053698/hello"));

    let w = wizard(sent);
    expect(String(w?.payload.text)).toContain("어떻게 빌드할까?");
    expect(w?.payload.parse_mode).toBe("HTML");
    const choices = buttons(w).map((b) => b.text);
    expect(choices).toEqual(expect.arrayContaining(["⭐ 🚂 Railpack", "🤖 AI가 Dockerfile 생성", "❄️ Nixpacks", "🟣 Heroku Buildpacks", "📦 Paketo Buildpacks", "📄 Static (nginx)"]));
    expect(buttons(w).find((b) => b.text.includes("Railpack"))?.style).toBe("primary");
    expect(dk.paths()).not.toContain("application.create");

    await bot.handleUpdate(railpack(sent));
    w = wizard(sent);
    expect(String(w?.payload.text)).toContain("어느 Dokploy 프로젝트에 올릴까?");
    expect(buttons(w)[0]).toMatchObject({ text: "✨ 새로 만들기: hello", style: "primary" });
    expect(buttons(w).map((b) => b.text)).toContain("📁 solix-web");

    await bot.handleUpdate(press(w, "✨ 새로 만들기: hello"));
    w = wizard(sent);
    expect(String(w?.payload.text)).toContain("도메인은 어떻게 할까?");
    await bot.handleUpdate(press(w, "🌐 hello.arpa.page"));
    w = wizard(sent);
    expect(String(w?.payload.text)).toContain("이대로 올릴까?");
    expect(String(w?.payload.text)).toContain("프로젝트 <b>hello</b> <i>(새로 만듦)</i>");
    expect(String(w?.payload.text)).toContain("환경 <b>production</b>");
    expect(String(w?.payload.text)).toContain("<code>https://hello.arpa.page</code>");
    expect(buttons(w)[0]).toMatchObject({ text: "🚀 배포하기", style: "success" });

    await bot.handleUpdate(press(w, "🚀 배포하기"));
    await idle();

    const mutations = dk.paths().filter((p) => !["project.all", "deployment.all", "github.githubProviders", "deployment.readLogs", "application.search", "compose.search"].includes(p));
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
    const created = dk.projects.find((p) => p.name === "hello");
    expect(dk.calls.find((c) => c.path === "application.create")?.body.environmentId).toBe(created?.envs[0]?.environmentId);
    expect(dk.calls.find((c) => c.path === "domain.create")?.body).toMatchObject({ host: "hello.arpa.page", port: 3000, https: false, certificateType: "none" });
    expect(String(dk.calls.find((c) => c.path === "patch.create")?.body.content)).toContain("FROM node:22-alpine");
    expect(aiPrompts[0]).toContain("could not determine how to build");

    const card = resultCard(sent, "배포 완료");
    expect(bodyOf(card)).toContain("hello / production");
    expect(bodyOf(card)).toContain("https://hello.arpa.page");
    expect(bodyOf(card)).toContain("AI가 만든");
    expect(bodyOf(card)).toContain("<table");
    expect(card?.payload.message_effect_id).toBeDefined();
    const kb = buttons(card);
    expect(kb.find((b) => b.text === "🌐 열기")).toMatchObject({ url: "https://hello.arpa.page", style: "success" });
    expect(kb.find((b) => b.text === "📋 URL 복사")?.copy_text).toEqual({ text: "https://hello.arpa.page" });
    expect(kb.find((b) => b.text === "🧭 Dokploy")?.url).toContain(`/dashboard/project/${created?.projectId}/environment/`);
    expect(kb.some((b) => b.callback_data?.startsWith("log:b:a:"))).toBe(true);
    expect(sent.some((s) => s.method === "deleteMessage")).toBe(true);
    const frozen = lastWith(sent, (s) => s.method === "editMessageReplyMarkup");
    expect(buttons(frozen).map((b) => b.text)).toEqual(["✅ 배포 완료"]);
  });

  test("choosing AI Dockerfile generates it before the first build and skips the failing railpack run", async () => {
    const { bot, dk, sent, idle } = await setup();
    await bot.handleUpdate(command("/deploy h053698/hello"));
    await bot.handleUpdate(press(wizard(sent), "🤖 AI가 Dockerfile 생성"));
    await bot.handleUpdate(press(wizard(sent), "✨ 새로 만들기: hello"));
    await bot.handleUpdate(press(wizard(sent), "🚫 도메인 없이"));
    expect(String(wizard(sent)?.payload.text)).toContain("AI가 Dockerfile을 만들어서 빌드");
    await bot.handleUpdate(press(wizard(sent), "🚀 배포하기"));
    await idle();
    const mutations = dk.paths().filter((p) => !["project.all", "deployment.all", "github.githubProviders", "application.search", "compose.search"].includes(p));
    expect(mutations).toEqual(["project.create", "application.create", "application.saveGitProvider", "patch.create", "application.saveBuildType", "application.saveEnvironment", "application.deploy"]);
    expect(dk.paths().filter((p) => p === "application.deploy")).toHaveLength(1);
    expect(aiPrompts).toHaveLength(1);
    expect(aiPrompts[0]).not.toContain("previous build failed");
    expect(bodyOf(resultCard(sent, "배포 완료"))).toContain("AI Dockerfile");
  });

  test("letsencrypt mode keeps https + certificate on the Dokploy domain", async () => {
    const dk = new FakeDokploy();
    const cfg = loadConfig({ TELEGRAM_BOT_TOKEN: "1:x", DOKPLOY_URL: "http://dokploy.test", DOKPLOY_API_KEY: "dk-key", DOMAIN_TLS: "letsencrypt" });
    const deployer = new Deployer(cfg, new Dokploy(cfg.dokployUrl, cfg.dokployApiKey, dk.fetch), new GitHub(cfg.githubApiUrl, null, fakeGithub), { sleep: async () => {}, now: () => 0, resolveHost: async () => true });
    const project = dk.addProject("p");
    const noop = { step: () => {} };
    const repo = { owner: "h053698", repo: "hello", defaultBranch: "main", private: false, cloneUrl: "https://github.com/h053698/hello.git", htmlUrl: "h" };
    const plan: BuildPlan = { kind: "application", buildType: "dockerfile", dockerfile: "Dockerfile", port: 3000, setPortEnv: false, warnings: [] };
    const target = { projectId: project.projectId, projectName: "p", environmentId: project.envs[0]?.environmentId ?? "", environmentName: "production" };
    const result = await deployer.deploy({ repo, files: [], plan, domain: "hello.arpa.page", target }, noop);
    expect(dk.calls.find((c) => c.path === "domain.create")?.body).toMatchObject({ https: true, certificateType: "letsencrypt" });
    expect(result.url).toBe("https://hello.arpa.page");
  });

  test("static choice uses the static builder on port 80 without a PORT env", async () => {
    const { bot, dk, sent, idle } = await setup();
    await bot.handleUpdate(command("/deploy h053698/hello"));
    await bot.handleUpdate(press(wizard(sent), "📄 Static (nginx)"));
    await bot.handleUpdate(press(wizard(sent), "✨ 새로 만들기: hello"));
    await bot.handleUpdate(press(wizard(sent), "🌐 hello.arpa.page"));
    await bot.handleUpdate(press(wizard(sent), "🚀 배포하기"));
    await idle();
    expect(dk.calls.find((c) => c.path === "application.saveBuildType")?.body).toMatchObject({ buildType: "static", isStaticSpa: true });
    expect(dk.paths()).not.toContain("application.saveEnvironment");
    expect(dk.calls.find((c) => c.path === "domain.create")?.body).toMatchObject({ port: 80 });
  });

  test("a non-production environment gets its own default subdomain", async () => {
    const { bot, dk, sent } = await setup();
    dk.addProject("solix-web", ["production", "dev"]);
    await bot.handleUpdate(command("/deploy h053698/hello"));
    await bot.handleUpdate(railpack(sent));
    await bot.handleUpdate(press(wizard(sent), "📁 solix-web"));
    await bot.handleUpdate(press(wizard(sent), "🌱 dev"));
    expect(buttons(wizard(sent)).map((b) => b.text)).toContain("🌐 hello-dev.arpa.page");
  });

  test("existing project + new environment via button creates the environment there", async () => {
    const { bot, dk, sent, idle } = await setup();
    const project = dk.addProject("solix-web", ["production"]);
    await bot.handleUpdate(command("/deploy h053698/hello"));
    await bot.handleUpdate(railpack(sent));
    await bot.handleUpdate(press(wizard(sent), "📁 solix-web"));
    let w = wizard(sent);
    expect(String(w?.payload.text)).toContain("어느 환경(environment)에 올릴까?");
    expect(buttons(w).find((b) => b.text === "🌱 production (기본)")?.style).toBe("primary");
    await bot.handleUpdate(press(w, "＋ staging"));
    await bot.handleUpdate(press(wizard(sent), "🚫 도메인 없이"));
    w = wizard(sent);
    expect(String(w?.payload.text)).toContain("환경 <b>staging</b> <i>(새로 만듦)</i>");
    expect(String(w?.payload.text)).toContain("도메인 없음");
    await bot.handleUpdate(press(w, "🚀 배포하기"));
    await idle();
    expect(dk.calls.find((c) => c.path === "environment.create")?.body).toMatchObject({ name: "staging", projectId: project.projectId });
    const staging = project.envs.find((e) => e.name === "staging");
    expect(dk.calls.find((c) => c.path === "application.create")?.body.environmentId).toBe(staging?.environmentId);
    expect(dk.paths()).not.toContain("project.create");
    expect(dk.paths()).not.toContain("domain.create");
  });

  test("typed project, env and domain names are validated, normalized, and the prompt is cleaned up", async () => {
    const { bot, dk, sent, idle } = await setup();
    const project = dk.addProject("team-apps", ["production", "dev"]);
    await bot.handleUpdate(command("/deploy h053698/hello"));
    await bot.handleUpdate(railpack(sent));
    await bot.handleUpdate(press(wizard(sent), "✏️ 이름 직접 입력"));
    const prompt = lastWith(sent, (s) => s.method === "sendMessage" && String(s.payload.text).startsWith("✏️"));
    expect(prompt?.payload.reply_markup).toMatchObject({ force_reply: true, inline_keyboard: [[{ text: "취소" }]] });
    await bot.handleUpdate(reply("Bad Name!!"));
    expect(String(lastWith(sent, (s) => s.method === "sendMessage")?.payload.text)).toContain("영문 소문자");
    await bot.handleUpdate(reply("Team-Apps"));
    expect(sent.some((s) => s.method === "deleteMessage")).toBe(true);
    await bot.handleUpdate(press(wizard(sent), "✏️ 직접 입력"));
    await bot.handleUpdate(reply("dev"));
    await bot.handleUpdate(press(wizard(sent), "✏️ 직접 입력"));
    await bot.handleUpdate(reply("my-api"));
    expect(sent.some((s) => s.method === "setMessageReaction")).toBe(true);
    await bot.handleUpdate(press(wizard(sent), "🚀 배포하기"));
    await idle();
    expect(dk.paths()).not.toContain("project.create");
    expect(dk.paths()).not.toContain("environment.create");
    expect(dk.calls.find((c) => c.path === "application.create")?.body.environmentId).toBe(project.envs[1]?.environmentId);
    expect(dk.calls.find((c) => c.path === "domain.create")?.body).toMatchObject({ host: "my-api.arpa.page" });
  });

  test("in groups the typed-input prompt is a selective force reply that mentions the user", async () => {
    const { bot, sent } = await setup();
    await bot.handleUpdate(command("/deploy h053698/hello", STRANGER_ID, group(GROUP_ID)));
    await bot.handleUpdate(press(wizard(sent), /Railpack/, STRANGER_ID, group(GROUP_ID)));
    await bot.handleUpdate(press(wizard(sent), "✏️ 이름 직접 입력", STRANGER_ID, group(GROUP_ID)));
    const prompt = lastWith(sent, (s) => s.method === "sendMessage" && String(s.payload.text).startsWith("✏️"));
    expect(prompt?.payload.reply_markup).toMatchObject({ force_reply: true, selective: true });
    expect(String(prompt?.payload.text)).toContain(`tg://user?id=${STRANGER_ID}`);
  });

  test("another user cannot drive someone else's wizard; cancel ends it", async () => {
    const { bot, dk, sent } = await setup();
    await bot.handleUpdate(command("/deploy h053698/hello", STRANGER_ID, group(GROUP_ID)));
    const w = wizard(sent);
    const data = buttons(w)[0]?.callback_data ?? "";
    await bot.handleUpdate(click(data, OWNER_ID, group(GROUP_ID)));
    expect(lastWith(sent, (s) => s.method === "answerCallbackQuery")?.payload.text).toContain("다른 사람");
    await bot.handleUpdate(click(buttons(w).find((b) => b.text === "취소")?.callback_data ?? "", STRANGER_ID, group(GROUP_ID)));
    expect(String(lastWith(sent, (s) => s.method === "editMessageText")?.payload.text)).toContain("배포 취소");
    await bot.handleUpdate(click(data, STRANGER_ID, group(GROUP_ID)));
    expect(lastWith(sent, (s) => s.method === "answerCallbackQuery")?.payload.text).toContain("만료");
    expect(dk.paths()).not.toContain("application.create");
  });

  test("/update with partial name shows env-labelled picker, click runs deploy with live log", async () => {
    const { bot, dk, sent, idle } = await setup();
    const p = dk.addProject("team", ["production", "staging"]);
    dk.addApp("hello", p.envs[0]?.environmentId ?? "");
    dk.addApp("hello-api", p.envs[1]?.environmentId ?? "");

    await bot.handleUpdate(command("/update hel"));
    const picker = lastWith(sent, (s) => buttons(s).length > 0);
    expect(picker?.payload.text).toBe("어떤 서비스를 업데이트할까?");
    expect(buttons(picker).map((b) => b.text)).toEqual(["🟢 h053698/hello · production", "🟢 h053698/hello-api · staging"]);

    await bot.handleUpdate(click(buttons(picker)[1]?.callback_data ?? ""));
    await idle();
    expect(dk.calls.filter((c) => c.path === "application.deploy").map((c) => c.body.applicationId)).toEqual([`id-hello-api-${p.envs[1]?.environmentId}`]);
    const final = resultCard(sent, "배포 완료");
    expect(bodyOf(final)).toContain("team / staging");
  });

  test("/redeploy with exact name rebuilds without a picker", async () => {
    const { bot, dk, idle } = await setup();
    const p = dk.addProject("team");
    dk.addApp("hello", p.envs[0]?.environmentId ?? "");
    dk.addApp("hello-api", p.envs[0]?.environmentId ?? "");
    await bot.handleUpdate(command("/redeploy hello"));
    await idle();
    expect(dk.calls.filter((c) => c.path === "application.redeploy").length).toBe(1);
    expect(dk.paths()).not.toContain("application.deploy");
  });

  test("failed build shows an escaped expandable log and a build-log button", async () => {
    const { bot, dk, sent, idle } = await setup();
    const p = dk.addProject("team");
    const a = dk.addApp("hello", p.envs[0]?.environmentId ?? "");
    a.buildType = "railpack";
    await bot.handleUpdate(command("/redeploy hello"));
    await idle();
    const final = resultCard(sent, "배포 실패");
    expect(bodyOf(final)).toContain("<blockquote expandable>");
    expect(bodyOf(final)).toContain("&lt;script&gt;");
    expect(bodyOf(final)).not.toContain("sha256:");
    expect(final?.payload.message_effect_id).toBeUndefined();
    const logBtn = buttons(final).find((b) => b.text === "📜 빌드 로그");
    await bot.handleUpdate(click(logBtn?.callback_data ?? ""));
    expect(String(lastWith(sent, (s) => s.method === "sendMessage")?.payload.text)).toContain("빌드 로그");
  });

  test("/logs shows runtime logs with refresh", async () => {
    const { bot, dk, sent } = await setup();
    const p = dk.addProject("team");
    dk.addApp("hello", p.envs[0]?.environmentId ?? "");
    await bot.handleUpdate(command("/logs hello"));
    const msg = lastWith(sent, (s) => s.method === "sendMessage");
    expect(String(msg?.payload.text)).toContain("listening on :3000");
    expect(String(msg?.payload.text)).not.toContain("sha256:");
    expect(buttons(msg).map((b) => b.text)).toEqual(["🔄 새로고침", "🧭 Dokploy"]);
  });

  test("/deploy of an already managed repo still starts the wizard and offers update shortcuts", async () => {
    const { bot, dk, sent } = await setup();
    const p = dk.addProject("team");
    dk.addApp("hello", p.envs[0]?.environmentId ?? "");
    await bot.handleUpdate(command("/deploy https://github.com/h053698/hello"));
    expect(wizard(sent)).toBeDefined();
    const shortcut = lastWith(sent, (s) => String(s.payload.text).includes("이미 1곳에 배포돼"));
    expect(buttons(shortcut).map((b) => b.callback_data)).toEqual([`run:u:a:id-hello-${p.envs[0]?.environmentId}`]);
    expect(dk.paths()).not.toContain("application.create");
  });

  test("every message of a deploy started inside a forum topic stays in that topic", async () => {
    const { bot, dk, sent, idle } = await setup();
    const inGroup = group(GROUP_ID);
    await bot.handleUpdate(command("/deploy h053698/hello", OWNER_ID, inGroup, true));
    let w = wizard(sent);
    await bot.handleUpdate(press(w, /Railpack/, OWNER_ID, inGroup, true));
    await bot.handleUpdate(press(wizard(sent), "✨ 새로 만들기: hello", OWNER_ID, inGroup, true));
    await bot.handleUpdate(press(wizard(sent), "🚫 도메인 없이", OWNER_ID, inGroup, true));
    await bot.handleUpdate(press(wizard(sent), "🚀 배포하기", OWNER_ID, inGroup, true));
    await idle();
    const outgoing = sent.filter((s) => ["sendMessage", "sendRichMessage"].includes(s.method) && s.payload.chat_id === GROUP_ID);
    expect(outgoing.length).toBeGreaterThanOrEqual(3);
    for (const s of outgoing) expect({ method: s.method, thread: s.payload.message_thread_id }).toEqual({ method: s.method, thread: TOPIC });
    expect(dk.paths()).toContain("application.deploy");
  });

  test("a deploy started in General (no topic) sends no thread id", async () => {
    const { bot, sent, idle } = await setup();
    const inGroup = group(GROUP_ID);
    await bot.handleUpdate(command("/deploy h053698/hello", OWNER_ID, inGroup));
    await bot.handleUpdate(press(wizard(sent), /Railpack/, OWNER_ID, inGroup));
    await bot.handleUpdate(press(wizard(sent), "✨ 새로 만들기: hello", OWNER_ID, inGroup));
    await bot.handleUpdate(press(wizard(sent), "🚫 도메인 없이", OWNER_ID, inGroup));
    await bot.handleUpdate(press(wizard(sent), "🚀 배포하기", OWNER_ID, inGroup));
    await idle();
    const outgoing = sent.filter((s) => ["sendMessage", "sendRichMessage"].includes(s.method) && s.payload.chat_id === GROUP_ID);
    expect(outgoing.length).toBeGreaterThanOrEqual(3);
    for (const s of outgoing) expect(s.payload.message_thread_id).toBeUndefined();
  });

  test("any member of an allowed group can use the bot there", async () => {
    const { bot, dk, sent } = await setup();
    await bot.handleUpdate(command("/deploy@deploy_bot https://github.com/h053698/hello", STRANGER_ID, group(GROUP_ID)));
    expect(String(wizard(sent)?.payload.text)).toContain("어떻게 빌드할까?");
    expect(dk.paths()).toContain("project.all");
  });

  test("other groups are rejected even for allowed users, and the reply shows the group id", async () => {
    const { bot, dk, sent } = await setup();
    await bot.handleUpdate(command("/deploy https://github.com/h053698/hello", OWNER_ID, group(OTHER_GROUP_ID)));
    expect(String(sent[0]?.payload.text)).toContain(String(OTHER_GROUP_ID));
    expect(dk.calls).toEqual([]);
  });

  test("plain group chatter from a non-allowed group gets no reply", async () => {
    const { bot, sent } = await setup();
    await bot.handleUpdate({ update_id: ++updateId, message: { message_id: ++updateId, date: 0, chat: group(OTHER_GROUP_ID), from: from(OWNER_ID), text: "hello" } } as Update);
    expect(sent).toEqual([]);
  });

  test("unauthorized users are rejected and nothing reaches Dokploy", async () => {
    const { bot, dk, sent } = await setup();
    await bot.handleUpdate(command("/deploy https://github.com/h053698/hello", STRANGER_ID));
    await bot.handleUpdate(click("run:u:a:id-hello", STRANGER_ID));
    expect(String(sent[0]?.payload.text)).toContain(String(STRANGER_ID));
    expect(sent.find((s) => s.method === "answerCallbackQuery")?.payload).toMatchObject({ text: "권한 없음" });
    expect(dk.calls).toEqual([]);
  });

  test("admin /allow persists a user who can then use DMs; /disallow revokes", async () => {
    const { bot, dk, sent, accessFile, cfg } = await setup();
    await bot.handleUpdate(command("/list", STRANGER_ID));
    expect(dk.calls).toEqual([]);

    await bot.handleUpdate(command(`/allow ${STRANGER_ID}`, ADMIN_ID));
    expect(String(sent.at(-1)?.payload.text)).toContain("허용했어");
    expect(await Bun.file(accessFile).json()).toEqual({ users: [STRANGER_ID] });

    const reloaded = await Access.load(accessFile, cfg.allowedUserIds, cfg.adminUserIds);
    expect(reloaded.isUser(STRANGER_ID)).toBe(true);

    await bot.handleUpdate(command("/list", STRANGER_ID));
    expect(dk.paths()).toContain("application.search");
    expect(lastWith(sent, (s) => s.method === "sendRichMessage" || s.method === "sendMessage")).toBeDefined();

    await bot.handleUpdate(command(`/disallow ${STRANGER_ID}`, ADMIN_ID));
    expect(await Bun.file(accessFile).json()).toEqual({ users: [] });
    const callsBefore = dk.calls.length;
    await bot.handleUpdate(command("/list", STRANGER_ID));
    expect(dk.calls.length).toBe(callsBefore);
  });

  test("non-admins cannot /allow, even allowed users", async () => {
    const { bot, sent, accessFile } = await setup();
    await bot.handleUpdate(command(`/allow ${STRANGER_ID}`, OWNER_ID));
    expect(String(sent.at(-1)?.payload.text)).toContain("관리자만");
    expect(await Bun.file(accessFile).exists()).toBe(false);
  });

  test("/allow as a reply in an allowed group targets the replied user", async () => {
    const { bot, sent, accessFile } = await setup();
    const update = command("/allow", ADMIN_ID, group(GROUP_ID)) as Update & { message: Record<string, unknown> };
    update.message.reply_to_message = { message_id: 1, date: 0, chat: group(GROUP_ID), from: from(STRANGER_ID), text: "hi", reply_to_message: undefined };
    await bot.handleUpdate(update);
    expect(String(sent.at(-1)?.payload.text)).toContain(`${STRANGER_ID} 허용했어`);
    expect(await Bun.file(accessFile).json()).toEqual({ users: [STRANGER_ID] });
  });

  test("denied DM notifies admins once with an approve button that grants access", async () => {
    const { bot, sent, accessFile } = await setup();
    await bot.handleUpdate(command("/start", STRANGER_ID));
    await bot.handleUpdate(command("/deploy x/y", STRANGER_ID));
    const requests = sent.filter((s) => s.method === "sendMessage" && s.payload.chat_id === ADMIN_ID);
    expect(requests).toHaveLength(1);
    const approve = buttons(requests[0]).find((b) => b.text === "✅ 허용");
    expect(approve).toMatchObject({ callback_data: `acl:add:${STRANGER_ID}`, style: "success" });

    await bot.handleUpdate(click(approve?.callback_data ?? "", OWNER_ID));
    expect(await Bun.file(accessFile).exists()).toBe(false);

    await bot.handleUpdate(click(approve?.callback_data ?? "", ADMIN_ID));
    expect(await Bun.file(accessFile).json()).toEqual({ users: [STRANGER_ID] });
    expect(sent.at(-1)).toMatchObject({ method: "sendMessage", payload: { chat_id: STRANGER_ID } });
  });
});
