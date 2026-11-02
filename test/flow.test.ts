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

  domainHosts: string[] = [];
  noDomains = false;

  addDomain(host: string) {
    this.domainHosts.push(host);
  }

  addProject(name: string, envNames: string[] = ["production"]) {
    const project = {
      projectId: `p${++this.id}`,
      name,
      envs: envNames.map((n, i) => ({ environmentId: `e${++this.id}`, name: n, isDefault: i === 0 })),
    };
    this.projects.push(project);
    return project;
  }

  addApp(name: string, environmentId: string, repo = `acme/${name}`) {
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
      case "overview.domains":
        return this.domainHosts.map((host) => ({ host }));
      case "domain.byApplicationId":
        return this.noDomains ? [] : [{ domainId: "dom1", host: "hello.example.test", https: true, port: 3000 }];
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
  owner: { login: "acme" },
  default_branch: "main",
  private: false,
  clone_url: "https://github.com/acme/hello.git",
  html_url: "https://github.com/acme/hello",
};

const fakeGithub = async (input: string | URL | Request): Promise<Response> => {
  const url = new URL(String(input));
  if (url.pathname === "/repos/acme/hello") return Response.json(REPO);
  if (url.pathname === "/repos/acme/hello/git/trees/main") {
    return Response.json({ tree: [{ path: "package.json", type: "blob" }, { path: "index.js", type: "blob" }] });
  }
  if (url.pathname === "/repos/acme/hello/contents/package.json") return new Response('{"name":"hello"}');
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

const dnsTable: Record<string, string[]> = {};

async function setup() {
  for (const key of Object.keys(dnsTable)) delete dnsTable[key];
  dnsTable["dokploy.test"] = ["203.0.113.10"];
  const cfg = loadConfig({
    TELEGRAM_BOT_TOKEN: "123:abc",
    ALLOWED_USER_IDS: String(OWNER_ID),
    ALLOWED_CHAT_IDS: String(GROUP_ID),
    ADMIN_USER_IDS: String(ADMIN_ID),
    DOMAIN_TLS: "cloudflare",
    BASE_DOMAIN: "example.test",
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
    resolver: async (host) => dnsTable[host] ?? [],
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
  const access = await Access.load(accessFile, cfg.allowedUserIds, cfg.adminUserIds, cfg.allowedChatIds);
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
  disabled?: boolean;
}
const unesc = (s: string) => s.replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
const richButtons = (html: string): Btn[] =>
  [...html.matchAll(/<tg-button ([^>]*)>([^<]*)<\/tg-button>/g)].map((m) => {
    const attrs = Object.fromEntries([...(m[1] ?? "").matchAll(/([\w-]+)="([^"]*)"/g)].map((a) => [a[1], unesc(a[2] ?? "")]));
    const btn: Btn = { text: unesc(m[2] ?? "") };
    if (attrs.type === "callback_data") btn.callback_data = attrs.data;
    if (attrs.type === "url") btn.url = attrs.url;
    if (attrs.type === "copy_text") btn.copy_text = { text: attrs.text ?? "" };
    if (attrs.type === "disabled") btn.disabled = true;
    if (attrs.style) btn.style = attrs.style;
    return btn;
  });
const buttons = (s: Sent | undefined): Btn[] => {
  const html = (s?.payload.rich_message as { html?: string } | undefined)?.html;
  return html ? richButtons(html) : ((s?.payload.reply_markup as { inline_keyboard?: Btn[][] })?.inline_keyboard ?? []).flat();
};
const lastWith = (sent: Sent[], pred: (s: Sent) => boolean) => [...sent].reverse().find(pred);
const bodyOf = (s: Sent | undefined) => String(s?.payload.text ?? (s?.payload.rich_message as { html?: string } | undefined)?.html ?? "");
const isOutbound = (s: Sent) => s.method === "sendMessage" || s.method === "sendRichMessage";
const outbound = (sent: Sent[], pred: (s: Sent) => boolean = () => true) => lastWith(sent, (s) => isOutbound(s) && pred(s));
const forceReply = (s: Sent) => Boolean((s.payload.reply_markup as { force_reply?: boolean } | undefined)?.force_reply);
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
    await bot.handleUpdate(command("/deploy https://github.com/acme/hello"));

    let w = wizard(sent);
    expect(bodyOf(w)).toContain("어떻게 빌드할까?");
    expect(w?.method).toBe("editMessageText");
    expect((w?.payload.rich_message as { html?: string } | undefined)?.html).toContain("<tg-button-row>");
    const choices = buttons(w).map((b) => b.text);
    expect(choices).toEqual(expect.arrayContaining(["Railpack (추천)", "AI가 Dockerfile 생성", "Nixpacks", "Heroku Buildpacks", "Paketo Buildpacks", "Static (nginx)"]));
    expect(buttons(w).find((b) => b.text.includes("Railpack"))?.style).toBe("primary");
    expect(dk.paths()).not.toContain("application.create");

    await bot.handleUpdate(railpack(sent));
    w = wizard(sent);
    expect(bodyOf(w)).toContain("어느 Dokploy 프로젝트에 올릴까?");
    expect(buttons(w)[0]).toMatchObject({ text: "새 프로젝트: hello (추천)", style: "primary" });
    expect(buttons(w).map((b) => b.text)).toContain("solix-web");

    await bot.handleUpdate(press(w, "새 프로젝트: hello (추천)"));
    w = wizard(sent);
    expect(bodyOf(w)).toContain("도메인은 어떻게 할까?");
    await bot.handleUpdate(press(w, "hello.example.test (추천)"));
    w = wizard(sent);
    expect(bodyOf(w)).toContain("이대로 올릴까?");
    expect(bodyOf(w)).toContain("<td><b>프로젝트</b></td><td><b>hello</b> <i>(새로 만듦)</i></td>");
    expect(bodyOf(w)).toContain("<td><b>환경</b></td><td><b>production</b>");
    expect(bodyOf(w)).toContain("<code>https://hello.example.test</code>");
    expect(buttons(w)[0]).toMatchObject({ text: "배포하기", style: "success" });

    await bot.handleUpdate(press(w, "배포하기"));
    await idle();

    const mutations = dk.paths().filter((p) => !["project.all", "deployment.all", "github.githubProviders", "deployment.readLogs", "application.search", "compose.search", "overview.domains"].includes(p));
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
    expect(dk.calls.find((c) => c.path === "domain.create")?.body).toMatchObject({ host: "hello.example.test", port: 3000, https: false, certificateType: "none" });
    expect(String(dk.calls.find((c) => c.path === "patch.create")?.body.content)).toContain("FROM node:22-alpine");
    expect(aiPrompts[0]).toContain("could not determine how to build");

    const card = resultCard(sent, "배포 완료");
    expect(bodyOf(card)).toContain("hello / production");
    expect(bodyOf(card)).toContain("https://hello.example.test");
    expect(bodyOf(card)).toContain("AI가 만든");
    expect(bodyOf(card)).toContain("<table");
    expect(card?.payload.message_effect_id).toBeDefined();
    const kb = buttons(card);
    expect(kb.find((b) => b.text === "사이트 열기")).toMatchObject({ url: "https://hello.example.test", style: "success" });
    expect(kb.find((b) => b.text === "URL 복사")?.copy_text).toEqual({ text: "https://hello.example.test" });
    expect(kb.find((b) => b.text === "Dokploy")?.url).toContain(`/dashboard/project/${created?.projectId}/environment/`);
    expect(kb.some((b) => b.callback_data?.startsWith("log:b:a:"))).toBe(true);
    expect(sent.some((s) => s.method === "deleteMessage")).toBe(true);
    const frozen = lastWith(sent, (s) => s.method === "editMessageText" && buttons(s).some((b) => b.disabled));
    expect(buttons(frozen)).toEqual([{ text: "배포 완료", disabled: true }]);
  });

  test("choosing AI Dockerfile generates it before the first build and skips the failing railpack run", async () => {
    const { bot, dk, sent, idle } = await setup();
    await bot.handleUpdate(command("/deploy acme/hello"));
    await bot.handleUpdate(press(wizard(sent), "AI가 Dockerfile 생성"));
    await bot.handleUpdate(press(wizard(sent), "새 프로젝트: hello (추천)"));
    await bot.handleUpdate(press(wizard(sent), "도메인 없이"));
    expect(bodyOf(wizard(sent))).toContain("AI가 Dockerfile을 만들어서 빌드");
    await bot.handleUpdate(press(wizard(sent), "배포하기"));
    await idle();
    const mutations = dk.paths().filter((p) => !["project.all", "deployment.all", "github.githubProviders", "application.search", "compose.search", "overview.domains"].includes(p));
    expect(mutations).toEqual(["project.create", "application.create", "application.saveGitProvider", "patch.create", "application.saveBuildType", "application.saveEnvironment", "application.deploy"]);
    expect(dk.paths().filter((p) => p === "application.deploy")).toHaveLength(1);
    expect(aiPrompts).toHaveLength(1);
    expect(aiPrompts[0]).not.toContain("previous build failed");
    expect(bodyOf(resultCard(sent, "배포 완료"))).toContain("AI Dockerfile");
  });

  test("letsencrypt mode keeps https + certificate on the Dokploy domain", async () => {
    const dk = new FakeDokploy();
    const cfg = loadConfig({ TELEGRAM_BOT_TOKEN: "1:x", DOKPLOY_URL: "http://dokploy.test", DOKPLOY_API_KEY: "dk-key", DOMAIN_TLS: "letsencrypt", BASE_DOMAIN: "example.test" });
    const deployer = new Deployer(cfg, new Dokploy(cfg.dokployUrl, cfg.dokployApiKey, dk.fetch), new GitHub(cfg.githubApiUrl, null, fakeGithub), { sleep: async () => {}, now: () => 0, resolver: async () => ["203.0.113.10"] });
    const project = dk.addProject("p");
    const noop = { step: () => {} };
    const repo = { owner: "acme", repo: "hello", defaultBranch: "main", private: false, cloneUrl: "https://github.com/acme/hello.git", htmlUrl: "h" };
    const plan: BuildPlan = { kind: "application", buildType: "dockerfile", dockerfile: "Dockerfile", port: 3000, setPortEnv: false, warnings: [] };
    const target = { projectId: project.projectId, projectName: "p", environmentId: project.envs[0]?.environmentId ?? "", environmentName: "production" };
    const result = await deployer.deploy({ repo, files: [], plan, domain: "hello.example.test", target }, noop);
    expect(dk.calls.find((c) => c.path === "domain.create")?.body).toMatchObject({ https: true, certificateType: "letsencrypt" });
    expect(result.url).toBe("https://hello.example.test");
  });

  test("a taken default domain gets a 4-digit suffix and the plain name is not offered", async () => {
    const { bot, dk, sent, idle } = await setup();
    dk.addDomain("hello.example.test");
    await bot.handleUpdate(command("/deploy acme/hello"));
    await bot.handleUpdate(railpack(sent));
    await bot.handleUpdate(press(wizard(sent), "새 프로젝트: hello (추천)"));
    const w = wizard(sent);
    expect(bodyOf(w)).toContain("hello.example.test</code>는 이미 쓰는 중이라");
    const labels = buttons(w).map((b) => b.text);
    expect(labels.some((l) => /^hello-\d{4}\.example\.test \(추천\)$/.test(l))).toBe(true);
    expect(labels).not.toContain("hello.example.test (추천)");
    await bot.handleUpdate(press(w, /^hello-\d{4}\.example\.test/));
    await bot.handleUpdate(press(wizard(sent), "배포하기"));
    await idle();
    expect(String(dk.calls.find((c) => c.path === "domain.create")?.body.host)).toMatch(/^hello-\d{4}\.example\.test$/);
  });

  test("a typed domain that is already in use is rejected with a free alternative", async () => {
    const { bot, dk, sent } = await setup();
    dk.addDomain("my-api.example.test");
    await bot.handleUpdate(command("/deploy acme/hello"));
    await bot.handleUpdate(railpack(sent));
    await bot.handleUpdate(press(wizard(sent), "새 프로젝트: hello (추천)"));
    await bot.handleUpdate(press(wizard(sent), "직접 입력"));
    await bot.handleUpdate(reply("my-api"));
    const refusal = bodyOf(outbound(sent));
    expect(refusal).toContain("my-api.example.test</code>는 이미 쓰는 도메인이야");
    expect(refusal).toMatch(/my-api-\d{4}\.example\.test/);
    await bot.handleUpdate(reply("my-api-2"));
    expect(bodyOf(wizard(sent))).toContain("my-api-2.example.test");
  });

  test("a domain taken between choosing and confirming sends the wizard back to the domain step", async () => {
    const { bot, dk, sent } = await setup();
    await bot.handleUpdate(command("/deploy acme/hello"));
    await bot.handleUpdate(railpack(sent));
    await bot.handleUpdate(press(wizard(sent), "새 프로젝트: hello (추천)"));
    await bot.handleUpdate(press(wizard(sent), "hello.example.test (추천)"));
    dk.addDomain("hello.example.test");
    await bot.handleUpdate(press(wizard(sent), "배포하기"));
    expect(dk.paths()).not.toContain("application.create");
    expect(bodyOf(wizard(sent))).toContain("도메인은 어떻게 할까?");
    expect(bodyOf(outbound(sent))).toContain("방금 다른 서비스가 쓰기 시작했어");
    expect(buttons(wizard(sent)).some((b) => /^hello-\d{4}\.example\.test \(추천\)$/.test(b.text))).toBe(true);
  });

  test("default-base domains skip the DNS panel, custom domains show state-specific guidance and a recheck button", async () => {
    const { bot, sent } = await setup();
    await bot.handleUpdate(command("/deploy acme/hello"));
    await bot.handleUpdate(railpack(sent));
    await bot.handleUpdate(press(wizard(sent), /^새 프로젝트/));
    await bot.handleUpdate(press(wizard(sent), /\(추천\)$/));
    expect(bodyOf(wizard(sent))).not.toContain("DNS 확인");
    expect(buttons(wizard(sent)).map((b) => b.text)).not.toContain("DNS 다시 확인");

    await bot.handleUpdate(press(wizard(sent), "뒤로"));
    await bot.handleUpdate(press(wizard(sent), "직접 입력"));
    await bot.handleUpdate(reply("shop.example.com"));
    let w = wizard(sent);
    expect(bodyOf(w)).toContain("shop.example.com</code>가 아직 설정되지 않았어");
    expect(bodyOf(w)).toContain("203.0.113.10");
    expect(bodyOf(w)).toContain("Flexible");
    expect(buttons(w).map((b) => b.text)).toContain("DNS 다시 확인");

    dnsTable["shop.example.com"] = ["198.51.100.7"];
    await bot.handleUpdate(press(w, "DNS 다시 확인"));
    w = wizard(sent);
    expect(bodyOf(w)).toContain("다른 곳(<code>198.51.100.7</code>)을 가리키고 있어");

    dnsTable["shop.example.com"] = ["104.21.91.175"];
    await bot.handleUpdate(press(w, "DNS 다시 확인"));
    expect(bodyOf(wizard(sent))).toContain("Cloudflare 프록시로 연결돼 있어");

    dnsTable["shop.example.com"] = ["203.0.113.10"];
    await bot.handleUpdate(press(wizard(sent), "DNS 다시 확인"));
    expect(bodyOf(wizard(sent))).toContain("서버로 바로 연결돼 있어");
  });

  test("/list rows open a management panel in place with the result-card actions, and a back button returns to the list", async () => {
    const { bot, dk, sent } = await setup();
    const p = dk.addProject("team", ["production", "staging"]);
    dk.addApp("hello", p.envs[0]?.environmentId ?? "");
    dk.addApp("hello-api", p.envs[1]?.environmentId ?? "");
    dk.deployments.push({ deploymentId: "dep1", applicationId: `id-hello-${p.envs[0]?.environmentId}`, status: "done" });

    await bot.handleUpdate(command("/list"));
    const list = outbound(sent);
    expect(buttons(list).map((b) => b.text)).toEqual(["acme/hello · production (정상)", "acme/hello-api · staging (정상)"]);

    await bot.handleUpdate(press(list, /^acme\/hello · production/));
    const panel = lastWith(sent, (s) => s.method === "editMessageText");
    expect(bodyOf(panel)).toContain("acme/hello");
    expect(bodyOf(panel)).toContain("team / production");
    expect(bodyOf(panel)).toContain("https://hello.example.test");
    const labels = buttons(panel).map((b) => b.text);
    expect(labels).toEqual(["사이트 열기", "Dokploy", "URL 복사", "빌드 로그", "실행 로그", "업데이트", "다시 빌드", "새로고침", "목록으로"]);
    expect(buttons(panel).find((b) => b.text === "빌드 로그")?.callback_data).toBe(`log:b:a:id-hello-${p.envs[0]?.environmentId}:dep1`);
    expect(buttons(panel).find((b) => b.text === "사이트 열기")?.url).toBe("https://hello.example.test");

    await bot.handleUpdate(press(panel, "목록으로"));
    const back = lastWith(sent, (s) => s.method === "editMessageText");
    expect(bodyOf(back)).toContain("관리 중인 서비스 (2)");
    expect(buttons(back).length).toBe(2);
  });

  test("a panel for a service with no domain or deployments omits the site and build-log buttons", async () => {
    const { bot, dk, sent } = await setup();
    const p = dk.addProject("team");
    dk.addApp("hello", p.envs[0]?.environmentId ?? "");
    dk.noDomains = true;
    await bot.handleUpdate(command("/list"));
    await bot.handleUpdate(press(outbound(sent), /hello/));
    const labels = buttons(lastWith(sent, (s) => s.method === "editMessageText")).map((b) => b.text);
    expect(labels).toEqual(["Dokploy", "실행 로그", "업데이트", "다시 빌드", "새로고침", "목록으로"]);
  });

  test("once the deploy starts the wizard keeps its summary table but drops the question", async () => {
    const { bot, sent } = await setup();
    await bot.handleUpdate(command("/deploy acme/hello"));
    await bot.handleUpdate(railpack(sent));
    await bot.handleUpdate(press(wizard(sent), /^새 프로젝트/));
    await bot.handleUpdate(press(wizard(sent), "도메인 없이"));
    expect(bodyOf(wizard(sent))).toContain("이대로 올릴까?");
    await bot.handleUpdate(press(wizard(sent), "배포하기"));
    const frozen = lastWith(sent, (s) => s.method === "editMessageText" && buttons(s).some((b) => b.disabled));
    expect(bodyOf(frozen)).toContain("<table");
    expect(bodyOf(frozen)).not.toContain("이대로 올릴까?");
    expect(bodyOf(frozen)).not.toContain("<tg-button type=\"callback_data\"");
  });

  test("static choice uses the static builder on port 80 without a PORT env", async () => {
    const { bot, dk, sent, idle } = await setup();
    await bot.handleUpdate(command("/deploy acme/hello"));
    await bot.handleUpdate(press(wizard(sent), "Static (nginx)"));
    await bot.handleUpdate(press(wizard(sent), "새 프로젝트: hello (추천)"));
    await bot.handleUpdate(press(wizard(sent), "hello.example.test (추천)"));
    await bot.handleUpdate(press(wizard(sent), "배포하기"));
    await idle();
    expect(dk.calls.find((c) => c.path === "application.saveBuildType")?.body).toMatchObject({ buildType: "static", isStaticSpa: true });
    expect(dk.paths()).not.toContain("application.saveEnvironment");
    expect(dk.calls.find((c) => c.path === "domain.create")?.body).toMatchObject({ port: 80 });
  });

  test("a non-production environment gets its own default subdomain", async () => {
    const { bot, dk, sent } = await setup();
    dk.addProject("solix-web", ["production", "dev"]);
    await bot.handleUpdate(command("/deploy acme/hello"));
    await bot.handleUpdate(railpack(sent));
    await bot.handleUpdate(press(wizard(sent), "solix-web"));
    await bot.handleUpdate(press(wizard(sent), "dev"));
    expect(buttons(wizard(sent)).map((b) => b.text)).toContain("hello-dev.example.test (추천)");
  });

  test("existing project + new environment via button creates the environment there", async () => {
    const { bot, dk, sent, idle } = await setup();
    const project = dk.addProject("solix-web", ["production"]);
    await bot.handleUpdate(command("/deploy acme/hello"));
    await bot.handleUpdate(railpack(sent));
    await bot.handleUpdate(press(wizard(sent), "solix-web"));
    let w = wizard(sent);
    expect(bodyOf(w)).toContain("어느 환경(environment)에 올릴까?");
    expect(buttons(w).find((b) => b.text === "production (기본)")?.style).toBe("primary");
    await bot.handleUpdate(press(w, "＋ staging"));
    await bot.handleUpdate(press(wizard(sent), "도메인 없이"));
    w = wizard(sent);
    expect(bodyOf(w)).toContain("<td><b>환경</b></td><td><b>staging</b> <i>(새로 만듦)</i></td>");
    expect(bodyOf(w)).toContain("<td><b>도메인</b></td><td>없음</td>");
    await bot.handleUpdate(press(w, "배포하기"));
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
    await bot.handleUpdate(command("/deploy acme/hello"));
    await bot.handleUpdate(railpack(sent));
    await bot.handleUpdate(press(wizard(sent), "이름 직접 입력"));
    const prompt = outbound(sent, forceReply);
    expect(prompt?.payload.reply_markup).toMatchObject({ force_reply: true });
    expect(buttons(prompt).map((b) => b.text)).toEqual(["취소"]);
    await bot.handleUpdate(reply("Bad Name!!"));
    expect(bodyOf(outbound(sent))).toContain("영문 소문자");
    await bot.handleUpdate(reply("Team-Apps"));
    expect(sent.some((s) => s.method === "deleteMessage")).toBe(true);
    await bot.handleUpdate(press(wizard(sent), "직접 입력"));
    await bot.handleUpdate(reply("dev"));
    await bot.handleUpdate(press(wizard(sent), "직접 입력"));
    await bot.handleUpdate(reply("my-api"));
    expect(sent.some((s) => s.method === "setMessageReaction")).toBe(true);
    await bot.handleUpdate(press(wizard(sent), "배포하기"));
    await idle();
    expect(dk.paths()).not.toContain("project.create");
    expect(dk.paths()).not.toContain("environment.create");
    expect(dk.calls.find((c) => c.path === "application.create")?.body.environmentId).toBe(project.envs[1]?.environmentId);
    expect(dk.calls.find((c) => c.path === "domain.create")?.body).toMatchObject({ host: "my-api.example.test" });
  });

  test("in groups the typed-input prompt is a selective force reply that mentions the user", async () => {
    const { bot, sent } = await setup();
    await bot.handleUpdate(command("/deploy acme/hello", STRANGER_ID, group(GROUP_ID)));
    await bot.handleUpdate(press(wizard(sent), /Railpack/, STRANGER_ID, group(GROUP_ID)));
    await bot.handleUpdate(press(wizard(sent), "이름 직접 입력", STRANGER_ID, group(GROUP_ID)));
    const prompt = outbound(sent, forceReply);
    expect(prompt?.payload.reply_markup).toMatchObject({ force_reply: true, selective: true });
    expect(bodyOf(prompt)).toContain(`tg://user?id=${STRANGER_ID}`);
  });

  test("another user cannot drive someone else's wizard; cancel ends it", async () => {
    const { bot, dk, sent } = await setup();
    await bot.handleUpdate(command("/deploy acme/hello", STRANGER_ID, group(GROUP_ID)));
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
    const picker = outbound(sent, (s) => buttons(s).length > 0);
    expect(bodyOf(picker)).toContain("어떤 서비스를 업데이트할까?");
    expect(buttons(picker).map((b) => b.text)).toEqual(["acme/hello · production", "acme/hello-api · staging"]);

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
    const logBtn = buttons(final).find((b) => b.text === "빌드 로그");
    await bot.handleUpdate(click(logBtn?.callback_data ?? ""));
    expect(bodyOf(outbound(sent))).toContain("빌드 로그");
  });

  test("/logs shows runtime logs with refresh", async () => {
    const { bot, dk, sent } = await setup();
    const p = dk.addProject("team");
    dk.addApp("hello", p.envs[0]?.environmentId ?? "");
    await bot.handleUpdate(command("/logs hello"));
    const msg = outbound(sent);
    expect(bodyOf(msg)).toContain("listening on :3000");
    expect(bodyOf(msg)).not.toContain("sha256:");
    expect(buttons(msg).map((b) => b.text)).toEqual(["새로고침", "Dokploy"]);
  });

  test("/deploy of an already managed repo still starts the wizard and offers update shortcuts", async () => {
    const { bot, dk, sent } = await setup();
    const p = dk.addProject("team");
    dk.addApp("hello", p.envs[0]?.environmentId ?? "");
    await bot.handleUpdate(command("/deploy https://github.com/acme/hello"));
    expect(wizard(sent)).toBeDefined();
    const shortcut = outbound(sent, (s) => bodyOf(s).includes("이미 1곳에 배포돼"));
    expect(buttons(shortcut).map((b) => b.callback_data)).toEqual([`run:u:a:id-hello-${p.envs[0]?.environmentId}`]);
    expect(dk.paths()).not.toContain("application.create");
  });

  test("every message of a deploy started inside a forum topic stays in that topic", async () => {
    const { bot, dk, sent, idle } = await setup();
    const inGroup = group(GROUP_ID);
    await bot.handleUpdate(command("/deploy acme/hello", OWNER_ID, inGroup, true));
    let w = wizard(sent);
    await bot.handleUpdate(press(w, /Railpack/, OWNER_ID, inGroup, true));
    await bot.handleUpdate(press(wizard(sent), "새 프로젝트: hello (추천)", OWNER_ID, inGroup, true));
    await bot.handleUpdate(press(wizard(sent), "도메인 없이", OWNER_ID, inGroup, true));
    await bot.handleUpdate(press(wizard(sent), "배포하기", OWNER_ID, inGroup, true));
    await idle();
    const outgoing = sent.filter((s) => ["sendMessage", "sendRichMessage"].includes(s.method) && s.payload.chat_id === GROUP_ID);
    expect(outgoing.length).toBeGreaterThanOrEqual(3);
    for (const s of outgoing) expect({ method: s.method, thread: s.payload.message_thread_id }).toEqual({ method: s.method, thread: TOPIC });
    expect(dk.paths()).toContain("application.deploy");
  });

  test("a deploy started in General (no topic) sends no thread id", async () => {
    const { bot, sent, idle } = await setup();
    const inGroup = group(GROUP_ID);
    await bot.handleUpdate(command("/deploy acme/hello", OWNER_ID, inGroup));
    await bot.handleUpdate(press(wizard(sent), /Railpack/, OWNER_ID, inGroup));
    await bot.handleUpdate(press(wizard(sent), "새 프로젝트: hello (추천)", OWNER_ID, inGroup));
    await bot.handleUpdate(press(wizard(sent), "도메인 없이", OWNER_ID, inGroup));
    await bot.handleUpdate(press(wizard(sent), "배포하기", OWNER_ID, inGroup));
    await idle();
    const outgoing = sent.filter((s) => ["sendMessage", "sendRichMessage"].includes(s.method) && s.payload.chat_id === GROUP_ID);
    expect(outgoing.length).toBeGreaterThanOrEqual(3);
    for (const s of outgoing) expect(s.payload.message_thread_id).toBeUndefined();
  });

  test("any member of an allowed group can use the bot there", async () => {
    const { bot, dk, sent } = await setup();
    await bot.handleUpdate(command("/deploy@deploy_bot https://github.com/acme/hello", STRANGER_ID, group(GROUP_ID)));
    expect(bodyOf(wizard(sent))).toContain("어떻게 빌드할까?");
    expect(dk.paths()).toContain("project.all");
  });

  test("other groups are rejected even for allowed users, and the reply shows the group id", async () => {
    const { bot, dk, sent } = await setup();
    await bot.handleUpdate(command("/deploy https://github.com/acme/hello", OWNER_ID, group(OTHER_GROUP_ID)));
    expect(bodyOf(sent[0])).toContain(String(OTHER_GROUP_ID));
    expect(dk.calls).toEqual([]);
  });

  test("plain group chatter from a non-allowed group gets no reply", async () => {
    const { bot, sent } = await setup();
    await bot.handleUpdate({ update_id: ++updateId, message: { message_id: ++updateId, date: 0, chat: group(OTHER_GROUP_ID), from: from(OWNER_ID), text: "hello" } } as Update);
    expect(sent).toEqual([]);
  });

  test("unauthorized users are rejected and nothing reaches Dokploy", async () => {
    const { bot, dk, sent } = await setup();
    await bot.handleUpdate(command("/deploy https://github.com/acme/hello", STRANGER_ID));
    await bot.handleUpdate(click("run:u:a:id-hello", STRANGER_ID));
    expect(bodyOf(sent[0])).toContain(String(STRANGER_ID));
    expect(sent.find((s) => s.method === "answerCallbackQuery")?.payload).toMatchObject({ text: "권한 없음" });
    expect(dk.calls).toEqual([]);
  });

  test("admin /allow persists a user who can then use DMs; /disallow revokes", async () => {
    const { bot, dk, sent, accessFile, cfg } = await setup();
    await bot.handleUpdate(command("/list", STRANGER_ID));
    expect(dk.calls).toEqual([]);

    await bot.handleUpdate(command(`/allow ${STRANGER_ID}`, ADMIN_ID));
    expect(bodyOf(sent.at(-1))).toContain("허용했어");
    expect(await Bun.file(accessFile).json()).toEqual({ users: [STRANGER_ID], chats: [] });

    const reloaded = await Access.load(accessFile, cfg.allowedUserIds, cfg.adminUserIds, cfg.allowedChatIds);
    expect(reloaded.isUser(STRANGER_ID)).toBe(true);

    await bot.handleUpdate(command("/list", STRANGER_ID));
    expect(dk.paths()).toContain("application.search");
    expect(lastWith(sent, (s) => s.method === "sendRichMessage" || s.method === "sendMessage")).toBeDefined();

    await bot.handleUpdate(command(`/disallow ${STRANGER_ID}`, ADMIN_ID));
    expect(await Bun.file(accessFile).json()).toEqual({ users: [], chats: [] });
    const callsBefore = dk.calls.length;
    await bot.handleUpdate(command("/list", STRANGER_ID));
    expect(dk.calls.length).toBe(callsBefore);
  });

  test("non-admins cannot /allow, even allowed users", async () => {
    const { bot, sent, accessFile } = await setup();
    await bot.handleUpdate(command(`/allow ${STRANGER_ID}`, OWNER_ID));
    expect(bodyOf(sent.at(-1))).toContain("관리자만");
    expect(await Bun.file(accessFile).exists()).toBe(false);
  });

  test("/allow as a reply in an allowed group targets the replied user", async () => {
    const { bot, sent, accessFile } = await setup();
    const update = command("/allow", ADMIN_ID, group(GROUP_ID)) as Update & { message: Record<string, unknown> };
    update.message.reply_to_message = { message_id: 1, date: 0, chat: group(GROUP_ID), from: from(STRANGER_ID), text: "hi", reply_to_message: undefined };
    await bot.handleUpdate(update);
    expect(bodyOf(sent.at(-1))).toContain(`${STRANGER_ID} 허용했어`);
    expect(await Bun.file(accessFile).json()).toEqual({ users: [STRANGER_ID], chats: [] });
  });

  test("denied DM notifies admins once with an approve button that grants access", async () => {
    const { bot, sent, accessFile } = await setup();
    await bot.handleUpdate(command("/start", STRANGER_ID));
    await bot.handleUpdate(command("/deploy x/y", STRANGER_ID));
    const requests = sent.filter((s) => isOutbound(s) && s.payload.chat_id === ADMIN_ID);
    expect(requests).toHaveLength(1);
    const approve = buttons(requests[0]).find((b) => b.text === "허용");
    expect(approve).toMatchObject({ callback_data: `acl:add:${STRANGER_ID}`, style: "success" });

    await bot.handleUpdate(click(approve?.callback_data ?? "", OWNER_ID));
    expect(await Bun.file(accessFile).exists()).toBe(false);

    await bot.handleUpdate(click(approve?.callback_data ?? "", ADMIN_ID));
    expect(await Bun.file(accessFile).json()).toEqual({ users: [STRANGER_ID], chats: [] });
    const settled = lastWith(sent, (s) => s.method === "editMessageText");
    expect(bodyOf(settled)).toContain("허용함");
    expect(buttons(settled)).toEqual([]);
    expect(sent.at(-1)).toMatchObject({ payload: { chat_id: STRANGER_ID } });
    expect(isOutbound(sent.at(-1) as Sent)).toBe(true);
  });

  test("an admin can allow and revoke a group from inside it, and the choice survives a reload", async () => {
    const { bot, sent, accessFile, cfg } = await setup();
    await bot.handleUpdate(command("/list", STRANGER_ID, group(OTHER_GROUP_ID)));
    expect(bodyOf(outbound(sent))).toContain(String(OTHER_GROUP_ID));

    await bot.handleUpdate(command("/allowgroup", OWNER_ID, group(OTHER_GROUP_ID)));
    expect(bodyOf(outbound(sent))).toContain("이 그룹에서는 쓸 수 없어");
    expect(await Bun.file(accessFile).exists()).toBe(false);
    await bot.handleUpdate(command("/allowgroup", OWNER_ID, group(GROUP_ID)));
    expect(bodyOf(outbound(sent))).toContain("관리자만");
    expect(await Bun.file(accessFile).exists()).toBe(false);

    await bot.handleUpdate(command("/allowgroup", ADMIN_ID, group(OTHER_GROUP_ID)));
    expect(bodyOf(outbound(sent))).toContain("그룹을 허용했어");
    expect(await Bun.file(accessFile).json()).toEqual({ users: [], chats: [OTHER_GROUP_ID] });

    await bot.handleUpdate(command("/deploy acme/hello", STRANGER_ID, group(OTHER_GROUP_ID)));
    expect(wizard(sent)).toBeDefined();

    const reloaded = await Access.load(accessFile, cfg.allowedUserIds, cfg.adminUserIds, cfg.allowedChatIds);
    expect(reloaded.isChatAllowed(OTHER_GROUP_ID)).toBe(true);
    expect(reloaded.isChatAllowed(GROUP_ID)).toBe(true);

    await bot.handleUpdate(command(`/disallowgroup ${GROUP_ID}`, ADMIN_ID));
    expect(bodyOf(outbound(sent))).toContain("ALLOWED_CHAT_IDS");
    await bot.handleUpdate(command(`/disallowgroup ${OTHER_GROUP_ID}`, ADMIN_ID));
    expect(bodyOf(outbound(sent))).toContain("허용을 취소했어");
    expect(await Bun.file(accessFile).json()).toEqual({ users: [], chats: [] });
  });

  test("a custom domain behind Cloudflare is created without https, and a directly connected one gets Let's Encrypt", async () => {
    for (const [ip, expected] of [
      ["104.21.91.175", { https: false, certificateType: "none" }],
      ["203.0.113.10", { https: true, certificateType: "letsencrypt" }],
    ] as const) {
      const { bot, dk, sent, idle } = await setup();
      dnsTable["shop.example.org"] = [ip];
      await bot.handleUpdate(command("/deploy acme/hello"));
      await bot.handleUpdate(railpack(sent));
      await bot.handleUpdate(press(wizard(sent), /^새 프로젝트/));
      await bot.handleUpdate(press(wizard(sent), "직접 입력"));
      await bot.handleUpdate(reply("shop.example.org"));
      await bot.handleUpdate(press(wizard(sent), "배포하기"));
      await idle();
      expect(dk.calls.find((c) => c.path === "domain.create")?.body).toMatchObject({ host: "shop.example.org", ...expected });
    }
  });
});
