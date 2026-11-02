import { Bot, type Context, InlineKeyboard } from "grammy";
import { analyzeRepo, type BuildPlan, normalizeDomain, subdomainFor } from "./analyze.ts";
import type { Config } from "./config.ts";
import type { Deployer, DeployResult, ManagedService } from "./deployer.ts";
import { type GitHub, parseRepoUrl, type RepoInfo, repoKey } from "./github.ts";

interface PendingDeploy {
  userId: number;
  chatId: number;
  repo: RepoInfo;
  files: string[];
  plan: BuildPlan;
  defaultDomain: string;
  awaitingCustomDomain: boolean;
  createdAt: number;
}

type Mode = "update" | "redeploy";

export interface BotDeps {
  cfg: Config;
  deployer: Deployer;
  gh: GitHub;
}

const PENDING_TTL_MS = 15 * 60_000;
const MAX_PICKER_ITEMS = 20;
const MAX_MESSAGE = 3800;

const clip = (text: string, max = MAX_MESSAGE) => (text.length > max ? `${text.slice(0, max)}\n…` : text);

export function isAllowed(
  chat: { id: number; type: string } | undefined,
  userId: number | undefined,
  cfg: Pick<Config, "allowedUserIds" | "allowedChatIds">,
): boolean {
  if (!chat || userId === undefined) return false;
  if (chat.type === "private") return cfg.allowedUserIds.has(userId);
  if (chat.type === "group" || chat.type === "supergroup") return cfg.allowedChatIds.has(chat.id);
  return false;
}

function describePlan(plan: BuildPlan, railpackVersion: string): string {
  if (plan.kind === "compose") {
    return `Docker Compose (${plan.composePath}) · 도메인 연결 서비스: ${plan.serviceName} (전체: ${plan.services.join(", ")})`;
  }
  if (plan.buildType === "dockerfile") return `Dockerfile (${plan.dockerfile})`;
  return `Railpack v${railpackVersion} (Dockerfile/compose 없음 · 실패하면 AI가 Dockerfile 생성)`;
}

export function summaryText(
  repo: RepoInfo,
  plan: BuildPlan,
  domain: string | null,
  cfg: Pick<Config, "https" | "dokployProject" | "railpackVersion">,
  dnsOk: boolean | null,
): string {
  const lines = [
    `🚀 ${repo.owner}/${repo.repo} 이렇게 올릴게`,
    `• 빌드: ${describePlan(plan, cfg.railpackVersion)}`,
    `• 브랜치: ${repo.defaultBranch}`,
    `• 포트: ${plan.port}`,
    `• 도메인: ${domain ? `${cfg.https ? "https" : "http"}://${domain}` : "없음"}`,
    `• Dokploy 프로젝트: ${cfg.dokployProject}`,
  ];
  for (const w of plan.warnings) lines.push(`⚠️ ${w}`);
  if (domain && dnsOk === false) lines.push(`⚠️ ${domain} DNS가 아직 안 잡혀 있어. 서버 IP로 A 레코드(또는 와일드카드)를 걸어야 접속돼`);
  return lines.join("\n");
}

function resultText(result: DeployResult): string {
  const name = `${result.service.repo} (${result.service.appName})`;
  if (result.status === "done") {
    const lines = [`✅ 배포 완료: ${name}`];
    if (result.url) lines.push(result.url);
    if (result.usedAiDockerfile) lines.push("🤖 AI가 만든 Dockerfile.deploy-bot으로 빌드했어 (Dokploy Patches에서 수정 가능)");
    return lines.join("\n");
  }
  const reason = result.status === "timeout" ? "시간 초과 (Dokploy에서 계속 진행 중일 수 있음)" : result.status;
  const lines = [`❌ 배포 실패: ${name} · ${reason}`];
  if (result.logTail) lines.push("", "로그 끝부분:", result.logTail.slice(-2500));
  return lines.join("\n");
}

class ProgressMessage {
  private lines: string[] = [];
  private messageId: number | null = null;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly ctxApi: Context["api"],
    private readonly chatId: number,
    private readonly header: string,
  ) {}

  push = (line: string) => {
    this.lines.push(`• ${line}`);
    const text = clip(`${this.header}\n${this.lines.join("\n")}`);
    this.chain = this.chain.then(async () => {
      if (this.messageId === null) {
        const msg = await this.ctxApi.sendMessage(this.chatId, text);
        this.messageId = msg.message_id;
      } else {
        await this.ctxApi.editMessageText(this.chatId, this.messageId, text).catch(() => undefined);
      }
    });
    return this.chain.then(() => undefined);
  };
}

export function createBot({ cfg, deployer, gh }: BotDeps, bot = new Bot(cfg.telegramToken)) {
  const pending = new Map<string, PendingDeploy>();
  const busy = new Set<string>();
  const jobs = new Set<Promise<void>>();
  let seq = 0;

  const prune = () => {
    const now = Date.now();
    for (const [token, p] of pending) if (now - p.createdAt > PENDING_TTL_MS) pending.delete(token);
  };

  const background = (ctx: Context, work: () => Promise<void>) => {
    const job = work()
      .catch(async (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        console.error("[deploy-bot]", error);
        await ctx.reply(clip(`❌ 오류: ${message}`)).catch(() => undefined);
      })
      .finally(() => jobs.delete(job));
    jobs.add(job);
  };

  bot.use(async (ctx, next) => {
    const id = ctx.from?.id;
    const isCommand = ctx.message?.entities?.[0]?.type === "bot_command" && ctx.message.entities[0].offset === 0;
    if (isAllowed(ctx.chat, id, cfg)) {
      if (isCommand) console.log(`[deploy-bot] cmd ${ctx.message?.text?.split(" ")[0]} chat=${ctx.chat?.id} user=${id}`);
      return next();
    }
    if (ctx.callbackQuery || isCommand) {
      console.warn(`[deploy-bot] denied chat=${ctx.chat?.id} type=${ctx.chat?.type} user=${id}`);
    }
    if (ctx.callbackQuery) {
      await ctx.answerCallbackQuery({ text: "권한 없음" });
    } else if (isCommand && ctx.chat?.type === "private") {
      await ctx.reply(`⛔ 권한이 없어. 관리자에게 이 ID를 등록해 달라고 해: ${id ?? "unknown"}`);
    } else if (isCommand && ctx.chat) {
      await ctx.reply(`⛔ 이 그룹에서는 쓸 수 없어. 그룹 ID: ${ctx.chat.id}`);
    }
  });

  bot.command(["start", "help"], (ctx) =>
    ctx.reply(
      [
        "Dokploy 배포 봇",
        "/deploy <github url> - 새로 배포 (도메인 물어봄)",
        "/update [레포이름] - GitHub 최신 코드 받아서 다시 배포",
        "/redeploy [레포이름] - 코드 그대로 다시 빌드",
        "/list - 봇이 관리하는 서비스 목록",
        "",
        "레포이름은 일부만 쳐도 되고, 비워두면 버튼으로 고를 수 있어",
      ].join("\n"),
    ),
  );

  bot.command("list", async (ctx) => {
    const services = await deployer.listManaged();
    if (services.length === 0) return ctx.reply("아직 봇으로 배포한 서비스가 없어. /deploy <github url>");
    return ctx.reply(services.map((s) => `• ${s.repo} · ${s.kind} · ${s.status}`).join("\n"));
  });

  bot.command("deploy", async (ctx) => {
    const ref = parseRepoUrl(ctx.match);
    if (!ref) return ctx.reply("사용법: /deploy https://github.com/owner/repo");
    const userId = ctx.from?.id;
    if (userId === undefined) return;

    const existing = await deployer.findByRepo(ref);
    if (existing) {
      return ctx.reply(`${existing.repo}는 이미 배포돼 있어 (${existing.appName}). 어떻게 할까?`, {
        reply_markup: pickerRow(existing),
      });
    }

    const status = await ctx.reply(`🔍 ${ref.owner}/${ref.repo} 분석 중...`);
    const repo = await gh.repo(ref);
    const files = await gh.treeBlobs(repo, repo.defaultBranch);
    const plan = await analyzeRepo(files, (path) => gh.fileOrNull(repo, repo.defaultBranch, path));

    prune();
    const token = (++seq).toString(36);
    const defaultDomain = `${subdomainFor(repo.repo)}.${cfg.baseDomain}`;
    pending.set(token, {
      userId,
      chatId: ctx.chat.id,
      repo,
      files,
      plan,
      defaultDomain,
      awaitingCustomDomain: false,
      createdAt: Date.now(),
    });

    const keyboard = new InlineKeyboard()
      .text(`✅ ${defaultDomain}`, `dom:${token}:default`)
      .row()
      .text("✏️ 직접 입력", `dom:${token}:custom`)
      .text("🚫 도메인 없이", `dom:${token}:none`)
      .row()
      .text("취소", `dom:${token}:cancel`);
    await ctx.api.editMessageText(
      ctx.chat.id,
      status.message_id,
      `📦 ${repo.owner}/${repo.repo}\n빌드: ${describePlan(plan, cfg.railpackVersion)}\n\n도메인은 어떻게 할까?`,
      { reply_markup: keyboard },
    );
  });

  const startDeploy = async (ctx: Context, token: string, p: PendingDeploy, domain: string | null) => {
    pending.delete(token);
    const key = repoKey(p.repo);
    if (busy.has(key)) {
      await ctx.reply(`${key}는 이미 배포 중이야`);
      return;
    }
    const dnsOk = domain ? await deployer.domainResolves(domain) : null;
    await ctx.api.sendMessage(p.chatId, summaryText(p.repo, p.plan, domain, cfg, dnsOk));
    busy.add(key);
    background(ctx, async () => {
      try {
        const progress = new ProgressMessage(ctx.api, p.chatId, `⏳ ${key} 진행 상황`);
        const result = await deployer.deploy({ repo: p.repo, files: p.files, plan: p.plan, domain }, progress.push);
        await ctx.api.sendMessage(p.chatId, clip(resultText(result)));
      } finally {
        busy.delete(key);
      }
    });
  };

  bot.callbackQuery(/^dom:([a-z0-9]+):(default|custom|none|cancel)$/, async (ctx) => {
    const [, token = "", choice] = ctx.match;
    const p = pending.get(token);
    if (!p || p.userId !== ctx.from.id) {
      await ctx.answerCallbackQuery({ text: "만료된 요청이야. /deploy 다시 해줘" });
      return;
    }
    await ctx.answerCallbackQuery();
    await ctx.editMessageReplyMarkup().catch(() => undefined);
    if (choice === "cancel") {
      pending.delete(token);
      await ctx.reply("취소했어");
    } else if (choice === "custom") {
      p.awaitingCustomDomain = true;
      await ctx.reply(`쓸 도메인을 답장으로 보내줘. 예: myapp 또는 myapp.${cfg.baseDomain} 또는 app.example.com`, {
        reply_markup: { force_reply: true, selective: true },
      });
    } else {
      await startDeploy(ctx, token, p, choice === "default" ? p.defaultDomain : null);
    }
  });

  const findAwaiting = (userId: number, chatId: number) =>
    [...pending.entries()].find(([, p]) => p.awaitingCustomDomain && p.userId === userId && p.chatId === chatId);

  bot.on("message:text", async (ctx, next) => {
    if (ctx.message.text.startsWith("/")) return next();
    const entry = findAwaiting(ctx.from.id, ctx.chat.id);
    if (!entry) return next();
    const [token, p] = entry;
    const domain = normalizeDomain(ctx.message.text, cfg.baseDomain);
    if (!domain) {
      await ctx.reply("도메인 형식이 이상해. 다시 보내줘 (예: myapp.arpa.page)");
      return;
    }
    p.awaitingCustomDomain = false;
    await startDeploy(ctx, token, p, domain);
  });

  function pickerRow(s: ManagedService) {
    const kind = s.kind === "application" ? "a" : "c";
    return new InlineKeyboard().text("⬇️ 최신 코드로 업데이트", `run:u:${kind}:${s.id}`).text("🔁 다시 빌드", `run:r:${kind}:${s.id}`);
  }

  const run = async (ctx: Context, service: ManagedService, mode: Mode) => {
    const chatId = ctx.chat?.id;
    if (chatId === undefined) return;
    if (busy.has(service.repo)) {
      await ctx.reply(`${service.repo}는 이미 배포 중이야`);
      return;
    }
    busy.add(service.repo);
    const label = mode === "update" ? "GitHub 최신 코드 받아서 배포" : "기존 코드로 다시 빌드";
    await ctx.reply(`🔄 ${service.repo}: ${label} 시작`);
    background(ctx, async () => {
      try {
        const progress = new ProgressMessage(ctx.api, chatId, `⏳ ${service.repo} ${mode}`);
        const outcome = await deployer.runAndWait(service, mode === "update" ? "deploy" : "redeploy", progress.push);
        const domains = await deployer.domainsOf(service).catch(() => []);
        const first = domains[0];
        await ctx.api.sendMessage(
          chatId,
          clip(
            resultText({
              service,
              status: outcome.status,
              url: first ? `${first.https ? "https" : "http"}://${first.host}` : null,
              usedAiDockerfile: false,
              logTail: outcome.logTail,
            }),
          ),
        );
      } finally {
        busy.delete(service.repo);
      }
    });
  };

  const selectAndRun = async (ctx: Context, query: string, mode: Mode) => {
    const services = await deployer.listManaged();
    if (services.length === 0) {
      await ctx.reply("봇으로 배포한 서비스가 없어. 먼저 /deploy <github url>");
      return;
    }
    const ref = parseRepoUrl(query);
    const q = query.trim().toLowerCase();
    const matches = ref
      ? services.filter((s) => s.repo === repoKey(ref))
      : services.filter((s) => !q || s.repo.includes(q) || s.name.toLowerCase().includes(q));
    const exact = matches.filter((s) => s.repo.split("/")[1] === q || s.repo === q);
    const chosen = exact.length === 1 ? exact : matches;
    if (chosen.length === 1 && q) {
      const [only] = chosen;
      if (only) await run(ctx, only, mode);
      return;
    }
    const list = chosen.length > 0 ? chosen : services;
    const keyboard = new InlineKeyboard();
    for (const s of list.slice(0, MAX_PICKER_ITEMS)) {
      keyboard.text(s.repo, `run:${mode === "update" ? "u" : "r"}:${s.kind === "application" ? "a" : "c"}:${s.id}`).row();
    }
    const head = q && chosen.length === 0 ? `"${query.trim()}"랑 맞는 게 없어. 전체 목록에서 골라줘` : "어떤 서비스?";
    await ctx.reply(head, { reply_markup: keyboard });
  };

  bot.command("update", (ctx) => selectAndRun(ctx, ctx.match, "update"));
  bot.command("redeploy", (ctx) => selectAndRun(ctx, ctx.match, "redeploy"));

  bot.callbackQuery(/^run:([ur]):([ac]):(.+)$/, async (ctx) => {
    const [, m, k, id] = ctx.match;
    const service = (await deployer.listManaged()).find((s) => s.id === id && s.kind === (k === "a" ? "application" : "compose"));
    if (!service) {
      await ctx.answerCallbackQuery({ text: "서비스를 찾을 수 없어" });
      return;
    }
    await ctx.answerCallbackQuery();
    await ctx.editMessageReplyMarkup().catch(() => undefined);
    await run(ctx, service, m === "u" ? "update" : "redeploy");
  });

  bot.catch(async (err) => {
    console.error("[deploy-bot]", err.error);
    const message = err.error instanceof Error ? err.error.message : String(err.error);
    await err.ctx.reply(clip(`❌ 오류: ${message}`)).catch(() => undefined);
  });

  return { bot, idle: async () => void (await Promise.all([...jobs])) };
}

export const COMMANDS = [
  { command: "deploy", description: "GitHub 레포 새로 배포" },
  { command: "update", description: "최신 코드 받아서 다시 배포" },
  { command: "redeploy", description: "코드 그대로 다시 빌드" },
  { command: "list", description: "관리 중인 서비스 목록" },
];
