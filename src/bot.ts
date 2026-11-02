import { Bot, type Context, InlineKeyboard } from "grammy";
import { BUILD_LABELS, type BuildChoice, type BuildOptions, type BuildPlan, buildOptions, normalizeDomain, planFor, subdomainFor } from "./analyze.ts";
import type { Access } from "./access.ts";
import type { DnsReport } from "./dns.ts";
import { type Config, publicUrl } from "./config.ts";
import type { Deployer, DeployResult, ManagedService, ProjectInfo, Reporter, RunOutcome, Target } from "./deployer.ts";
import { type GitHub, parseRepoUrl, type RepoInfo, repoKey } from "./github.ts";

interface RichButton {
  label: string;
  data?: string;
  url?: string;
  copy?: string;
  style?: "primary" | "success" | "danger";
  disabled?: boolean;
}

type Step = "build" | "project" | "env" | "domain" | "confirm";
type Awaiting = "project" | "env" | "domain" | null;

interface Place {
  chatId: number;
  threadId?: number;
}

interface Wizard {
  userId: number;
  place: Place;
  messageId: number;
  promptId: number | null;
  repo: RepoInfo;
  files: string[];
  options: BuildOptions;
  choice: BuildChoice;
  plan: BuildPlan;
  projects: ProjectInfo[];
  step: Step;
  awaiting: Awaiting;
  target: Target | null;
  domain: string | null | undefined;
  dns: (DnsReport & { serverIps: string[] }) | null;
  taken: Set<string>;
  suggested?: { env: string; host: string; plainTaken: string | null };
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
const NO_EPHEMERAL_MS = 10 * 60_000;
const MAX_PICKER_ITEMS = 20;
const MAX_MESSAGE = 3800;
const LIVE_EDIT_MS = 4000;
const LOG_BLOCK_CHARS = 2800;
const RICH_LOG_CHARS = 6000;
const SUCCESS_EFFECT_ID = "5046509860389126442";

export const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const code = (s: string) => `<code>${esc(s)}</code>`;
const bold = (s: string) => `<b>${esc(s)}</b>`;
const clipTail = (s: string, max: number) => (s.length > max ? `…${s.slice(s.length - max)}` : s);
const HTML = { parse_mode: "HTML" as const, link_preview_options: { is_disabled: true } };
const threadOf = (place: Place) => (place.threadId === undefined ? {} : { message_thread_id: place.threadId });

const NOISE = /^#\d+ (sha256:|extracting|resolve |DONE|CACHED|\[internal\]|exporting (layers|manifest|config)|naming to|writing image)/;
function cleanLog(log: string): string {
  const lines = log
    .replace(/\x1b\[[0-9;]*m/g, "")
    .replace(/\r/g, "")
    .split("\n")
    .map((l) => l.trimEnd())
    .filter((l) => l.trim() && !NOISE.test(l));
  return lines.join("\n");
}

export function logBlock(log: string, max = LOG_BLOCK_CHARS): string {
  return `<blockquote expandable>${esc(clipTail(cleanLog(log) || log.trim(), max))}</blockquote>`;
}

const attr = (s: string) => esc(s).replace(/"/g, "&quot;");

function richButton(b: RichButton): string {
  const style = b.style ? ` style="${b.style}"` : "";
  const label = esc(b.label);
  if (b.disabled) return `<tg-button type="disabled"${style}>${label}</tg-button>`;
  if (b.url) return `<tg-button type="url" url="${attr(b.url)}"${style}>${label}</tg-button>`;
  if (b.copy) return `<tg-button type="copy_text" text="${attr(b.copy)}"${style}>${label}</tg-button>`;
  return `<tg-button type="callback_data" data="${attr(b.data ?? "")}"${style}>${label}</tg-button>`;
}

const richRows = (rows: RichButton[][]) => rows.filter((r) => r.length).map((r) => `<tg-button-row>${r.map(richButton).join("")}</tg-button-row>`).join("");

function toRich(html: string): string {
  const quotes: string[] = [];
  const masked = html
    .replace(/<blockquote expandable>([\s\S]*?)<\/blockquote>/g, (_m, inner: string) => {
      quotes.push(`<blockquote expandable>${inner.replace(/\n/g, "<br>")}</blockquote>`);
      return `\n\n@@Q${quotes.length - 1}@@\n\n`;
    })
    .split("\n\n")
    .map((p) => p.trim())
    .filter(Boolean);
  return masked
    .map((p) => {
      const quote = /^@@Q(\d+)@@$/.exec(p);
      return quote ? (quotes[Number(quote[1])] ?? "") : `<p>${p.replace(/\n/g, "<br>")}</p>`;
    })
    .join("");
}

function logCard(repo: string, subtitle: string, log: string | null, empty: string): { classic: string; rich: string } {
  const body = log ? logBlock(log) : `<i>${esc(empty)}</i>`;
  return {
    classic: [bold(repo), esc(subtitle), body].join("\n"),
    rich: `<h3>${esc(repo)}</h3><p>${esc(subtitle)}</p>` + (log ? richLog(log) : `<p>${esc(empty)}</p>`),
  };
}

function toInline(rows: RichButton[][]): InlineKeyboard {
  const kb = new InlineKeyboard();
  for (const row of rows) {
    if (!row.length) continue;
    for (const b of row) {
      if (b.disabled) kb.disabled(b.label);
      else if (b.url) kb.url(b.label, b.url);
      else if (b.copy) kb.copyText(b.label, b.copy);
      else kb.text(b.label, b.data ?? "");
      if (b.style === "primary") kb.primary();
      else if (b.style === "success") kb.success();
      else if (b.style === "danger") kb.danger();
    }
    kb.row();
  }
  return kb;
}

type Api = Context["api"];

interface DeliverOptions {
  ephemeralTo?: number;
  forceReply?: { selective: boolean; placeholder?: string };
  effect?: string | null;
}

const isEphemeralDenied = (error: unknown) => /BOT_NOT_ADMIN|ephemeral/i.test(String(error));

async function deliver(
  api: Api,
  place: Place,
  content: string | { classic: string; rich: string },
  rows: RichButton[][] = [],
  opts: DeliverOptions = {},
): Promise<number> {
  const { classic, rich } = typeof content === "string" ? { classic: content, rich: toRich(content) } : content;
  const extra = {
    ...threadOf(place),
    ...(opts.ephemeralTo === undefined ? {} : { ephemeral_message_parameters: { receiver_user_id: opts.ephemeralTo } }),
    ...(opts.effect ? { message_effect_id: opts.effect } : {}),
  };
  const fr = opts.forceReply;
  const markup = fr ? { force_reply: true as const, ...(fr.selective ? { selective: true } : {}), ...(fr.placeholder ? { input_field_placeholder: fr.placeholder.slice(0, 64) } : {}) } : undefined;
  try {
    const sent = await api.sendRichMessage(place.chatId, { html: rich + richRows(rows) }, { ...extra, ...(markup ? { reply_markup: markup } : {}) });
    return (sent as { message_id?: number }).message_id ?? 0;
  } catch (error) {
    if (opts.ephemeralTo !== undefined && isEphemeralDenied(error)) throw error;
    console.warn("[deploy-bot] rich message failed, falling back to HTML:", error instanceof Error ? error.message : error);
    const inline = toInline(rows);
    const reply_markup = fr ? Object.assign(inline.forceReply(), fr.selective ? { selective: true } : {}) : rows.length ? inline : undefined;
    const sent = await api.sendMessage(place.chatId, classic.slice(0, MAX_MESSAGE), { ...HTML, ...extra, ...(reply_markup ? { reply_markup } : {}) });
    return sent.message_id;
  }
}

async function redraw(api: Api, place: Place, messageId: number, content: string | { classic: string; rich: string }, rows: RichButton[][] = []): Promise<void> {
  const { classic, rich } = typeof content === "string" ? { classic: content, rich: toRich(content) } : content;
  try {
    await api.editMessageText(place.chatId, messageId, { html: rich + richRows(rows) });
  } catch (error) {
    if (String(error).includes("message is not modified")) return;
    await api.editMessageText(place.chatId, messageId, classic.slice(0, MAX_MESSAGE), { ...HTML, reply_markup: toInline(rows) }).catch((e: unknown) => {
      if (!String(e).includes("message is not modified")) throw e;
    });
  }
}

const richLog = (log: string) => `<blockquote expandable>${esc(clipTail(cleanLog(log) || log.trim(), RICH_LOG_CHARS)).replace(/\n/g, "<br>")}</blockquote>`;

export function whereOf(ctx: Context): Place {
  const msg = ctx.msg;
  const threadId = msg?.is_topic_message ? msg.message_thread_id : undefined;
  return { chatId: ctx.chat?.id ?? 0, ...(threadId === undefined ? {} : { threadId }) };
}

export function isAllowed(
  chat: { id: number; type: string } | undefined,
  userId: number | undefined,
  access: Pick<Access, "isUser" | "isChatAllowed">,
): boolean {
  if (!chat || userId === undefined) return false;
  if (chat.type === "private") return access.isUser(userId);
  if (chat.type === "group" || chat.type === "supergroup") return access.isChatAllowed(chat.id);
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
  if (plan.generateDockerfile) return "AI가 Dockerfile을 만들어서 빌드";
  if (plan.buildType === "dockerfile") return `Dockerfile ${code(plan.dockerfile ?? "Dockerfile")}`;
  if (plan.buildType === "railpack") return `Railpack v${esc(railpackVersion)} <i>(실패하면 AI가 Dockerfile 생성)</i>`;
  if (plan.buildType === "static") return "Static (nginx) <i>저장소 그대로 서빙</i>";
  return `${esc(plan.buildType)} <i>(실패하면 AI가 Dockerfile 생성)</i>`;
}

const STEPS: { key: Step; label: string }[] = [
  { key: "build", label: "빌드" },
  { key: "project", label: "프로젝트" },
  { key: "env", label: "환경" },
  { key: "domain", label: "도메인" },
  { key: "confirm", label: "확인" },
];

function stepBar(step: Step): string {
  const at = STEPS.findIndex((s) => s.key === step);
  return STEPS.map((s, i) => (i < at ? `✓ ${s.label}` : i === at ? `<b>● ${s.label}</b>` : `○ ${s.label}`)).join("  ");
}

const randomDigits = () => String(1000 + Math.floor(Math.random() * 9000));

export function freeHost(label: string, baseDomain: string, taken: ReadonlySet<string>): string {
  let host = `${label}.${baseDomain}`;
  while (taken.has(host)) host = `${label.slice(0, 58)}-${randomDigits()}.${baseDomain}`;
  return host;
}

export function alternativeFor(host: string, taken: ReadonlySet<string>): string {
  const [label = "app", ...rest] = host.split(".");
  return freeHost(label, rest.join("."), new Set([...taken, host]));
}

function suggestDomain(w: Wizard, baseDomain: string): string {
  const env = w.target?.environmentName ?? "";
  if (w.suggested?.env === env) return w.suggested.host;
  const slug = subdomainFor(w.repo.repo);
  const label = env && env !== "production" ? `${slug}-${subdomainFor(env)}` : slug;
  const plain = `${label}.${baseDomain}`;
  const host = freeHost(label, baseDomain, w.taken);
  w.suggested = { env, host, plainTaken: host === plain ? null : plain };
  return host;
}

export function dnsLines(host: string, dns: DnsReport & { serverIps: string[] }, tls: Config["domainTls"]): string[] {
  const ip = dns.serverIps.join(", ") || "서버 IP";
  const guide = [
    "직접 연결: DNS에서 A 레코드를 서버 IP로 설정해",
    `  ${code(host)} → ${code(ip)}`,
    "Cloudflare 사용: 같은 A 레코드에 프록시(주황 구름)를 켜고 SSL/TLS 모드를 Flexible로 해",
  ];
  if (dns.state === "direct") {
    return [tls === "none" ? "DNS 확인: 서버로 바로 연결돼 있어 (HTTP로 열려)" : "DNS 확인: 서버로 바로 연결돼 있어. Let's Encrypt 인증서로 HTTPS를 설정해"];
  }
  if (dns.state === "cloudflare") return ["DNS 확인: Cloudflare 프록시로 연결돼 있어. SSL/TLS 모드를 Flexible로 맞춰줘 (서버에는 HTTP로 전달돼)"];
  if (dns.state === "other") return [`DNS 확인: ${code(host)}가 다른 곳(${code(dns.addresses.join(", "))})을 가리키고 있어`, ...guide];
  return [`DNS 확인: ${code(host)}가 아직 설정되지 않았어`, ...guide];
}

function planRows(plan: BuildPlan, railpackVersion: string): [string, string][] {
  const rows: [string, string][] = [];
  if (plan.kind === "compose") {
    rows.push(["빌드", `Docker Compose ${code(plan.composePath)}`]);
    rows.push(["도메인 연결", `${bold(plan.serviceName)} (전체 ${plan.services.length}개)`]);
  } else {
    rows.push(["빌드", describePlan(plan, railpackVersion)]);
  }
  rows.push(["포트", String(plan.port)]);
  return rows;
}

export function wizardView(w: Wizard, cfg: Pick<Config, "domainTls" | "railpackVersion">, frozen = false): { classic: string; rich: string } {
  const header = `${bold(`${w.repo.owner}/${w.repo.repo}`)} · ${code(w.repo.defaultBranch)}`;
  const rows: [string, string][] = [];
  if (w.step !== "build") rows.push(...planRows(w.plan, cfg.railpackVersion));
  if (w.target) rows.push(["프로젝트", `${bold(w.target.projectName)}${w.target.projectId ? "" : " <i>(새로 만듦)</i>"}`]);
  if (w.target && w.step !== "env" && w.step !== "project") {
    rows.push(["환경", `${bold(w.target.environmentName)}${w.target.environmentId ? "" : " <i>(새로 만듦)</i>"}`]);
  }
  if (w.domain !== undefined) rows.push(["도메인", w.domain ? code(publicUrl(cfg, w.domain)) : "없음"]);

  const notes = [...w.plan.warnings.map((warning) => esc(warning)), ...(w.domain && w.dns ? dnsLines(w.domain, w.dns, cfg.domainTls) : [])];

  const prompt: string[] = [];
  if (!frozen) {
    if (w.step === "build") prompt.push(`감지: ${describePlan(w.options.detected, cfg.railpackVersion)}`, "어떻게 빌드할까?");
    if (w.step === "project") prompt.push(w.awaiting === "project" ? "새 프로젝트 이름을 답장으로 보내줘" : "어느 Dokploy 프로젝트에 올릴까?");
    if (w.step === "env") prompt.push(w.awaiting === "env" ? "새 환경 이름을 답장으로 보내줘" : "어느 환경(environment)에 올릴까?");
    if (w.step === "domain") {
      if (w.suggested?.plainTaken) prompt.push(`${code(w.suggested.plainTaken)}는 이미 쓰는 중이라 ${code(w.suggested.host)}를 추천해`);
      prompt.push(w.awaiting === "domain" ? "도메인을 답장으로 보내줘" : "도메인은 어떻게 할까?");
    }
    if (w.step === "confirm") prompt.push("이대로 올릴까?");
  }

  const classic = [header, "", stepBar(w.step), "", ...rows.map(([k, v]) => `${k} ${v}`), ...notes, ...(prompt.length ? ["", ...prompt] : [])].join("\n");
  const table = rows.length
    ? `<table bordered striped compact>${rows.map(([k, v]) => `<tr><td><b>${esc(k)}</b></td><td>${v}</td></tr>`).join("")}</table>`
    : "";
  const rich = toRich(`${header}\n\n${stepBar(w.step)}`) + table + (notes.length ? toRich(notes.join("\n")) : "") + (prompt.length ? toRich(prompt.join("\n\n")) : "");
  return { classic, rich };
}

export const wizardText = (w: Wizard, cfg: Pick<Config, "domainTls" | "railpackVersion">) => wizardView(w, cfg).classic;

type FullResult = DeployResult & { dashboard: string };

function resultText(result: FullResult, cfg: Pick<Config, "domainTls">): string {
  void cfg;
  const where = `${result.service.projectName} / ${result.service.environmentName}`;
  if (result.status === "done") {
    const lines = [`${bold(result.service.repo)} 배포 완료`, `${esc(where)} · ${code(result.service.appName)}`];
    if (result.url) lines.push(`${esc(result.url)}`);
    if (result.usedAiDockerfile) lines.push("AI가 만든 <code>Dockerfile.deploy-bot</code>으로 빌드했어 (Dokploy Patches에서 수정 가능)");
    return lines.join("\n");
  }
  const reason = result.status === "timeout" ? "시간 초과 (Dokploy에서 계속 진행 중일 수 있음)" : result.status;
  const lines = [`${bold(result.service.repo)} 배포 실패 · ${esc(reason)}`, `${esc(where)}`];
  if (result.logTail) lines.push("", "빌드 로그 끝부분", logBlock(result.logTail));
  return lines.join("\n");
}

function resultRich(result: FullResult): string {
  const ok = result.status === "done";
  const reason = result.status === "timeout" ? "시간 초과" : result.status;
  const rows: [string, string][] = [
    ["프로젝트 / 환경", `${result.service.projectName} / ${result.service.environmentName}`],
    ["서비스", result.service.appName],
  ];
  if (result.buildLabel) rows.push(["빌드", result.buildLabel]);
  if (result.url) rows.push(["주소", result.url]);
  const table = `<table bordered striped compact>${rows.map(([k, v]) => `<tr><td><b>${esc(k)}</b></td><td>${esc(v)}</td></tr>`).join("")}</table>`;
  const parts = [`<h3>${esc(result.service.repo)} ${ok ? "배포 완료" : `배포 실패 · ${esc(reason)}`}</h3>`, table];
  if (ok && result.usedAiDockerfile) parts.push("<p>AI가 만든 <code>Dockerfile.deploy-bot</code>으로 빌드했어. Dokploy Patches에서 고칠 수 있어.</p>");
  if (!ok && result.logTail) parts.push("<p>빌드 로그 끝부분</p>", richLog(result.logTail));
  return parts.join("");
}

interface PanelInfo {
  service: ManagedService;
  url: string | null;
  dashboard: string;
  deploymentId: string | null;
}

function panelHtml(p: PanelInfo, statusWord: string): { classic: string; rich: string } {
  const where = `${p.service.projectName} / ${p.service.environmentName}`;
  const rows: [string, string][] = [
    ["프로젝트 / 환경", where],
    ["서비스", p.service.appName],
    ["종류", p.service.kind === "compose" ? "compose" : "app"],
    ["상태", statusWord],
  ];
  if (p.url) rows.push(["주소", p.url]);
  const table = `<table bordered striped compact>${rows.map(([k, v]) => `<tr><td><b>${esc(k)}</b></td><td>${esc(v)}</td></tr>`).join("")}</table>`;
  return {
    rich: `<h3>${esc(p.service.repo)}</h3>${table}`,
    classic: [bold(p.service.repo), esc(where), `상태 ${esc(statusWord)}`, ...(p.url ? [esc(p.url)] : [])].join("\n"),
  };
}

function panelButtons(p: PanelInfo, busy: boolean): RichButton[][] {
  const k = p.service.kind === "application" ? "a" : "c";
  const top: RichButton[] = [];
  if (p.url) top.push({ label: "사이트 열기", url: p.url, style: "success" });
  top.push({ label: "Dokploy", url: p.dashboard });
  if (p.url) top.push({ label: "URL 복사", copy: p.url });
  const logs: RichButton[] = [];
  if (p.deploymentId) logs.push({ label: "빌드 로그", data: `log:b:${k}:${p.service.id}:${p.deploymentId}` });
  logs.push({ label: "실행 로그", data: `log:r:${k}:${p.service.id}` });
  const runs: RichButton[] = busy
    ? [{ label: "배포 진행 중", disabled: true }]
    : [
        { label: "업데이트", data: `run:u:${k}:${p.service.id}` },
        { label: "다시 빌드", data: `run:r:${k}:${p.service.id}` },
      ];
  return [top, logs, runs, [{ label: "새로고침", data: `svc:${k}:${p.service.id}` }, { label: "목록으로", data: "svc:list" }]];
}

function resultButtons(result: FullResult): RichButton[][] {
  const k = result.service.kind === "application" ? "a" : "c";
  const ok = result.status === "done";
  const top: RichButton[] = [];
  if (ok && result.url) top.push({ label: "사이트 열기", url: result.url, style: "success" });
  top.push({ label: "Dokploy", url: result.dashboard });
  if (result.url) top.push({ label: "URL 복사", copy: result.url });
  const logs: RichButton[] = [];
  if (result.deploymentId) logs.push({ label: "빌드 로그", data: `log:b:${k}:${result.service.id}:${result.deploymentId}` });
  logs.push({ label: "실행 로그", data: `log:r:${k}:${result.service.id}` });
  const runs: RichButton[] = [
    { label: "업데이트", data: `run:u:${k}:${result.service.id}` },
    { label: "다시 빌드", data: `run:r:${k}:${result.service.id}`, style: ok ? undefined : "primary" },
  ];
  return [top, logs, runs];
}

class LiveStatus implements Reporter {
  private steps: string[] = [];
  private logTail: string | null = null;
  private messageId: number | null = null;
  private lastEdit = 0;
  private chain: Promise<unknown> = Promise.resolve();
  private lastText = "";
  private readonly startedAt: number;

  constructor(
    private readonly api: Api,
    private readonly place: Place,
    private readonly header: string,
    private readonly now: () => number = Date.now,
  ) {
    this.startedAt = now();
  }

  private render() {
    const sec = Math.max(0, Math.round((this.now() - this.startedAt) / 1000));
    const elapsed = sec >= 60 ? `${Math.floor(sec / 60)}분 ${sec % 60}초` : `${sec}초`;
    const body = [`${this.header} · ${elapsed}`, ...this.steps.map((s, i) => (i === this.steps.length - 1 ? `▸ ${esc(s)}` : `✓ ${esc(s)}`))];
    if (this.logTail) body.push("", logBlock(this.logTail, 1200));
    return body.join("\n").slice(0, MAX_MESSAGE);
  }

  private flush(force: boolean) {
    const text = this.render();
    if (!force && this.messageId !== null && this.now() - this.lastEdit < LIVE_EDIT_MS) return this.chain.then(() => undefined);
    const body = text.replace(/ · \d+분? ?\d*초?[^\n]*/, "");
    if (body === this.lastText) return this.chain.then(() => undefined);
    this.lastText = body;
    this.lastEdit = this.now();
    this.chain = this.chain.then(async () => {
      if (this.messageId === null) this.messageId = await deliver(this.api, this.place, text);
      else await redraw(this.api, this.place, this.messageId, text).catch(() => undefined);
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
    if (this.messageId !== null) await this.api.deleteMessage(this.place.chatId, this.messageId).catch(() => undefined);
  }
}

export function createBot({ cfg, access, deployer, gh }: BotDeps, bot = new Bot(cfg.telegramToken)) {
  const wizards = new Map<string, Wizard>();
  const notifiedRequests = new Set<number>();
  const noEphemeral = new Map<number, number>();
  const busy = new Set<string>();
  const jobs = new Set<Promise<void>>();
  let seq = 0;

  const notice = async (ctx: Context, html: string, rows: RichButton[][] = []) => {
    const chat = ctx.chat;
    const userId = ctx.from?.id;
    const place = whereOf(ctx);
    if (chat && chat.type !== "private" && userId !== undefined && (noEphemeral.get(chat.id) ?? 0) < Date.now()) {
      try {
        return await deliver(ctx.api, place, html, rows, { ephemeralTo: userId });
      } catch (error) {
        if (!isEphemeralDenied(error)) throw error;
        noEphemeral.set(chat.id, Date.now() + NO_EPHEMERAL_MS);
      }
    }
    return deliver(ctx.api, place, html, rows);
  };

  const say = (ctx: Context, content: string | { classic: string; rich: string }, rows: RichButton[][] = []) => deliver(ctx.api, whereOf(ctx), content, rows);

  const notifyAdmins = async (ctx: Context, userId: number) => {
    if (notifiedRequests.has(userId)) return;
    notifiedRequests.add(userId);
    const u = ctx.from;
    const who = [u?.first_name, u?.last_name].filter(Boolean).join(" ") + (u?.username ? ` (@${u.username})` : "");
    const rows: RichButton[][] = [[{ label: "허용", data: `acl:add:${userId}`, style: "success" }, { label: "무시", data: `acl:ignore:${userId}` }]];
    for (const admin of access.list().admins) {
      await deliver(ctx.api, { chatId: admin }, `접근 요청: ${esc(who || "이름 없음")} · ID ${code(String(userId))}`, rows)
        .catch((error: unknown) => console.warn(`[deploy-bot] could not notify admin ${admin}:`, error instanceof Error ? error.message : error));
    }
  };

  const loadTaken = () =>
    deployer.usedHosts().catch((error: unknown) => {
      console.warn("[deploy-bot] could not read used domains, skipping the duplicate check:", error instanceof Error ? error.message : error);
      return new Set<string>();
    });

  const prune = () => {
    const now = Date.now();
    for (const [token, w] of wizards) if (now - w.createdAt > WIZARD_TTL_MS) wizards.delete(token);
  };

  const background = (ctx: Context, work: () => Promise<void>) => {
    const job = work()
      .catch(async (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        console.error("[deploy-bot]", error);
        await say(ctx, `오류: ${esc(message).slice(0, MAX_MESSAGE)}`).catch(() => undefined);
      })
      .finally(() => jobs.delete(job));
    jobs.add(job);
  };

  const react = (ctx: Context, emoji: "👀" | "👍" | "🔥") => ctx.react(emoji).catch(() => undefined);

  bot.use(async (ctx, next) => {
    const id = ctx.from?.id;
    const isCommand = ctx.message?.entities?.[0]?.type === "bot_command" && ctx.message.entities[0].offset === 0;
    const command = isCommand ? ctx.message?.text?.split(/[\s@]/)[0] : undefined;
    const adminGroupCommand = command === "/allowgroup" && access.isAdmin(id) && ctx.chat?.type !== "private";
    if (isAllowed(ctx.chat, id, access) || adminGroupCommand) {
      if (isCommand) console.log(`[deploy-bot] cmd ${ctx.message?.text?.split(" ")[0]} chat=${ctx.chat?.id} user=${id}`);
      return next();
    }
    if (ctx.callbackQuery || isCommand) console.warn(`[deploy-bot] denied chat=${ctx.chat?.id} type=${ctx.chat?.type} user=${id}`);
    if (ctx.callbackQuery) {
      await ctx.answerCallbackQuery({ text: "권한 없음" });
    } else if (isCommand && ctx.chat?.type === "private") {
      await say(ctx, `권한이 없어. 관리자에게 접근 요청을 보냈어. 내 ID: ${id ?? "unknown"}`);
      if (id !== undefined) await notifyAdmins(ctx, id);
    } else if (isCommand && ctx.chat) {
      await say(ctx, `이 그룹에서는 쓸 수 없어. 그룹 ID: ${ctx.chat.id}`);
    }
  });

  bot.command(["start", "help"], (ctx) =>
    notice(
      ctx,
      [
        "<b>Dokploy 배포 봇</b>",
        "",
        "/deploy <code>&lt;github url&gt;</code> 새로 배포 (빌드·프로젝트·환경·도메인 골라서)",
        "/update <code>[레포]</code> GitHub 최신 코드로 다시 배포",
        "/redeploy <code>[레포]</code> 코드 그대로 다시 빌드",
        "/logs <code>[레포]</code> 실행 로그 보기",
        "/list 관리 중인 서비스",
        "",
        "<i>레포 이름은 일부만 쳐도 되고, 비워두면 버튼으로 골라.</i>",
        ...(access.isAdmin(ctx.from?.id)
          ? ["", "<b>관리자</b>", "/allow <code>&lt;유저ID&gt;</code> DM 허용 (그룹에서 답장으로 /allow 도 됨)", "/disallow <code>&lt;유저ID&gt;</code> 허용 취소", "/allowed 허용 목록", "/allowgroup <code>[그룹ID]</code> 그룹 허용 (그룹 안에서는 ID 없이 쓰면 그 그룹)", "/disallowgroup <code>&lt;그룹ID&gt;</code> 그룹 허용 취소"]
          : []),
      ].join("\n"),
    ),
  );

  const adminOnly = async (ctx: Context) => {
    if (access.isAdmin(ctx.from?.id)) return true;
    await notice(ctx, "관리자만 쓸 수 있어");
    return false;
  };

  const targetOf = (ctx: Context & { match: string }) => {
    const replied = ctx.message?.reply_to_message?.from;
    return parseUserId(ctx.match) ?? (replied && !replied.is_bot ? replied.id : null);
  };

  bot.command("allow", async (ctx) => {
    if (!(await adminOnly(ctx))) return;
    const target = targetOf(ctx);
    if (target === null) return notice(ctx, "사용법: /allow &lt;유저ID&gt; 또는 그 사람 메시지에 답장으로 /allow");
    const result = await access.add(target);
    console.log(`[deploy-bot] allow user=${target} by=${ctx.from?.id} result=${result}`);
    return notice(ctx, result === "added" ? `${target} 허용했어. 이제 DM으로 봇을 쓸 수 있어` : `${target}는 이미 허용돼 있어`);
  });

  bot.command("disallow", async (ctx) => {
    if (!(await adminOnly(ctx))) return;
    const target = targetOf(ctx);
    if (target === null) return notice(ctx, "사용법: /disallow &lt;유저ID&gt;");
    const result = await access.remove(target);
    console.log(`[deploy-bot] disallow user=${target} by=${ctx.from?.id} result=${result}`);
    const messages = {
      removed: `${target} 허용 취소했어`,
      env: `${target}는 .env의 ALLOWED_USER_IDS에 있어서 봇에서는 못 빼. .env에서 지우고 재시작해줘`,
      admin: `${target}는 관리자라서 못 빼 (ADMIN_USER_IDS)`,
      missing: `${target}는 허용 목록에 없어`,
    } as const;
    return notice(ctx, messages[result]);
  });

  bot.command("allowed", async (ctx) => {
    if (!(await adminOnly(ctx))) return;
    const { admins, env, added, envChats, addedChats } = access.list();
    const fmt = (ids: number[]) => (ids.length ? ids.join(", ") : "없음");
    return notice(
      ctx,
      [`관리자: ${fmt(admins)}`, `.env 허용: ${fmt(env)}`, `봇으로 추가: ${fmt(added)}`, `허용 그룹(.env): ${fmt(envChats)}`, `봇으로 추가한 그룹: ${fmt(addedChats)}`].join("\n"),
    );
  });

  const parseChatId = (text: string) => {
    const id = Number(text.trim());
    return text.trim() && Number.isSafeInteger(id) && id !== 0 ? id : null;
  };

  bot.command("allowgroup", async (ctx) => {
    if (!(await adminOnly(ctx))) return;
    const arg = ctx.match.trim();
    const target = arg ? parseChatId(arg) : ctx.chat.type === "private" ? null : ctx.chat.id;
    if (target === null) return notice(ctx, "사용법: /allowgroup &lt;그룹ID&gt; (허용할 그룹 안에서는 ID 없이 /allowgroup 만 쳐도 돼)");
    const result = await access.addChat(target);
    console.log(`[deploy-bot] allowgroup chat=${target} by=${ctx.from?.id} result=${result}`);
    return notice(ctx, result === "added" ? `${target} 그룹을 허용했어. 이제 그 그룹의 모든 멤버가 봇을 쓸 수 있어` : `${target}는 이미 허용된 그룹이야`);
  });

  bot.command("disallowgroup", async (ctx) => {
    if (!(await adminOnly(ctx))) return;
    const target = parseChatId(ctx.match);
    if (target === null) return notice(ctx, "사용법: /disallowgroup &lt;그룹ID&gt;");
    const result = await access.removeChat(target);
    console.log(`[deploy-bot] disallowgroup chat=${target} by=${ctx.from?.id} result=${result}`);
    const messages = {
      removed: `${target} 그룹 허용을 취소했어`,
      env: `${target}는 .env의 ALLOWED_CHAT_IDS에 있어서 봇에서는 못 빼. .env에서 지우고 재시작해줘`,
      missing: `${target}는 허용된 그룹이 아니야`,
    } as const;
    return notice(ctx, messages[result]);
  });

  bot.callbackQuery(/^acl:(add|ignore):(\d+)$/, async (ctx) => {
    if (!access.isAdmin(ctx.from.id)) {
      await ctx.answerCallbackQuery({ text: "관리자만 가능" });
      return;
    }
    const [, action, raw = ""] = ctx.match;
    const target = Number(raw);
    const messageId = ctx.callbackQuery.message?.message_id;
    const settle = (text: string) => (messageId === undefined ? Promise.resolve() : redraw(ctx.api, whereOf(ctx), messageId, text).catch(() => undefined));
    if (action === "ignore") {
      await settle(`접근 요청 ID ${code(raw)}: 무시함`);
      await ctx.answerCallbackQuery({ text: "무시했어" });
      return;
    }
    const result = await access.add(target);
    await settle(`접근 요청 ID ${code(raw)}: 허용함`);
    console.log(`[deploy-bot] allow user=${target} by=${ctx.from.id} result=${result} via=request`);
    await ctx.answerCallbackQuery({ text: result === "added" ? "허용했어" : "이미 허용돼 있어" });
    await deliver(ctx.api, { chatId: target }, "관리자가 허용했어. /help 로 사용법 확인해").catch(() => undefined);
  });

  const statusWord = (s: string) => ({ done: "정상", running: "배포 중", error: "실패", idle: "대기" })[s] ?? s;

  const listView = async () => {
    const services = await deployer.listManaged();
    if (services.length === 0) return null;
    const buttons = services.map((s): RichButton[] => [
      { label: `${s.repo} · ${s.environmentName} (${statusWord(s.status)})`, data: `svc:${s.kind === "application" ? "a" : "c"}:${s.id}` },
    ]);
    return { services, buttons };
  };

  const openPanel = async (service: ManagedService) => {
    const [domains, deploymentId] = await Promise.all([
      deployer.domainsOf(service).catch(() => []),
      deployer.latestDeploymentId(service),
    ]);
    const first = domains[0];
    const info: PanelInfo = {
      service,
      url: first ? publicUrl(cfg, first.host) : null,
      dashboard: deployer.dashboardUrl(service),
      deploymentId,
    };
    return { content: panelHtml(info, statusWord(service.status)), rows: panelButtons(info, busy.has(service.repo)) };
  };

  bot.command("list", async (ctx) => {
    const view = await listView();
    if (!view) return notice(ctx, "아직 봇으로 배포한 서비스가 없어. /deploy &lt;github url&gt;");
    const { services } = view;
    const fallback = ["<b>관리 중인 서비스</b>", ...services.map((s) => `${esc(s.repo)} · ${esc(`${s.projectName}/${s.environmentName}`)} · ${statusWord(s.status)}`)].join("\n");
    const rows = services
      .map((s) => `<tr><td>${esc(s.repo)}</td><td>${esc(`${s.projectName} / ${s.environmentName}`)}</td><td>${s.kind === "compose" ? "compose" : "app"}</td><td>${statusWord(s.status)}</td></tr>`)
      .join("");
    const html = `<h3>관리 중인 서비스 (${services.length})</h3><table bordered striped compact><tr><th>레포</th><th>프로젝트 / 환경</th><th>종류</th><th>상태</th></tr>${rows}</table>`;
    await deliver(ctx.api, whereOf(ctx), { classic: fallback, rich: html }, view.buttons);
  });

  bot.callbackQuery(/^svc:(list|[ac]:.+)$/, async (ctx) => {
    const target = ctx.match[1] ?? "";
    const messageId = ctx.callbackQuery.message?.message_id;
    const place = whereOf(ctx);
    if (target === "list") {
      const view = await listView();
      await ctx.answerCallbackQuery();
      if (!view) return;
      if (messageId === undefined) return;
      const rows = view.services
        .map((s) => `<tr><td>${esc(s.repo)}</td><td>${esc(`${s.projectName} / ${s.environmentName}`)}</td><td>${s.kind === "compose" ? "compose" : "app"}</td><td>${statusWord(s.status)}</td></tr>`)
        .join("");
      const html = `<h3>관리 중인 서비스 (${view.services.length})</h3><table bordered striped compact><tr><th>레포</th><th>프로젝트 / 환경</th><th>종류</th><th>상태</th></tr>${rows}</table>`;
      const fallback = ["<b>관리 중인 서비스</b>", ...view.services.map((s) => `${esc(s.repo)} · ${esc(`${s.projectName}/${s.environmentName}`)} · ${statusWord(s.status)}`)].join("\n");
      await redraw(ctx.api, place, messageId, { classic: fallback, rich: html }, view.buttons).catch(() => undefined);
      return;
    }
    const [k = "", id = ""] = target.split(/:(.*)/s);
    const service = await findService(k, id);
    if (!service) return ctx.answerCallbackQuery({ text: "서비스를 찾을 수 없어" });
    await ctx.answerCallbackQuery();
    const panel = await openPanel(service);
    if (messageId === undefined) return;
    await redraw(ctx.api, place, messageId, panel.content, panel.rows).catch(() => undefined);
  });

  const wizardRows = (token: string, w: Wizard): RichButton[][] => {
    const cb = (label: string, action: string, style?: RichButton["style"]): RichButton => ({ label, data: `wz:${token}:${action}`, style });
    const cancel = cb("취소", "cancel", "danger");
    const pairs = (items: RichButton[]) => Array.from({ length: Math.ceil(items.length / 2) }, (_, i) => items.slice(i * 2, i * 2 + 2));
    if (w.awaiting) return [[cb("버튼으로 고르기", `back:${w.step}`), cancel]];
    if (w.step === "build") {
      const items = w.options.choices.map((choice): RichButton => {
        const label = BUILD_LABELS[choice];
        if (choice === "ai_dockerfile" && cfg.ai === null) return { label: `${label} (AI 키 없음)`, disabled: true };
        return choice === w.options.recommended ? cb(`${label} (추천)`, `b:${choice}`, "primary") : cb(label, `b:${choice}`);
      });
      return [...pairs(items), [cancel]];
    }
    if (w.step === "project") {
      const suggested = suggestProjectName(w.repo);
      const rows: RichButton[][] = [];
      if (!w.projects.some((p) => p.name === suggested)) rows.push([cb(`새 프로젝트: ${suggested} (추천)`, "pnew", "primary")]);
      const listed = w.projects.slice(0, 10).map((p) => (p.name === suggested ? cb(`${p.name} (추천)`, `p:${p.projectId}`, "primary") : cb(p.name, `p:${p.projectId}`)));
      rows.push(...pairs(listed), [cb("이름 직접 입력", "ptype")], [cb("뒤로", "back:build"), cancel]);
      return rows;
    }
    if (w.step === "env") {
      const envs = w.projects.find((p) => p.projectId === w.target?.projectId)?.environments ?? [];
      const names = new Set(envs.map((x) => x.name));
      const items =
        envs.length === 0
          ? [cb("production (추천)", "enew:production", "primary")]
          : envs.map((x) => cb(`${x.name}${x.isDefault ? " (기본)" : ""}`, `e:${x.environmentId}`, x.isDefault ? "primary" : undefined));
      const extra = ["staging", "dev"].filter((n) => !names.has(n)).map((n) => cb(`＋ ${n}`, `enew:${n}`));
      return [...pairs(items), [...extra, cb("직접 입력", "etype")], [cb("뒤로", "back:project"), cancel]];
    }
    if (w.step === "domain") {
      return [
        [cb(`${suggestDomain(w, cfg.baseDomain)} (추천)`, "dsug", "primary")],
        [cb("직접 입력", "dtype"), cb("도메인 없이", "dnone")],
        [cb("뒤로", "back:env"), cancel],
      ];
    }
    const recheck = w.domain && isCustom(w.domain) ? [cb("DNS 다시 확인", "dnscheck")] : [];
    return [[cb("배포하기", "go", "success"), ...recheck], [cb("뒤로", "back:domain"), cancel]];
  };

  const render = async (ctx: Context, token: string, w: Wizard, frozen: string | null = null) => {
    if (w.step === "domain") suggestDomain(w, cfg.baseDomain);
    const rows: RichButton[][] = frozen ? [[{ label: frozen, disabled: true }]] : wizardRows(token, w);
    const view = wizardView(w, cfg, frozen !== null);
    try {
      await ctx.api.editMessageText(w.place.chatId, w.messageId, { html: view.rich + richRows(rows) });
    } catch (error) {
      if (String(error).includes("message is not modified")) return;
      console.warn("[deploy-bot] rich wizard failed, falling back to HTML:", error instanceof Error ? error.message : error);
      await ctx.api.editMessageText(w.place.chatId, w.messageId, view.classic, { ...HTML, reply_markup: toInline(rows) }).catch((err: unknown) => {
        if (!String(err).includes("message is not modified")) throw err;
      });
    }
  };

  const freezeWizard = (ctx: Context, token: string, w: Wizard, label: string) => render(ctx, token, w, label).catch(() => undefined);

  bot.command("deploy", async (ctx) => {
    const ref = parseRepoUrl(ctx.match);
    if (!ref) return notice(ctx, "사용법: /deploy https://github.com/owner/repo");
    const userId = ctx.from?.id;
    if (userId === undefined) return;
    await react(ctx, "👀");

    const place = whereOf(ctx);
    const statusId = await say(ctx, `${bold(`${ref.owner}/${ref.repo}`)} 분석 중...`);
    await ctx.replyWithChatAction("typing").catch(() => undefined);
    try {
      const [repo, projects, existing, taken] = await Promise.all([gh.repo(ref), deployer.listProjects(), deployer.findByRepo(ref), loadTaken()]);
      const files = await gh.treeBlobs(repo, repo.defaultBranch);
      const options = await buildOptions(files, (path) => gh.fileOrNull(repo, repo.defaultBranch, path));

      prune();
      const token = (++seq).toString(36);
      const w: Wizard = {
        userId,
        place,
        messageId: statusId,
        promptId: null,
        repo,
        files,
        options,
        choice: options.recommended,
        plan: options.detected,
        projects,
        step: "build",
        awaiting: null,
        target: null,
        domain: undefined,
        dns: null,
        taken,
        createdAt: Date.now(),
      };
      wizards.set(token, w);
      await render(ctx, token, w);
      if (existing.length > 0) {
        const shortcuts = existing.slice(0, 5).map((s): RichButton[] => {
          const label = `${s.projectName}/${s.environmentName}`;
          return busy.has(s.repo) ? [{ label: `${label} 진행 중`, disabled: true }] : [{ label: `${label} 업데이트`, data: `run:u:${s.kind === "application" ? "a" : "c"}:${s.id}` }];
        });
        await say(ctx, `이 레포는 이미 ${existing.length}곳에 배포돼 있어. 새로 만드는 대신 업데이트할 수도 있어.`, shortcuts);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await redraw(ctx.api, place, statusId, esc(message)).catch(() => undefined);
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
    w.step = target.projectId ? "env" : "domain";
    w.awaiting = null;
  };

  const isCustom = (host: string) => !host.endsWith(`.${cfg.baseDomain}`);

  const chooseDomain = async (w: Wizard, domain: string | null) => {
    w.domain = domain;
    w.dns = domain && isCustom(domain) ? await deployer.dnsReport(domain).catch(() => null) : null;
    w.step = "confirm";
    w.awaiting = null;
  };

  const clearPrompt = async (ctx: Context, w: Wizard) => {
    if (w.promptId !== null) await ctx.api.deleteMessage(w.place.chatId, w.promptId).catch(() => undefined);
    w.promptId = null;
  };

  const askText = async (ctx: Context, token: string, w: Wizard, hint: string) => {
    const mention = `<a href="tg://user?id=${w.userId}">${esc(ctx.from?.first_name ?? "너")}</a>`;
    const isPrivate = ctx.chat?.type === "private";
    const rows: RichButton[][] = [[{ label: "취소", data: `wz:${token}:back:${w.step}` }]];
    w.promptId = await deliver(ctx.api, w.place, `${isPrivate ? "" : `${mention} `}${esc(hint)}`, rows, { forceReply: { selective: !isPrivate, placeholder: hint } });
  };

  bot.callbackQuery(/^wz:([a-z0-9]+):([a-z]+)(?::(.+))?$/, async (ctx) => {
    const [, token = "", action = "", arg = ""] = ctx.match;
    const w = await owned(ctx, token);
    if (!w) return;

    if (action === "cancel") {
      wizards.delete(token);
      await clearPrompt(ctx, w);
      await ctx.answerCallbackQuery({ text: "취소했어" });
      await ctx.editMessageText(`${bold(`${w.repo.owner}/${w.repo.repo}`)} 배포 취소`, HTML).catch(() => undefined);
      return;
    }
    if (action === "go") {
      await ctx.answerCallbackQuery({ text: "배포 시작!" });
      await startDeploy(ctx, token, w);
      return;
    }

    if (action === "b") {
      const choice = arg as BuildChoice;
      if (!w.options.choices.includes(choice)) return ctx.answerCallbackQuery({ text: "고를 수 없는 빌드 방식이야" });
      if (choice === "ai_dockerfile" && !cfg.ai) return ctx.answerCallbackQuery({ text: "AI 키가 없어서 못 써" });
      w.choice = choice;
      w.plan = planFor(w.options, choice);
      w.step = "project";
    } else if (action === "pnew") chooseProject(w, { projectId: null, projectName: suggestProjectName(w.repo) });
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
    } else if (action === "dnscheck") {
      if (!w.domain) return ctx.answerCallbackQuery({ text: "확인할 도메인이 없어" });
      w.dns = await deployer.dnsReport(w.domain).catch(() => null);
      await ctx.answerCallbackQuery({ text: w.dns ? "다시 확인했어" : "DNS 조회에 실패했어" });
      await render(ctx, token, w);
      return;
    } else if (action === "dsug") await chooseDomain(w, suggestDomain(w, cfg.baseDomain));
    else if (action === "dnone") await chooseDomain(w, null);
    else if (action === "ptype" || action === "etype" || action === "dtype") {
      w.awaiting = action === "ptype" ? "project" : action === "etype" ? "env" : "domain";
      await ctx.answerCallbackQuery();
      await render(ctx, token, w);
      const hint = { project: "새 프로젝트 이름 (영문 소문자, 숫자, -)", env: "환경 이름 (예: staging)", domain: `도메인 (예: myapp 또는 myapp.${cfg.baseDomain})` }[w.awaiting];
      await askText(ctx, token, w, hint);
      return;
    } else if (action === "back") {
      await clearPrompt(ctx, w);
      w.awaiting = null;
      const to = arg === "build" || arg === "project" || arg === "env" || arg === "domain" ? arg : w.step;
      w.step = to;
      if (to === "build" || to === "project") w.target = null;
      if (to === "env" && w.target && !w.target.projectId) w.step = "project";
      if (w.step === "project") w.target = null;
      if (w.step !== "confirm") w.domain = undefined;
    }
    await ctx.answerCallbackQuery();
    await render(ctx, token, w);
  });

  bot.on("message:text", async (ctx, next) => {
    if (ctx.message.text.startsWith("/")) return next();
    const entry = [...wizards.entries()].find(([, w]) => w.awaiting && w.userId === ctx.from.id && w.place.chatId === ctx.chat.id);
    if (!entry) return next();
    const [token, w] = entry;
    const text = ctx.message.text;
    if (w.awaiting === "project") {
      const name = normalizeName(text);
      if (!name) return say(ctx, "이름은 영문 소문자, 숫자, - . _ 만 돼 (최대 63자). 다시 보내줘");
      const existing = w.projects.find((p) => p.name === name);
      chooseProject(w, existing ? { projectId: existing.projectId, projectName: existing.name } : { projectId: null, projectName: name });
    } else if (w.awaiting === "env" && w.target) {
      const name = normalizeName(text);
      if (!name) return say(ctx, "환경 이름은 영문 소문자, 숫자, - . _ 만 돼. 다시 보내줘");
      const env = w.projects.find((p) => p.projectId === w.target?.projectId)?.environments.find((e) => e.name === name);
      w.target = { ...w.target, environmentId: env?.environmentId ?? null, environmentName: name };
      w.step = "domain";
    } else if (w.awaiting === "domain") {
      const domain = normalizeDomain(text, cfg.baseDomain);
      if (!domain) return say(ctx, `도메인 형식이 이상해. 다시 보내줘 (예: myapp.${cfg.baseDomain})`);
      if (w.taken.has(domain)) {
        return say(ctx, `${code(domain)}는 이미 쓰는 도메인이야. 다른 걸 보내줘 (예: ${code(alternativeFor(domain, w.taken))})`);
      }
      await chooseDomain(w, domain);
    }
    w.awaiting = null;
    await react(ctx, "👍");
    await clearPrompt(ctx, w);
    await render(ctx, token, w);
  });

  const finishRun = async (ctx: Context, place: Place, live: LiveStatus, result: DeployResult) => {
    const full: FullResult = { ...result, dashboard: deployer.dashboardUrl(result.service) };
    await live.remove();
    const effect = result.status === "done" && ctx.chat?.type === "private" ? SUCCESS_EFFECT_ID : null;
    await deliver(ctx.api, place, { classic: resultText(full, cfg), rich: resultRich(full) }, resultButtons(full), { effect });
  };

  const startDeploy = async (ctx: Context, token: string, w: Wizard) => {
    const key = repoKey(w.repo);
    if (!w.target) return;
    if (busy.has(key)) {
      await notice(ctx, `${esc(key)}는 이미 배포 중이야`);
      return;
    }
    if (w.domain) {
      w.taken = await loadTaken();
      if (isCustom(w.domain)) w.dns = await deployer.dnsReport(w.domain).catch(() => w.dns);
      if (w.taken.has(w.domain)) {
        const lost = w.domain;
        w.suggested = undefined;
        w.domain = undefined;
        w.step = "domain";
        await render(ctx, token, w);
        await notice(ctx, `${code(lost)}를 방금 다른 서비스가 쓰기 시작했어. 도메인을 다시 골라줘`);
        return;
      }
    }
    wizards.delete(token);
    const target = w.target;
    const domain = w.domain ?? null;
    const dnsState = domain && isCustom(domain) ? (w.dns?.state ?? null) : null;
    await freezeWizard(ctx, token, w, "배포 진행 중...");
    busy.add(key);
    background(ctx, async () => {
      let label = "배포 실패";
      try {
        const live = new LiveStatus(ctx.api, w.place, `${bold(key)} → ${esc(`${target.projectName} / ${target.environmentName}`)}`);
        const result = await deployer.deploy({ repo: w.repo, files: w.files, plan: w.plan, domain, target, dns: dnsState }, live);
        label = result.status === "done" ? "배포 완료" : "배포 실패";
        await finishRun(ctx, w.place, live, result);
      } finally {
        busy.delete(key);
        await freezeWizard(ctx, token, w, label);
      }
    });
  };

  const run = async (ctx: Context, service: ManagedService, mode: Mode) => {
    const place = whereOf(ctx);
    if (!place.chatId) return;
    if (busy.has(service.repo)) {
      await notice(ctx, `${esc(service.repo)}는 이미 배포 중이야`);
      return;
    }
    busy.add(service.repo);
    background(ctx, async () => {
      try {
        const label = mode === "update" ? "최신 코드로 업데이트" : "다시 빌드";
        const live = new LiveStatus(ctx.api, place, `${label} ${bold(service.repo)} · ${esc(`${service.projectName} / ${service.environmentName}`)}`);
        await live.step(mode === "update" ? "GitHub에서 최신 코드 받는 중" : "기존 코드로 빌드 시작");
        const outcome: RunOutcome = await deployer.rerun(service, mode === "update" ? "deploy" : "redeploy", live);
        const domains = await deployer.domainsOf(service).catch(() => []);
        const first = domains[0];
        await finishRun(ctx, place, live, {
          ...outcome,
          service,
          url: first ? publicUrl(cfg, first.host) : null,
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
      await notice(ctx, "봇으로 배포한 서비스가 없어. 먼저 /deploy &lt;github url&gt;");
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
    const rows = list.slice(0, MAX_PICKER_ITEMS).map((s): RichButton[] => {
      const label = `${s.repo} · ${s.environmentName}`;
      if (prefix !== "log:r" && busy.has(s.repo)) return [{ label: `${label} (진행 중)`, disabled: true }];
      return [{ label, data: `${prefix}:${s.kind === "application" ? "a" : "c"}:${s.id}` }];
    });
    const head = q && chosen.length === 0 ? `"${esc(query.trim())}"랑 맞는 게 없어. 전체에서 골라줘` : `어떤 서비스를 ${verb}?`;
    await say(ctx, head, rows);
    return null;
  };

  const findService = async (k: string, id: string) =>
    (await deployer.listManaged()).find((s) => s.id === id && s.kind === (k === "a" ? "application" : "compose")) ?? null;

  const sendRuntimeLog = async (ctx: Context, service: ManagedService) => {
    await ctx.replyWithChatAction("typing").catch(() => undefined);
    const log = await deployer.runtimeLog(service).catch((e: unknown) => `로그를 못 가져왔어: ${e instanceof Error ? e.message : String(e)}`);
    const k = service.kind === "application" ? "a" : "c";
    await say(ctx, logCard(service.repo, "실행 로그 · 최근", log, "로그가 아직 없어"), [
      [{ label: "새로고침", data: `log:r:${k}:${service.id}` }, { label: "Dokploy", url: deployer.dashboardUrl(service) }],
    ]);
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
    await say(ctx, logCard(service.repo, "빌드 로그", log, "로그가 없어"));
  });

  bot.catch(async (err) => {
    console.error("[deploy-bot]", err.error);
    const message = err.error instanceof Error ? err.error.message : String(err.error);
    await say(err.ctx, `오류: ${esc(message).slice(0, MAX_MESSAGE)}`).catch(() => undefined);
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
