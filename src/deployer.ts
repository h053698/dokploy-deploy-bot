import { generateDockerfile } from "./ai.ts";
import { classifyWithAi, detectFault, errorLines, parseNameMaps, parsePortMaps, pickFreeName, pickFreePort, renderPortPatch } from "./logfix.ts";
import type { AppBuildType, BuildPlan } from "./analyze.ts";
import { checkDomain, type DnsReport, type DnsState, type Resolver, serverAddresses, systemResolver } from "./dns.ts";
import { type Config, dokployDomainTls, publicUrl } from "./config.ts";
import type { DkDeployment, DkDomain, DkGithubProvider, DkGithubRepo, DkPatch, Dokploy, FetchLike } from "./dokploy.ts";
import { type GitHub, type RepoInfo, type RepoRef, repoKey } from "./github.ts";

export type ServiceKind = "application" | "compose";

export interface ManagedService {
  kind: ServiceKind;
  id: string;
  name: string;
  appName: string;
  repo: string;
  status: string;
  projectId: string;
  projectName: string;
  environmentId: string;
  environmentName: string;
}

export interface ProjectInfo {
  projectId: string;
  name: string;
  environments: { environmentId: string; name: string; isDefault: boolean }[];
}

export interface Target {
  projectId: string | null;
  projectName: string;
  environmentId: string | null;
  environmentName: string;
}

export interface DeployRequest {
  dns?: DnsState | null;
  repo: RepoInfo;
  files: string[];
  plan: BuildPlan;
  domain: string | null;
  target: Target;
}

export type RunStatus = "done" | "error" | "cancelled" | "timeout";

export interface RunOutcome {
  status: RunStatus;
  logTail: string | null;
  deploymentId: string | null;
}

export interface DeployResult extends RunOutcome {
  service: ManagedService;
  url: string | null;
  usedAiDockerfile: boolean;
  buildLabel?: string;
}

export interface Reporter {
  step(line: string): Promise<void> | void;
  log?(tail: string): Promise<void> | void;
}

const AI_DOCKERFILE = "Dockerfile.deploy-bot";
const MARKER = "deploy-bot repo:";
const TERMINAL = new Set(["done", "error", "cancelled"]);
const LIVE_LOG_LINES = 12;

export const describeService = (repo: RepoRef) => `${MARKER}${repoKey(repo)}`;

export function repoFromDescription(description: string | null): string | null {
  const m = description?.match(/deploy-bot repo:(\S+)/);
  return m?.[1] ?? null;
}

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const MAX_COMPOSE_FIXES = 2;

export const uniqueSuffix = (appName: string): string => appName.split("-").pop()?.slice(0, 8) || Math.random().toString(36).slice(2, 8);

interface ComposeSource {
  ref: RepoRef;
  branch: string;
  path: string;
}

interface PatchRow {
  patchId: string;
  filePath: string;
  content: string;
}

export interface DeployerHooks {
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  resolver?: Resolver;
  aiFetch?: FetchLike;
}

interface SearchPage<T> {
  items: T[];
  total: number;
}
interface SearchApp {
  applicationId: string;
  name: string;
  appName: string;
  description: string | null;
  environmentId: string;
  applicationStatus: string;
}
interface SearchCompose {
  composeId: string;
  name: string;
  appName: string;
  description: string | null;
  environmentId: string;
  composeStatus: string;
}

export class Deployer {
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly resolver: Resolver;
  private readonly aiFetch: FetchLike;

  constructor(
    private readonly cfg: Config,
    private readonly dk: Dokploy,
    private readonly gh: GitHub,
    hooks: DeployerHooks = {},
  ) {
    this.sleep = hooks.sleep ?? delay;
    this.now = hooks.now ?? Date.now;
    this.resolver = hooks.resolver ?? systemResolver;
    this.aiFetch = hooks.aiFetch ?? fetch;
  }

  async listProjects(): Promise<ProjectInfo[]> {
    const projects = await this.dk.get<ProjectInfo[]>("project.all");
    return projects.map((p) => ({
      projectId: p.projectId,
      name: p.name,
      environments: p.environments.map((e) => ({ environmentId: e.environmentId, name: e.name, isDefault: e.isDefault })),
    }));
  }

  async listManaged(): Promise<ManagedService[]> {
    const [projects, apps, composes] = await Promise.all([
      this.listProjects(),
      this.dk.get<SearchPage<SearchApp>>("application.search", { description: MARKER, limit: 100 }),
      this.dk.get<SearchPage<SearchCompose>>("compose.search", { description: MARKER, limit: 100 }),
    ]);
    const envIndex = new Map<string, { projectId: string; projectName: string; environmentName: string }>();
    for (const p of projects) {
      for (const e of p.environments) envIndex.set(e.environmentId, { projectId: p.projectId, projectName: p.name, environmentName: e.name });
    }
    const where = (environmentId: string) =>
      envIndex.get(environmentId) ?? { projectId: "", projectName: "?", environmentName: "?" };
    const services: ManagedService[] = [];
    for (const a of apps.items) {
      const repo = repoFromDescription(a.description);
      if (repo) {
        services.push({ kind: "application", id: a.applicationId, name: a.name, appName: a.appName, repo, status: a.applicationStatus, environmentId: a.environmentId, ...where(a.environmentId) });
      }
    }
    for (const c of composes.items) {
      const repo = repoFromDescription(c.description);
      if (repo) {
        services.push({ kind: "compose", id: c.composeId, name: c.name, appName: c.appName, repo, status: c.composeStatus, environmentId: c.environmentId, ...where(c.environmentId) });
      }
    }
    return services;
  }

  async findByRepo(ref: RepoRef): Promise<ManagedService[]> {
    const key = repoKey(ref);
    return (await this.listManaged()).filter((s) => s.repo === key);
  }

  async dnsReport(host: string): Promise<DnsReport & { serverIps: string[] }> {
    const serverIps = await serverAddresses(this.cfg.dokployUrl, this.resolver);
    const report = await checkDomain(host, serverIps, this.resolver);
    return { ...report, serverIps: [...serverIps] };
  }

  async latestDeploymentId(service: ManagedService): Promise<string | null> {
    const list = await this.deployments(service).catch(() => []);
    const newest = [...list].sort((a, b) => String(b.createdAt ?? "").localeCompare(String(a.createdAt ?? "")))[0];
    return newest?.deploymentId ?? null;
  }

  async usedHosts(): Promise<Set<string>> {
    const rows = await this.dk.get<{ host: string }[]>("overview.domains");
    return new Set(rows.map((row) => row.host.toLowerCase()));
  }

  async domainsOf(service: ManagedService): Promise<DkDomain[]> {
    return service.kind === "application"
      ? this.dk.get<DkDomain[]>("domain.byApplicationId", { applicationId: service.id })
      : this.dk.get<DkDomain[]>("domain.byComposeId", { composeId: service.id });
  }

  dashboardUrl(service: Pick<ManagedService, "kind" | "id" | "projectId" | "environmentId">): string {
    return `${this.cfg.dokployUrl}/dashboard/project/${service.projectId}/environment/${service.environmentId}/services/${service.kind}/${service.id}`;
  }

  async buildLog(deploymentId: string, tail = 80): Promise<string | null> {
    const text = await this.dk.get<string>("deployment.readLogs", { deploymentId, tail }).catch(() => null);
    return typeof text === "string" && text.trim() ? text : null;
  }

  async runtimeLog(service: ManagedService, tail = 200): Promise<string | null> {
    if (service.kind === "application") {
      const text = await this.dk.get<string>("application.readLogs", { applicationId: service.id, tail });
      return typeof text === "string" && text.trim() ? text : null;
    }
    const containers = await this.dk.get<{ containerId: string; name: string }[]>("docker.getContainersByAppNameMatch", {
      appName: service.appName,
      appType: "docker-compose",
    });
    const parts = await Promise.all(
      containers.slice(0, 3).map(async (c) => {
        const text = await this.dk.get<string>("compose.readLogs", { composeId: service.id, containerId: c.containerId, tail });
        return typeof text === "string" && text.trim() ? `===== ${c.name} =====\n${text}` : "";
      }),
    );
    const joined = parts.filter(Boolean).join("\n\n");
    return joined || null;
  }

  private async githubAppId(repo: RepoRef): Promise<string | null> {
    const providers = await this.dk.get<DkGithubProvider[]>("github.githubProviders");
    for (const provider of providers) {
      const repos = await this.dk
        .get<DkGithubRepo[]>("github.getGithubRepositories", { githubId: provider.githubId })
        .catch(() => [] as DkGithubRepo[]);
      if (repos.some((r) => repoKey({ owner: r.owner.login, repo: r.name }) === repoKey(repo))) return provider.githubId;
    }
    return null;
  }

  private async resolveTarget(target: Target, reporter: Reporter) {
    const projects = await this.listProjects();
    let project = target.projectId
      ? projects.find((p) => p.projectId === target.projectId)
      : projects.find((p) => p.name === target.projectName);
    if (target.projectId && !project) throw new Error(`Dokploy 프로젝트를 찾을 수 없어: ${target.projectName}`);
    if (!project) {
      const created = await this.dk.post<{ project: { projectId: string; name: string }; environment: { environmentId: string; name: string } }>(
        "project.create",
        { name: target.projectName, description: "Created by deploy-bot" },
      );
      project = {
        projectId: created.project.projectId,
        name: created.project.name,
        environments: [{ environmentId: created.environment.environmentId, name: created.environment.name, isDefault: true }],
      };
      await reporter.step(`프로젝트 만들었어: ${project.name}`);
    }
    let env = target.environmentId
      ? project.environments.find((e) => e.environmentId === target.environmentId)
      : project.environments.find((e) => e.name === target.environmentName);
    if (target.environmentId && !env) throw new Error(`Dokploy 환경을 찾을 수 없어: ${target.environmentName}`);
    if (!env) {
      const created = await this.dk.post<{ environmentId: string; name: string }>("environment.create", {
        name: target.environmentName,
        projectId: project.projectId,
        description: "Created by deploy-bot",
      });
      env = { environmentId: created.environmentId, name: created.name, isDefault: false };
      await reporter.step(`환경 만들었어: ${env.name}`);
    }
    return { projectId: project.projectId, projectName: project.name, environmentId: env.environmentId, environmentName: env.name };
  }

  private url(host: string) {
    return publicUrl(this.cfg, host);
  }

  private domainBody(host: string, port: number, dns: DnsState | null | undefined) {
    return { host, path: "/", port, ...dokployDomainTls(this.cfg, dns) };
  }

  async deploy(req: DeployRequest, reporter: Reporter): Promise<DeployResult> {
    const { repo, plan } = req;
    const where = await this.resolveTarget(req.target, reporter);
    const githubId = await this.githubAppId(repo);
    if (!githubId && repo.private) {
      throw new Error("비공개 레포인데 Dokploy GitHub App이 이 레포에 접근 권한이 없어. Dokploy GitHub App 설치 범위에 레포를 추가해줘.");
    }

    const base = {
      name: repo.repo,
      appName: repo.repo.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").slice(0, 40),
      description: describeService(repo),
      environmentId: where.environmentId,
      serverId: this.cfg.dokployServerId,
    };
    const sourceLabel = githubId ? "GitHub App" : "공개 git URL";

    let service: ManagedService;
    if (plan.kind === "compose") {
      const compose = await this.dk.post<{ composeId: string; appName: string }>("compose.create", {
        ...base,
        composeType: "docker-compose",
      });
      service = { kind: "compose", id: compose.composeId, name: repo.repo, appName: compose.appName, repo: repoKey(repo), status: "idle", ...where };
      const source = githubId
        ? { sourceType: "github", githubId, owner: repo.owner, repository: repo.repo, branch: repo.defaultBranch }
        : { sourceType: "git", customGitUrl: repo.cloneUrl, customGitBranch: repo.defaultBranch };
      await this.dk.post("compose.update", { composeId: compose.composeId, ...source, composePath: plan.composePath });
      await reporter.step(`Compose 서비스 만들고 소스 연결 (${sourceLabel})`);
      if (req.domain) {
        await this.dk.post("domain.create", {
          ...this.domainBody(req.domain, plan.port, req.dns),
          composeId: compose.composeId,
          serviceName: plan.serviceName,
          domainType: "compose",
        });
        await reporter.step(`도메인 연결: ${req.domain} → ${plan.serviceName}:${plan.port}`);
      }
    } else {
      const app = await this.dk.post<{ applicationId: string; appName: string }>("application.create", base);
      service = { kind: "application", id: app.applicationId, name: repo.repo, appName: app.appName, repo: repoKey(repo), status: "idle", ...where };
      if (githubId) {
        await this.dk.post("application.saveGithubProvider", {
          applicationId: app.applicationId,
          githubId,
          owner: repo.owner,
          repository: repo.repo,
          branch: repo.defaultBranch,
          buildPath: "/",
          triggerType: "push",
          enableSubmodules: false,
        });
      } else {
        await this.dk.post("application.saveGitProvider", {
          applicationId: app.applicationId,
          customGitUrl: repo.cloneUrl,
          customGitBranch: repo.defaultBranch,
          customGitBuildPath: "/",
          watchPaths: null,
          enableSubmodules: false,
        });
      }
      if (plan.generateDockerfile) {
        if (!this.cfg.ai) throw new Error("AI 키가 없어서 Dockerfile을 만들 수 없어. OLLAMA/MISTRAL/OPENROUTER 키 중 하나를 넣어줘");
        await reporter.step("AI가 Dockerfile 만드는 중");
        await this.injectAiDockerfile(service, req, plan.port, null, null, reporter, null);
      } else {
        await this.saveBuildType(app.applicationId, plan.buildType, plan.dockerfile);
      }
      if (plan.setPortEnv) {
        await this.dk.post("application.saveEnvironment", {
          applicationId: app.applicationId,
          env: `PORT=${plan.port}`,
          buildArgs: null,
          buildSecrets: null,
          createEnvFile: false,
        });
      }
      await reporter.step(`앱 만들고 소스 연결 (${sourceLabel}) · ${this.buildLabel(plan)}`);
      if (req.domain) {
        await this.dk.post("domain.create", {
          ...this.domainBody(req.domain, plan.port, req.dns),
          applicationId: app.applicationId,
          domainType: "application",
        });
        await reporter.step(`도메인 연결: ${req.domain} → :${plan.port}`);
      }
    }

    await reporter.step("빌드 시작");
    let outcome = await this.runAndWait(service, "deploy", reporter);
    let usedAiDockerfile = plan.kind === "application" && plan.generateDockerfile === true;

    const autoBuilder = plan.kind === "application" && !plan.generateDockerfile && plan.buildType !== "dockerfile";
    if (outcome.status === "error" && autoBuilder) {
      if (!this.cfg.ai) {
        await reporter.step("빌드 실패. AI 키가 없어서 Dockerfile 자동 생성은 건너뜀");
      } else {
        const result = await this.aiFallback(service, req, plan.port, outcome.logTail, reporter);
        outcome = result.outcome;
        usedAiDockerfile = result.used;
      }
    }

    if (outcome.status === "error" && plan.kind === "compose") {
      const src: ComposeSource = { ref: { owner: repo.owner, repo: repo.repo }, branch: repo.defaultBranch, path: plan.composePath };
      outcome = await this.repairCompose(service, src, outcome, reporter);
    }

    return {
      ...outcome,
      service,
      url: req.domain ? this.url(req.domain) : null,
      buildLabel: plan.kind === "compose" ? `Docker Compose ${plan.composePath}` : this.buildLabel(plan),
      usedAiDockerfile,
      logTail: outcome.status === "done" ? null : outcome.logTail,
    };
  }

  private buildLabel(plan: Extract<BuildPlan, { kind: "application" }>): string {
    if (plan.generateDockerfile) return "AI Dockerfile";
    if (plan.buildType === "railpack") return `Railpack ${this.cfg.railpackVersion}`;
    if (plan.buildType === "dockerfile") return `Dockerfile ${plan.dockerfile}`;
    return plan.buildType;
  }

  private async saveBuildType(applicationId: string, buildType: AppBuildType, dockerfile: string | null) {
    await this.dk.post("application.saveBuildType", {
      applicationId,
      buildType,
      dockerfile: dockerfile ?? "Dockerfile",
      dockerContextPath: null,
      dockerBuildStage: null,
      herokuVersion: buildType === "heroku_buildpacks" ? "24" : null,
      railpackVersion: this.cfg.railpackVersion,
      publishDirectory: null,
      isStaticSpa: buildType === "static" ? true : null,
    });
  }

  private patchIds = new Map<string, string>();

  async usedHostPorts(): Promise<Set<number>> {
    const rows = await this.dk.get<{ ports?: string }[]>("docker.getContainers").catch(() => []);
    const used = new Set<number>([80, 443]);
    const own = Number(new URL(this.cfg.dokployUrl).port);
    if (own) used.add(own);
    for (const row of rows) {
      for (const m of (row.ports ?? "").matchAll(/(?:\d+\.\d+\.\d+\.\d+|\[[\da-f:]*\]):(\d+)->/gi)) used.add(Number(m[1]));
    }
    return used;
  }

  private async composeSource(service: ManagedService): Promise<ComposeSource | null> {
    const one = await this.dk.get<{ owner?: string | null; repository?: string | null; composePath?: string | null; branch?: string | null; customGitBranch?: string | null }>("compose.one", { composeId: service.id });
    const [ownerFromName, repoFromName] = service.repo.split("/");
    const owner = one.owner || ownerFromName;
    const repo = one.repository || repoFromName;
    if (!owner || !repo) return null;
    return { ref: { owner, repo }, branch: one.branch || one.customGitBranch || "main", path: one.composePath || "docker-compose.yml" };
  }

  private async portPatch(service: ManagedService, path: string): Promise<PatchRow | null> {
    const rows = await this.dk.get<PatchRow[]>("patch.byEntityId", { id: service.id, type: service.kind }).catch(() => []);
    const target = path.replace(/^\.\//, "");
    return (Array.isArray(rows) ? rows : []).find((row) => row.filePath === target && typeof row.content === "string" && (parsePortMaps(row.content).size > 0 || parseNameMaps(row.content).size > 0)) ?? null;
  }

  async usedContainerNames(): Promise<Set<string>> {
    const rows = await this.dk.get<{ name?: string }[]>("docker.getContainers").catch(() => []);
    return new Set((Array.isArray(rows) ? rows : []).map((row) => (row.name ?? "").replace(/^\//, "")).filter(Boolean));
  }

  async rerun(service: ManagedService, mode: "deploy" | "redeploy", reporter: Reporter): Promise<RunOutcome> {
    if (service.kind !== "compose") return this.runAndWait(service, mode, reporter);
    const src = await this.composeSource(service).catch(() => null);
    if (src && mode === "deploy") await this.refreshPortPatch(service, src, reporter);
    const outcome = await this.runAndWait(service, mode, reporter);
    return outcome.status === "error" && src ? this.repairCompose(service, src, outcome, reporter) : outcome;
  }

  private async refreshPortPatch(service: ManagedService, src: ComposeSource, reporter: Reporter): Promise<void> {
    const filePath = src.path.replace(/^\.\//, "");
    const existing = await this.portPatch(service, filePath);
    if (!existing) return;
    const upstream = await this.gh.fileOrNull(src.ref, src.branch, filePath).catch(() => null);
    if (upstream === null) return;
    const fresh = renderPortPatch(upstream, parsePortMaps(existing.content), parseNameMaps(existing.content));
    if (fresh === null) {
      await this.dk.post("patch.delete", { patchId: existing.patchId });
      await reporter.step("compose의 포트·이름 구성이 바뀌어서 예전 수정을 지웠어");
      return;
    }
    if (fresh !== existing.content) {
      await this.dk.post("patch.update", { patchId: existing.patchId, content: fresh, type: "update", enabled: true });
      await reporter.step("최신 compose에 포트·이름 수정을 다시 적용했어");
    }
  }

  private async repairCompose(service: ManagedService, src: ComposeSource, first: RunOutcome, reporter: Reporter): Promise<RunOutcome> {
    const filePath = src.path.replace(/^\.\//, "");
    const upstream = await this.gh.fileOrNull(src.ref, src.branch, filePath).catch(() => null);
    let outcome = first;
    for (let attempt = 1; attempt <= MAX_COMPOSE_FIXES; attempt++) {
      const lines = errorLines(outcome.logTail ?? "");
      if (lines.length === 0) return outcome;
      let fault = detectFault(lines);
      if (fault.kind === "unknown" && this.cfg.ai) {
        const verdict = await classifyWithAi(this.cfg.ai, lines, this.aiFetch);
        if (verdict?.fault.kind === "port_conflict") {
          fault = verdict.fault;
          await reporter.step(`AI가 error 줄을 보고 포트 충돌로 판단 (${verdict.provider})`);
        }
      }
      if (fault.kind === "unknown") return outcome;
      if (upstream === null) {
        await reporter.step(`충돌을 찾았지만 ${filePath}를 읽지 못해서 자동으로 못 고쳐`);
        return outcome;
      }
      const existing = await this.portPatch(service, filePath);
      const ports = existing ? parsePortMaps(existing.content) : new Map<number, number>();
      const names = existing ? parseNameMaps(existing.content) : new Map<string, string>();
      let message: string;
      if (fault.kind === "port_conflict") {
        const original = [...ports].find(([, to]) => to === fault.port)?.[0] ?? fault.port;
        const used = await this.usedHostPorts();
        used.add(fault.port);
        for (const to of ports.values()) used.add(to);
        const next = pickFreePort(fault.port, used);
        ports.set(original, next);
        message = `호스트 포트 ${fault.port} 충돌 → ${next}로 바꿔서 다시 배포`;
      } else {
        const original = [...names].find(([, to]) => to === fault.name)?.[0] ?? fault.name;
        const used = await this.usedContainerNames();
        used.add(fault.name);
        for (const to of names.values()) used.add(to);
        const next = pickFreeName(original, uniqueSuffix(service.appName), used);
        names.set(original, next);
        message = `컨테이너 이름 ${fault.name} 충돌 → ${next}로 바꿔서 다시 배포`;
      }
      const content = renderPortPatch(upstream, ports, names);
      if (content === null) {
        await reporter.step(`충돌 대상이 ${filePath}에 직접 적혀 있지 않아서 자동으로 못 고쳐 (환경변수로 받는 값일 수 있어)`);
        return outcome;
      }
      if (existing) {
        await this.dk.post("patch.update", { patchId: existing.patchId, content, type: "update", enabled: true });
      } else {
        await this.dk.post<DkPatch>("patch.create", { composeId: service.id, filePath, content, type: "update", enabled: true });
      }
      await reporter.step(`${message} (${attempt}/${MAX_COMPOSE_FIXES})`);
      outcome = await this.runAndWait(service, "deploy", reporter);
      if (outcome.status !== "error") return outcome;
    }
    return outcome;
  }

  private async injectAiDockerfile(
    service: ManagedService,
    req: DeployRequest,
    port: number,
    failureLog: string | null,
    previous: string | null,
    reporter: Reporter,
    attempt: { n: number; of: number } | null,
  ): Promise<string> {
    const ai = this.cfg.ai;
    if (!ai) throw new Error("AI is not configured");
    const readFile = (path: string) => this.gh.fileOrNull(req.repo, req.repo.defaultBranch, path);
    if (attempt) await reporter.step(`빌드 실패 → AI가 Dockerfile 만드는 중 (${attempt.n}/${attempt.of})`);
    const generated = await generateDockerfile(
      ai,
      { repo: repoKey(req.repo), files: req.files, readFile, port, failureLog, previousDockerfile: previous },
      this.aiFetch,
    );
    for (const failure of generated.failures) await reporter.step(`AI 제공자 실패, 다음으로 넘김 (${failure.split(":")[0]})`);
    await reporter.step(`${generated.provider} (${generated.model})가 Dockerfile 생성`);
    const patchId = this.patchIds.get(service.id);
    if (patchId) {
      await this.dk.post("patch.update", { patchId, content: generated.dockerfile, type: "create", enabled: true });
    } else {
      const patch = await this.dk.post<DkPatch>("patch.create", {
        applicationId: service.id,
        filePath: AI_DOCKERFILE,
        content: generated.dockerfile,
        type: "create",
        enabled: true,
      });
      this.patchIds.set(service.id, patch.patchId);
      await this.saveBuildType(service.id, "dockerfile", AI_DOCKERFILE);
    }
    return generated.dockerfile;
  }

  private async aiFallback(
    service: ManagedService,
    req: DeployRequest,
    port: number,
    firstLog: string | null,
    reporter: Reporter,
  ): Promise<{ outcome: RunOutcome; used: boolean }> {
    const ai = this.cfg.ai;
    if (!ai) throw new Error("AI is not configured");
    let log = firstLog;
    let previous: string | null = null;
    let outcome: RunOutcome = { status: "error", logTail: firstLog, deploymentId: null };
    for (let n = 1; n <= ai.maxAttempts; n++) {
      previous = await this.injectAiDockerfile(service, req, port, log, previous, reporter, { n, of: ai.maxAttempts });
      await reporter.step(`${AI_DOCKERFILE} 넣고 다시 빌드`);
      outcome = await this.runAndWait(service, "deploy", reporter);
      if (outcome.status !== "error") return { outcome, used: true };
      log = outcome.logTail;
    }
    return { outcome, used: true };
  }

  private async deployments(service: ManagedService): Promise<DkDeployment[]> {
    return service.kind === "application"
      ? this.dk.get<DkDeployment[]>("deployment.all", { applicationId: service.id })
      : this.dk.get<DkDeployment[]>("deployment.allByCompose", { composeId: service.id });
  }

  /** "deploy" pulls the latest commit and builds; "redeploy" rebuilds the already-cloned code. */
  async runAndWait(service: ManagedService, mode: "deploy" | "redeploy", reporter: Reporter): Promise<RunOutcome> {
    const before = new Set((await this.deployments(service)).map((d) => d.deploymentId));
    const idField = service.kind === "application" ? { applicationId: service.id } : { composeId: service.id };
    await this.dk.post(`${service.kind}.${mode}`, { ...idField, title: `deploy-bot ${mode}` });

    const deadline = this.now() + this.cfg.deployTimeoutMs;
    const maxPolls = Math.ceil(this.cfg.deployTimeoutMs / this.cfg.pollIntervalMs) + 1;
    let current: DkDeployment | undefined;
    for (let poll = 0; poll < maxPolls && this.now() < deadline; poll++) {
      await this.sleep(this.cfg.pollIntervalMs);
      current = (await this.deployments(service)).find((d) => !before.has(d.deploymentId));
      if (!current) continue;
      if (TERMINAL.has(current.status)) {
        const status = current.status as "done" | "error" | "cancelled";
        return {
          status,
          logTail: status === "done" ? null : await this.buildLog(current.deploymentId),
          deploymentId: current.deploymentId,
        };
      }
      if (reporter.log) {
        const tail = await this.buildLog(current.deploymentId, LIVE_LOG_LINES);
        if (tail) await reporter.log(tail);
      }
    }
    return { status: "timeout", logTail: null, deploymentId: current?.deploymentId ?? null };
  }
}
