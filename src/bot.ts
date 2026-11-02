import { Bot, type Context, InlineKeyboard } from "grammy";
import { analyzeRepo, type BuildPlan, normalizeDomain, subdomainFor } from "./analyze.ts";
import type { Access } from "./access.ts";
import type { Config } from "./config.ts";
import type { Deployer, DeployResult, ManagedService, ProjectInfo, Reporter, RunOutcome, Target } from "./deployer.ts";
import { type GitHub, parseRepoUrl, type RepoInfo, repoKey } from "./github.ts";

type Step = "project" | "env" | "domain" | "confirm";
type Awaiting = "project" | "env" | "domain" | null;

interface Wizard {
  userId: number;
  chatId: number;
  messageId: number;
  repo: RepoInfo;
  files: string[];
  plan: BuildPlan;
  projects: ProjectInfo[];
  step: Step;
  awaiting: Awaiting;
  target: Target | null;
  domain: string | null | undefined;
  dnsOk: boolean | null;
  createdAt: number;
}

type Mode = "update" | "redeploy";

export interface BotDeps {
  cfg: Config;
  access: Access;
  deployer: Deployer;
  gh: GitHub;
}

const WIZARD_TTL_MS = 30 * 60_000;
const MAX_PICKER_ITEMS = 20;
const MAX_MESSAGE = 3800;
const LIVE_EDIT_MS = 4000;
const LOG_BLOCK_CHARS = 2800;
const SUCCESS_EFFECT_ID = "5046509860389126442";

export const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const code = (s: string) => `<code>${esc(s)}</code>`;
const bold = (s: string) => `<b>${esc(s)}</b>`;
const clipTail = (s: string, max: number) => (s.length > max ? `…${s.slice(s.length - max)}` : s);
const HTML = { parse_mode: "HTML" as const, link_preview_options: { is_disabled: true } };

export function logBlock(log: string, max = LOG_BLOCK_CHARS): string {
  const cleaned = log.replace(/\x1b\[[0-9;]*m/g, "").replace(/\r/g, "").trimEnd();
  return `<blockquote expandable>${esc(clipTail(cleaned, max))}</blockquote>`;
}

export function isAllowed(
  chat: { id: number; type: string } | undefined,
  userId: number | undefined,
  access: Pick<Access, "isUser">,
  allowedChatIds: ReadonlySet<number>,
): boolean {
  if (!chat || userId === undefined) return false;
  if (chat.type === "private") return access.isUser(userId);
  if (chat.type === "group" || chat.type === "supergroup") return allowedChatIds.has(chat.id);
  return false;
}

function parseUserId(text: string): number | null {
  const id = Number(text.trim());
  return text.trim() && Number.isSafeInteger(id) && id > 0 ? id : null;
}

const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,62}$/;

export function normalizeName(input: string): string | null {
  const name = input.trim().toLowerCase().replace(/\s+/g, "-");
  return NAME_RE.test(name) ? name : null;
}

export function suggestProjectName(repo: RepoInfo): string {
  return normalizeName(subdomainFor(repo.repo)) ?? "deploy-bot";
}

function describePlan(plan: BuildPlan, railpackVersion: string): string {
  if (plan.kind === "compose") {
    return `Docker Compose ${code(plan.composePath)} · 도메인 → ${bold(plan.serviceName)} (전체 ${plan.services.length}개)`;
  }
  if (plan.buildType === "dockerfile") return `Dockerfile ${code(plan.dockerfile ?? "Dockerfile")}`;
  return `Railpack v${esc(railpackVersion)} <i>(실패하면 AI가 Dockerfile 생성)</i>`;
}

const STEPS: { key: Step; label: string }[] = [
  { key: "project", label: "프로젝트" },
  { key: "env", label: "환경" },
  { key: "domain", label: "도메인" },
  { key: "confirm", label: "확인" },
];

function stepBar(step: Step): string {
  const at = STEPS.findIndex((s) => s.key === step);
  return STEPS.map((s, i) => (i < at ? `✓ ${s.label}` : i === at ? `<b>● ${s.label}</b>` : `○ ${s.label}`)).join("  ");
}

export function wizardText(w: Wizard, cfg: Pick<Config, "https" | "railpackVersion">): string {
  const lines = [
    `📦 ${bold(`${w.repo.owner}/${w.repo.repo}`)} · ${code(w.repo.defaultBranch)}`,
    `빌드: ${describePlan(w.plan, cfg.railpackVersion)} · 포트 ${w.plan.port}`,
    "",
    stepBar(w.step),
    "",
  ];
  if (w.target) lines.push(`📁 프로젝트 ${bold(w.target.projectName)}${w.target.projectId ? "" : " <i>(새로 만듦)</i>"}`);
  if (w.target && w.step !== "env") {
    lines.push(`🌱 환경 ${bold(w.target.environmentName)}${w.target.environmentId ? "" : " <i>(새로 만듦)</i>"}`);
  }
  if (w.domain !== undefined) {
    lines.push(`🌐 도메인 ${w.domain ? code(`${cfg.https ? "https" : "http"}://${w.domain}`) : "없음"}`);
  }
  for (const warning of w.plan.warnings) lines.push(`⚠️ ${esc(warning)}`);
  if (w.domain && w.dnsOk === false) lines.push(`⚠️ ${code(w.domain)} DNS가 아직 안 잡혀 있어. 서버 IP로 A 레코드를 걸어야 접속돼`);
  lines.push("");
  if (w.step === "project") lines.push(w.awaiting === "project" ? "✏️ 새 프로젝트 이름을 답장으로 보내줘" : "어느 Dokploy 프로젝트에 올릴까?");
  if (w.step === "env") lines.push(w.awaiting === "env" ? "✏️ 새 환경 이름을 답장으로 보내줘" : "어느 환경(environment)에 올릴까?");
  if (w.step === "domain") lines.push(w.awaiting === "domain" ? "✏️ 도메인을 답장으로 보내줘" : "도메인은 어떻게 할까?");
  if (w.step === "confirm") lines.push("이대로 올릴까?");
  return lines.join("\n");
}

function resultText(result: DeployResult & { dashboard: string }): string {
  const name = `${result.service.repo}`;
  const where = `${result.service.projectName} / ${result.service.environmentName}`;
  if (result.status === "done") {
    const lines = [`✅ ${bold(name)} 배포 완료`, `📁 ${esc(where)} · ${code(result.service.appName)}`];
    if (result.url) lines.push(`🌐 ${esc(result.url)}`);
    if (result.usedAiDockerfile) lines.push("🤖 AI가 만든 <code>Dockerfile.deploy-bot</code>으로 빌드했어 (Dokploy Patches에서 수정 가능)");
    return lines.join("\n");
  }
  const reason = result.status === "timeout" ? "시간 초과 (Dokploy에서 계속 진행 중일 수 있음)" : result.status;
  const lines = [`❌ ${bold(name)} 배포 실패 · ${esc(reason)}`, `📁 ${esc(where)}`];
  if (result.logTail) lines.push("", "빌드 로그 끝부분", logBlock(result.logTail));
  return lines.join("\n");
}

function resultKeyboard(result: DeployResult & { dashboard: string }): InlineKeyboard {
  const k = result.service.kind === "application" ? "a" : "c";
  const kb = new InlineKeyboard();
  if (result.status === "done" && result.url) kb.url("🌐 열기", result.url).style("success");
  kb.url("🧭 Dokploy", result.dashboard);
  if (result.url) kb.copyText("📋 URL 복사", result.url);
  kb.row();
  if (result.deploymentId) kb.text("📜 빌드 로그", `log:b:${k}:${result.service.id}:${result.deploymentId}`);
  kb.text("🖥 실행 로그", `log:r:${k}:${result.service.id}`);
  kb.row();
  kb.text("⬇️ 업데이트", `run:u:${k}:${result.service.id}`).text("🔁 다시 빌드", `run:r:${k}:${result.service.id}`);
  if (result.status !== "done") kb.style("danger");
  return kb;
}

class LiveStatus implements Reporter {
  private steps: string[] = [];
  private logTail: string | null = null;
  private messageId: number | null = null;
  private lastEdit = 0;
  private chain: Promise<unknown> = Promise.resolve();
  private lastText = "";

  constructor(
    private readonly api: Context["api"],
    private readonly chatId: number,
    private readonly header: string,
    private readonly now: () => number = Date.now,
  ) {}

  private render() {
    const body = [this.header, ...this.steps.map((s, i) => (i === this.steps.length - 1 ? `⏳ ${esc(s)}` : `✓ ${esc(s)}`))];
    if (this.logTail) body.push("", logBlock(this.logTail, 1200));
    return body.join("\n").slice(0, MAX_MESSAGE);
  }

  private flush(force: boolean) {
    const text = this.render();
    if (text === this.lastText) return this.chain.then(() => undefined);
    if (!force && this.messageId !== null && this.now() - this.lastEdit < LIVE_EDIT_MS) return this.chain.then(() => undefined);
    this.lastText = text;
    this.lastEdit = this.now();
    this.chain = this.chain.then(async () => {
      if (this.messageId === null) {
        const msg = await this.api.sendMessage(this.chatId, text, HTML);
        this.messageId = msg.message_id;
      } else {
        await this.api.editMessageText(this.chatId, this.messageId, text, HTML).catch(() => undefined);
      }
    });
    return this.chain.then(() => undefined);
  }

  step = (line: string) => {
    this.steps.push(line);
    return this.flush(true);
  };

  log = (tail: string) => {
    this.logTail = tail;
    return this.flush(false);
  };

  async remove() {
    await this.chain;
    if (this.messageId !== null) await this.api.deleteMessage(this.chatId, this.messageId).catch(() => undefined);
  }
}

export function createBot({ cfg, access, deployer, gh }: BotDeps, bot = new Bot(cfg.telegramToken)) {
  const wizards = new Map<string, Wizard>();
  const notifiedRequests = new Set<number>();
  const busy = new Set<string>();
  const jobs = new Set<Promise<void>>();
  let seq = 0;

  const notifyAdmins = async (ctx: Context, userId: number) => {
    if (notifiedRequests.has(userId)) return;
    notifiedRequests.add(userId);
    const u = ctx.from;
    const who = [u?.first_name, u?.last_name].filter(Boolean).join(" ") + (u?.username ? ` (@${u.username})` : "");
    const keyboard = new InlineKeyboard().text("✅ 허용", `acl:add:${userId}`).success().text("무시", `acl:ignore:${userId}`);
    for (const admin of access.list().admins) {
      await ctx.api
        .sendMessage(admin, `🔐 접근 요청: ${esc(who || "이름 없음")} · ID ${code(String(userId))}`, { ...HTML, reply_markup: keyboard })
        .catch((error: unknown) => console.warn(`[deploy-bot] could not notify admin ${admin}:`, error instanceof Error ? error.message : error));
    }
  };

  const prune = () => {
    const now = Date.now();
    for (const [token, w] of wizards) if (now - w.createdAt > WIZARD_TTL_MS) wizards.delete(token);
  };

  const background = (ctx: Context, work: () => Promise<void>) => {
    const job = work()
      .catch(async (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        console.error("[deploy-bot]", error);
        await ctx.reply(`❌ 오류: ${esc(message).slice(0, MAX_MESSAGE)}`, HTML).catch(() => undefined);
      })
      .finally(() => jobs.delete(job));
    jobs.add(job);
  };

  const react = (ctx: Context, emoji: "👀" | "👍" | "🔥") => ctx.react(emoji).catch(() => undefined);

  bot.use(async (ctx, next) => {
    const id = ctx.from?.id;
    const isCommand = ctx.message?.entities?.[0]?.type === "bot_command" && ctx.message.entities[0].offset === 0;
    if (isAllowed(ctx.chat, id, access, cfg.allowedChatIds)) {
      if (isCommand) console.log(`[deploy-bot] cmd ${ctx.message?.text?.split(" ")[0]} chat=${ctx.chat?.id} user=${id}`);
      return next();
    }
    if (ctx.callbackQuery || isCommand) console.warn(`[deploy-bot] denied chat=${ctx.chat?.id} type=${ctx.chat?.type} user=${id}`);
    if (ctx.callbackQuery) {
      await ctx.answerCallbackQuery({ text: "권한 없음" });
    } else if (isCommand && ctx.chat?.type === "private") {
      await ctx.reply(`⛔ 권한이 없어. 관리자에게 접근 요청을 보냈어. 내 ID: ${id ?? "unknown"}`);
      if (id !== undefined) await notifyAdmins(ctx, id);
    } else if (isCommand && ctx.chat) {
      await ctx.reply(`⛔ 이 그룹에서는 쓸 수 없어. 그룹 ID: ${ctx.chat.id}`);
    }
  });

  bot.command(["start", "help"], (ctx) =>
    ctx.reply(
      [
        "🚀 <b>Dokploy 배포 봇</b>",
        "",
        "/deploy <code>&lt;github url&gt;</code> 새로 배포 (프로젝트·환경·도메인 골라서)",
        "/update <code>[레포]</code> GitHub 최신 코드로 다시 배포",
        "/redeploy <code>[레포]</code> 코드 그대로 다시 빌드",
        "/logs <code>[레포]</code> 실행 로그 보기",
        "/list 관리 중인 서비스",
        "",
        "<i>레포 이름은 일부만 쳐도 되고, 비워두면 버튼으로 골라.</i>",
        ...(access.isAdmin(ctx.from?.id)
          ? ["", "👑 <b>관리자</b>", "/allow <code>&lt;유저ID&gt;</code> DM 허용 (그룹에서 답장으로 /allow 도 됨)", "/disallow <code>&lt;유저ID&gt;</code> 허용 취소", "/allowed 허용 목록"]
          : []),
      ].join("\n"),
      HTML,
    ),
  );

  const adminOnly = async (ctx: Context) => {
    if (access.isAdmin(ctx.from?.id)) return true;
    await ctx.reply("⛔ 관리자만 쓸 수 있어");
    return false;
  };

  const targetOf = (ctx: Context & { match: string }) => {
    const replied = ctx.message?.reply_to_message?.from;
    return parseUserId(ctx.match) ?? (replied && !replied.is_bot ? replied.id : null);
  };

  bot.command("allow", async (ctx) => {
    if (!(await adminOnly(ctx))) return;
    const target = targetOf(ctx);
    if (target === null) return ctx.reply("사용법: /allow <유저ID> 또는 그 사람 메시지에 답장으로 /allow");
    const result = await access.add(target);
    console.log(`[deploy-bot] allow user=${target} by=${ctx.from?.id} result=${result}`);
    return ctx.reply(result === "added" ? `✅ ${target} 허용했어. 이제 DM으로 봇을 쓸 수 있어` : `${target}는 이미 허용돼 있어`);
  });

  bot.command("disallow", async (ctx) => {
    if (!(await adminOnly(ctx))) return;
    const target = targetOf(ctx);
    if (target === null) return ctx.reply("사용법: /disallow <유저ID>");
    const result = await access.remove(target);
    console.log(`[deploy-bot] disallow user=${target} by=${ctx.from?.id} result=${result}`);
    const messages = {
      removed: `🚫 ${target} 허용 취소했어`,
      env: `${target}는 .env의 ALLOWED_USER_IDS에 있어서 봇에서는 못 빼. .env에서 지우고 재시작해줘`,
      admin: `${target}는 관리자라서 못 빼 (ADMIN_USER_IDS)`,
      missing: `${target}는 허용 목록에 없어`,
    } as const;
    return ctx.reply(messages[result]);
  });

  bot.command("allowed", async (ctx) => {
    if (!(await adminOnly(ctx))) return;
    const { admins, env, added } = access.list();
    const fmt = (ids: number[]) => (ids.length ? ids.join(", ") : "없음");
    return ctx.reply(
      [`관리자: ${fmt(admins)}`, `.env 허용: ${fmt(env)}`, `봇으로 추가: ${fmt(added)}`, `허용 그룹: ${fmt([...cfg.allowedChatIds])}`].join("\n"),
    );
  });

  bot.callbackQuery(/^acl:(add|ignore):(\d+)$/, async (ctx) => {
    if (!access.isAdmin(ctx.from.id)) {
      await ctx.answerCallbackQuery({ text: "관리자만 가능" });
      return;
    }
    const [, action, raw = ""] = ctx.match;
    const target = Number(raw);
    await ctx.editMessageReplyMarkup().catch(() => undefined);
    if (action === "ignore") {
      await ctx.answerCallbackQuery({ text: "무시했어" });
      return;
    }
    const result = await access.add(target);
    console.log(`[deploy-bot] allow user=${target} by=${ctx.from.id} result=${result} via=request`);
    await ctx.answerCallbackQuery({ text: result === "added" ? "허용했어" : "이미 허용돼 있어" });
    await ctx.api.sendMessage(target, "✅ 관리자가 허용했어. /help 로 사용법 확인해").catch(() => undefined);
  });

  const statusIcon = (s: string) => ({ done: "🟢", running: "🟡", error: "🔴", idle: "⚪️" })[s] ?? "⚪️";

  bot.command("list", async (ctx) => {
    const services = await deployer.listManaged();
    if (services.length === 0) return ctx.reply("아직 봇으로 배포한 서비스가 없어. /deploy <github url>");
    const groups = new Map<string, ManagedService[]>();
    for (const s of services) {
      const key = `${s.projectName} / ${s.environmentName}`;
      groups.set(key, [...(groups.get(key) ?? []), s]);
    }
    const lines: string[] = ["📋 <b>관리 중인 서비스</b>"];
    for (const [key, items] of groups) {
      lines.push("", `📁 ${bold(key)}`);
      for (const s of items) lines.push(`${statusIcon(s.status)} ${esc(s.repo)} <i>${s.kind === "compose" ? "compose" : "app"}</i>`);
    }
    return ctx.reply(lines.join("\n").slice(0, MAX_MESSAGE), HTML);
  });

  const wizardKeyboard = (token: string, w: Wizard): InlineKeyboard => {
    const kb = new InlineKeyboard();
    if (w.awaiting) return kb.text("↩️ 버튼으로 고르기", `wz:${token}:back:${w.step}`).text("취소", `wz:${token}:cancel`).danger();
    if (w.step === "project") {
      const suggested = suggestProjectName(w.repo);
      const exists = w.projects.some((p) => p.name === suggested);
      if (!exists) kb.text(`✨ 새로 만들기: ${suggested}`, `wz:${token}:pnew`).primary().row();
      const listed = w.projects.slice(0, 10);
      listed.forEach((p, i) => {
        kb.text(`📁 ${p.name}`, `wz:${token}:p:${p.projectId}`);
        if (p.name === suggested) kb.primary();
        if (i % 2 === 1) kb.row();
      });
      if (listed.length % 2 === 1) kb.row();
      kb.text("✏️ 이름 직접 입력", `wz:${token}:ptype`).text("취소", `wz:${token}:cancel`).danger();
    } else if (w.step === "env") {
      const project = w.projects.find((p) => p.projectId === w.target?.projectId);
      const envs = project?.environments ?? [];
      const names = new Set(envs.map((e) => e.name));
      if (envs.length === 0) kb.text("🌱 production", `wz:${token}:enew:production`).primary();
      envs.forEach((e, i) => {
        kb.text(`🌱 ${e.name}${e.isDefault ? " (기본)" : ""}`, `wz:${token}:e:${e.environmentId}`);
        if (e.isDefault) kb.primary();
        if (i % 2 === 1) kb.row();
      });
      kb.row();
      for (const extra of ["staging", "dev"].filter((n) => !names.has(n))) kb.text(`＋ ${extra}`, `wz:${token}:enew:${extra}`);
      kb.text("✏️ 직접 입력", `wz:${token}:etype`).row();
      kb.text("⬅️ 뒤로", `wz:${token}:back:project`).text("취소", `wz:${token}:cancel`).danger();
    } else if (w.step === "domain") {
      const suggested = `${subdomainFor(w.repo.repo)}.${cfg.baseDomain}`;
      kb.text(`🌐 ${suggested}`, `wz:${token}:dsug`).primary().row();
      kb.text("✏️ 직접 입력", `wz:${token}:dtype`).text("🚫 도메인 없이", `wz:${token}:dnone`).row();
      kb.text("⬅️ 뒤로", `wz:${token}:back:env`).text("취소", `wz:${token}:cancel`).danger();
    } else {
      kb.text("🚀 배포하기", `wz:${token}:go`).success().row();
      kb.text("⬅️ 뒤로", `wz:${token}:back:domain`).text("취소", `wz:${token}:cancel`).danger();
    }
    return kb;
  };

  const render = async (ctx: Context, token: string, w: Wizard) => {
    await ctx.api
      .editMessageText(w.chatId, w.messageId, wizardText(w, cfg), { ...HTML, reply_markup: wizardKeyboard(token, w) })
      .catch((error: unknown) => {
        if (!String(error).includes("message is not modified")) throw error;
      });
  };

  bot.command("deploy", async (ctx) => {
    const ref = parseRepoUrl(ctx.match);
    if (!ref) return ctx.reply("사용법: /deploy https://github.com/owner/repo");
    const userId = ctx.from?.id;
    if (userId === undefined) return;
    await react(ctx, "👀");

    const status = await ctx.reply(`🔍 ${bold(`${ref.owner}/${ref.repo}`)} 분석 중...`, HTML);
    await ctx.replyWithChatAction("typing").catch(() => undefined);
    const [repo, projects, existing] = await Promise.all([gh.repo(ref), deployer.listProjects(), deployer.findByRepo(ref)]);
    const files = await gh.treeBlobs(repo, repo.defaultBranch);
    const plan = await analyzeRepo(files, (path) => gh.fileOrNull(repo, repo.defaultBranch, path));

    prune();
    const token = (++seq).toString(36);
    const w: Wizard = {
      userId,
      chatId: ctx.chat.id,
      messageId: status.message_id,
      repo,
      files,
      plan,
      projects,
      step: "project",
      awaiting: null,
      target: null,
      domain: undefined,
      dnsOk: null,
      createdAt: Date.now(),
    };
    wizards.set(token, w);
    await render(ctx, token, w);
    if (existing.length > 0) {
      const kb = new InlineKeyboard();
      for (const s of existing.slice(0, 5)) {
        const k = s.kind === "application" ? "a" : "c";
        kb.text(`⬇️ ${s.projectName}/${s.environmentName} 업데이트`, `run:u:${k}:${s.id}`).row();
      }
      await ctx.reply(`ℹ️ 이 레포는 이미 ${existing.length}곳에 배포돼 있어. 새로 만드는 대신 업데이트할 수도 있어.`, { reply_markup: kb });
    }
  });

  const owned = async (ctx: Context & { from: { id: number } }, token: string) => {
    const w = wizards.get(token);
    if (!w || w.userId !== ctx.from.id) {
      await ctx.answerCallbackQuery({ text: w ? "이 배포는 다른 사람이 진행 중이야" : "만료됐어. /deploy 다시 해줘" });
      return null;
    }
    return w;
  };

  const chooseProject = (w: Wizard, target: { projectId: string | null; projectName: string }) => {
    w.target = { ...target, environmentId: null, environmentName: "production" };
    w.step = "env";
    w.awaiting = null;
    if (!target.projectId) {
      w.target.environmentName = "production";
      w.step = "domain";
    }
  };

  const chooseDomain = async (w: Wizard, domain: string | null) => {
    w.domain = domain;
    w.dnsOk = domain ? await deployer.domainResolves(domain) : null;
    w.step = "confirm";
    w.awaiting = null;
  };

  bot.callbackQuery(/^wz:([a-z0-9]+):([a-z]+)(?::(.+))?$/, async (ctx) => {
    const [, token = "", action = "", arg = ""] = ctx.match;
    const w = await owned(ctx, token);
    if (!w) return;

    if (action === "cancel") {
      wizards.delete(token);
      await ctx.answerCallbackQuery({ text: "취소했어" });
      await ctx.editMessageText(`🚫 ${bold(`${w.repo.owner}/${w.repo.repo}`)} 배포 취소`, HTML).catch(() => undefined);
      return;
    }
    if (action === "go") {
      await ctx.answerCallbackQuery({ text: "배포 시작!" });
      await startDeploy(ctx, token, w);
      return;
    }

    if (action === "pnew") chooseProject(w, { projectId: null, projectName: suggestProjectName(w.repo) });
    else if (action === "p") {
      const p = w.projects.find((x) => x.projectId === arg);
      if (!p) return ctx.answerCallbackQuery({ text: "프로젝트를 찾을 수 없어" });
      chooseProject(w, { projectId: p.projectId, projectName: p.name });
    } else if (action === "e" && w.target) {
      const env = w.projects.find((p) => p.projectId === w.target?.projectId)?.environments.find((e) => e.environmentId === arg);
      if (!env) return ctx.answerCallbackQuery({ text: "환경을 찾을 수 없어" });
      w.target = { ...w.target, environmentId: env.environmentId, environmentName: env.name };
      w.step = "domain";
    } else if (action === "enew" && w.target) {
      const name = normalizeName(arg);
      if (!name) return ctx.answerCallbackQuery({ text: "환경 이름이 이상해" });
      w.target = { ...w.target, environmentId: null, environmentName: name };
      w.step = "domain";
    } else if (action === "dsug") await chooseDomain(w, `${subdomainFor(w.repo.repo)}.${cfg.baseDomain}`);
    else if (action === "dnone") await chooseDomain(w, null);
    else if (action === "ptype" || action === "etype" || action === "dtype") {
      w.awaiting = action === "ptype" ? "project" : action === "etype" ? "env" : "domain";
      await ctx.answerCallbackQuery();
      await render(ctx, token, w);
      const hint = { project: "새 프로젝트 이름 (영문 소문자, 숫자, -)", env: "환경 이름 (예: staging)", domain: `도메인 (예: myapp 또는 myapp.${cfg.baseDomain})` }[w.awaiting];
      await ctx.reply(`✏️ ${hint}`, { reply_markup: { force_reply: true, selective: true, input_field_placeholder: hint } });
      return;
    } else if (action === "back") {
      w.awaiting = null;
      w.step = arg === "project" || arg === "env" || arg === "domain" ? arg : w.step;
      if (w.step === "project") w.target = null;
      if (w.step === "env" && w.target && !w.target.projectId) w.step = "project";
      if (w.step !== "confirm") w.domain = undefined;
    }
    await ctx.answerCallbackQuery();
    await render(ctx, token, w);
  });

  bot.on("message:text", async (ctx, next) => {
    if (ctx.message.text.startsWith("/")) return next();
    const entry = [...wizards.entries()].find(([, w]) => w.awaiting && w.userId === ctx.from.id && w.chatId === ctx.chat.id);
    if (!entry) return next();
    const [token, w] = entry;
    const text = ctx.message.text;
    if (w.awaiting === "project") {
      const name = normalizeName(text);
      if (!name) return ctx.reply("이름은 영문 소문자, 숫자, - . _ 만 돼 (최대 63자). 다시 보내줘");
      const existing = w.projects.find((p) => p.name === name);
      chooseProject(w, existing ? { projectId: existing.projectId, projectName: existing.name } : { projectId: null, projectName: name });
    } else if (w.awaiting === "env" && w.target) {
      const name = normalizeName(text);
      if (!name) return ctx.reply("환경 이름은 영문 소문자, 숫자, - . _ 만 돼. 다시 보내줘");
      const env = w.projects.find((p) => p.projectId === w.target?.projectId)?.environments.find((e) => e.name === name);
      w.target = { ...w.target, environmentId: env?.environmentId ?? null, environmentName: name };
      w.step = "domain";
    } else if (w.awaiting === "domain") {
      const domain = normalizeDomain(text, cfg.baseDomain);
      if (!domain) return ctx.reply(`도메인 형식이 이상해. 다시 보내줘 (예: myapp.${cfg.baseDomain})`);
      await chooseDomain(w, domain);
    }
    w.awaiting = null;
    await react(ctx, "👍");
    await render(ctx, token, w);
  });

  const finishRun = async (ctx: Context, chatId: number, live: LiveStatus, result: DeployResult) => {
    const full = { ...result, dashboard: deployer.dashboardUrl(result.service) };
    await live.remove();
    const options = { ...HTML, reply_markup: resultKeyboard(full) };
    const text = resultText(full).slice(0, MAX_MESSAGE);
    if (result.status === "done" && ctx.chat?.type === "private") {
      const sent = await ctx.api.sendMessage(chatId, text, { ...options, message_effect_id: SUCCESS_EFFECT_ID }).then(
        () => true,
        () => false,
      );
      if (sent) return;
    }
    await ctx.api.sendMessage(chatId, text, options);
  };

  const startDeploy = async (ctx: Context, token: string, w: Wizard) => {
    const key = repoKey(w.repo);
    if (!w.target) return;
    if (busy.has(key)) {
      await ctx.reply(`${key}는 이미 배포 중이야`);
      return;
    }
    wizards.delete(token);
    const target = w.target;
    const domain = w.domain ?? null;
    await ctx.api.editMessageReplyMarkup(w.chatId, w.messageId).catch(() => undefined);
    busy.add(key);
    background(ctx, async () => {
      try {
        const live = new LiveStatus(ctx.api, w.chatId, `🚀 ${bold(key)} → ${esc(`${target.projectName} / ${target.environmentName}`)}`);
        const result = await deployer.deploy({ repo: w.repo, files: w.files, plan: w.plan, domain, target }, live);
        await finishRun(ctx, w.chatId, live, result);
      } finally {
        busy.delete(key);
      }
    });
  };

  const run = async (ctx: Context, service: ManagedService, mode: Mode) => {
    const chatId = ctx.chat?.id;
    if (chatId === undefined) return;
    if (busy.has(service.repo)) {
      await ctx.reply(`${service.repo}는 이미 배포 중이야`);
      return;
    }
    busy.add(service.repo);
    background(ctx, async () => {
      try {
        const label = mode === "update" ? "⬇️ 최신 코드로 업데이트" : "🔁 다시 빌드";
        const live = new LiveStatus(ctx.api, chatId, `${label} ${bold(service.repo)} · ${esc(`${service.projectName} / ${service.environmentName}`)}`);
        await live.step(mode === "update" ? "GitHub에서 최신 코드 받는 중" : "기존 코드로 빌드 시작");
        const outcome: RunOutcome = await deployer.runAndWait(service, mode === "update" ? "deploy" : "redeploy", live);
        const domains = await deployer.domainsOf(service).catch(() => []);
        const first = domains[0];
        await finishRun(ctx, chatId, live, {
          ...outcome,
          service,
          url: first ? `${first.https ? "https" : "http"}://${first.host}` : null,
          usedAiDockerfile: false,
        });
      } finally {
        busy.delete(service.repo);
      }
    });
  };

  const pick = async (ctx: Context, query: string, prefix: "run:u" | "run:r" | "log:r", verb: string) => {
    const services = await deployer.listManaged();
    if (services.length === 0) {
      await ctx.reply("봇으로 배포한 서비스가 없어. 먼저 /deploy <github url>");
      return null;
    }
    const ref = parseRepoUrl(query);
    const q = query.trim().toLowerCase();
    const matches = ref
      ? services.filter((s) => s.repo === repoKey(ref))
      : services.filter((s) => !q || s.repo.includes(q) || s.name.toLowerCase().includes(q));
    const exact = matches.filter((s) => s.repo.split("/")[1] === q || s.repo === q);
    const chosen = exact.length === 1 ? exact : matches;
    if (chosen.length === 1 && q) return chosen[0] ?? null;
    const list = chosen.length > 0 ? chosen : services;
    const kb = new InlineKeyboard();
    for (const s of list.slice(0, MAX_PICKER_ITEMS)) {
      kb.text(`${statusIcon(s.status)} ${s.repo} · ${s.environmentName}`, `${prefix}:${s.kind === "application" ? "a" : "c"}:${s.id}`).row();
    }
    const head = q && chosen.length === 0 ? `"${esc(query.trim())}"랑 맞는 게 없어. 전체에서 골라줘` : `어떤 서비스를 ${verb}?`;
    await ctx.reply(head, { ...HTML, reply_markup: kb });
    return null;
  };

  const findService = async (k: string, id: string) =>
    (await deployer.listManaged()).find((s) => s.id === id && s.kind === (k === "a" ? "application" : "compose")) ?? null;

  const sendRuntimeLog = async (ctx: Context, service: ManagedService) => {
    await ctx.replyWithChatAction("typing").catch(() => undefined);
    const log = await deployer.runtimeLog(service).catch((e: unknown) => `로그를 못 가져왔어: ${e instanceof Error ? e.message : String(e)}`);
    const k = service.kind === "application" ? "a" : "c";
    await ctx.reply(
      [`🖥 ${bold(service.repo)} 실행 로그 <i>(최근)</i>`, log ? logBlock(log) : "<i>로그가 아직 없어</i>"].join("\n"),
      { ...HTML, reply_markup: new InlineKeyboard().text("🔄 새로고침", `log:r:${k}:${service.id}`).url("🧭 Dokploy", deployer.dashboardUrl(service)) },
    );
  };

  bot.command("update", async (ctx) => {
    const s = await pick(ctx, ctx.match, "run:u", "업데이트할까");
    if (s) await run(ctx, s, "update");
  });
  bot.command("redeploy", async (ctx) => {
    const s = await pick(ctx, ctx.match, "run:r", "다시 빌드할까");
    if (s) await run(ctx, s, "redeploy");
  });
  bot.command("logs", async (ctx) => {
    const s = await pick(ctx, ctx.match, "log:r", "볼까");
    if (s) await sendRuntimeLog(ctx, s);
  });

  bot.callbackQuery(/^run:([ur]):([ac]):(.+)$/, async (ctx) => {
    const [, m, k = "", id = ""] = ctx.match;
    const service = await findService(k, id);
    if (!service) return ctx.answerCallbackQuery({ text: "서비스를 찾을 수 없어" });
    await ctx.answerCallbackQuery({ text: m === "u" ? "업데이트 시작" : "다시 빌드 시작" });
    await run(ctx, service, m === "u" ? "update" : "redeploy");
  });

  bot.callbackQuery(/^log:r:([ac]):(.+)$/, async (ctx) => {
    const [, k = "", id = ""] = ctx.match;
    const service = await findService(k, id);
    if (!service) return ctx.answerCallbackQuery({ text: "서비스를 찾을 수 없어" });
    await ctx.answerCallbackQuery();
    await sendRuntimeLog(ctx, service);
  });

  bot.callbackQuery(/^log:b:([ac]):([^:]+):(.+)$/, async (ctx) => {
    const [, k = "", id = "", deploymentId = ""] = ctx.match;
    const service = await findService(k, id);
    if (!service) return ctx.answerCallbackQuery({ text: "서비스를 찾을 수 없어" });
    await ctx.answerCallbackQuery();
    const log = await deployer.buildLog(deploymentId, 300);
    await ctx.reply([`📜 ${bold(service.repo)} 빌드 로그`, log ? logBlock(log) : "<i>로그가 없어</i>"].join("\n"), HTML);
  });

  bot.catch(async (err) => {
    console.error("[deploy-bot]", err.error);
    const message = err.error instanceof Error ? err.error.message : String(err.error);
    await err.ctx.reply(`❌ 오류: ${esc(message).slice(0, MAX_MESSAGE)}`, HTML).catch(() => undefined);
  });

  return { bot, idle: async () => void (await Promise.all([...jobs])) };
}

export const COMMANDS = [
  { command: "deploy", description: "GitHub 레포 새로 배포" },
  { command: "update", description: "최신 코드 받아서 다시 배포" },
  { command: "redeploy", description: "코드 그대로 다시 빌드" },
  { command: "logs", description: "실행 로그 보기" },
  { command: "list", description: "관리 중인 서비스 목록" },
];
