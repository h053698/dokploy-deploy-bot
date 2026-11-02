import { lookup } from "node:dns/promises";
import { generateDockerfile } from "./ai.ts";
import type { BuildPlan } from "./analyze.ts";
import type { Config } from "./config.ts";
import type {
  DkDeployment,
  DkDomain,
  DkGithubProvider,
  DkGithubRepo,
  DkPatch,
  DkProject,
  Dokploy,
  FetchLike,
} from "./dokploy.ts";
import { type GitHub, type RepoInfo, type RepoRef, repoKey } from "./github.ts";

export type ServiceKind = "application" | "compose";

export interface ManagedService {
  kind: ServiceKind;
  id: string;
  name: string;
  appName: string;
  repo: string;
  status: string;
}

export interface DeployRequest {
  repo: RepoInfo;
  files: string[];
  plan: BuildPlan;
  domain: string | null;
}

export interface DeployResult {
  service: ManagedService;
  status: "done" | "error" | "cancelled" | "timeout";
  url: string | null;
  usedAiDockerfile: boolean;
  logTail: string | null;
}

export type Progress = (line: string) => Promise<void> | void;

const AI_DOCKERFILE = "Dockerfile.deploy-bot";
const MARKER = "deploy-bot repo:";
const TERMINAL = new Set(["done", "error", "cancelled"]);

export const describeService = (repo: RepoRef) => `${MARKER}${repoKey(repo)}`;

export function repoFromDescription(description: string | null): string | null {
  const m = description?.match(/deploy-bot repo:(\S+)/);
  return m?.[1] ?? null;
}

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export interface DeployerHooks {
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  resolveHost?: (host: string) => Promise<boolean>;
  aiFetch?: FetchLike;
}

const resolvesViaDns = async (host: string) => {
  try {
    await lookup(host);
    return true;
  } catch {
    return false;
  }
};

export class Deployer {
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly resolveHost: (host: string) => Promise<boolean>;
  private readonly aiFetch: FetchLike;

  constructor(
    private readonly cfg: Config,
    private readonly dk: Dokploy,
    private readonly gh: GitHub,
    hooks: DeployerHooks = {},
  ) {
    this.sleep = hooks.sleep ?? delay;
    this.now = hooks.now ?? Date.now;
    this.resolveHost = hooks.resolveHost ?? resolvesViaDns;
    this.aiFetch = hooks.aiFetch ?? fetch;
  }

  private async findProject(): Promise<DkProject | null> {
    const projects = await this.dk.get<DkProject[]>("project.all");
    return projects.find((p) => p.name === this.cfg.dokployProject) ?? null;
  }

  private async environmentId(): Promise<string> {
    const project = await this.findProject();
    if (project) {
      const env = project.environments.find((e) => e.isDefault) ?? project.environments[0];
      if (env) return env.environmentId;
    }
    const created = await this.dk.post<{ environment: { environmentId: string } }>("project.create", {
      name: this.cfg.dokployProject,
      description: "Telegram deploy bot managed services",
    });
    return created.environment.environmentId;
  }

  async listManaged(): Promise<ManagedService[]> {
    const summary = await this.findProject();
    if (!summary) return [];
    const project = await this.dk.get<DkProject>("project.one", { projectId: summary.projectId });
    const services: ManagedService[] = [];
    for (const env of project.environments) {
      for (const a of env.applications) {
        const repo = repoFromDescription(a.description);
        if (repo) services.push({ kind: "application", id: a.applicationId, name: a.name, appName: a.appName, repo, status: a.applicationStatus });
      }
      for (const c of env.compose) {
        const repo = repoFromDescription(c.description);
        if (repo) services.push({ kind: "compose", id: c.composeId, name: c.name, appName: c.appName, repo, status: c.composeStatus });
      }
    }
    return services;
  }

  async findByRepo(ref: RepoRef): Promise<ManagedService | null> {
    const key = repoKey(ref);
    return (await this.listManaged()).find((s) => s.repo === key) ?? null;
  }

  domainResolves(host: string): Promise<boolean> {
    return this.resolveHost(host);
  }

  async domainsOf(service: ManagedService): Promise<DkDomain[]> {
    return service.kind === "application"
      ? this.dk.get<DkDomain[]>("domain.byApplicationId", { applicationId: service.id })
      : this.dk.get<DkDomain[]>("domain.byComposeId", { composeId: service.id });
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

  private url(host: string) {
    return `${this.cfg.https ? "https" : "http"}://${host}`;
  }

  private domainBody(host: string, port: number) {
    return {
      host,
      path: "/",
      port,
      https: this.cfg.https,
      certificateType: this.cfg.https ? "letsencrypt" : "none",
    };
  }

  async deploy(req: DeployRequest, progress: Progress): Promise<DeployResult> {
    const { repo, plan } = req;
    const environmentId = await this.environmentId();
    const githubId = await this.githubAppId(repo);
    if (!githubId && repo.private) {
      throw new Error("비공개 레포인데 Dokploy GitHub App이 이 레포에 접근 권한이 없어. Dokploy GitHub App 설치 범위에 레포를 추가해줘.");
    }
    await progress(githubId ? "Dokploy GitHub App으로 소스 연결" : "공개 git URL로 소스 연결");

    const base = {
      name: repo.repo,
      appName: repo.repo.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").slice(0, 40),
      description: describeService(repo),
      environmentId,
      serverId: this.cfg.dokployServerId,
    };

    let service: ManagedService;
    if (plan.kind === "compose") {
      const compose = await this.dk.post<{ composeId: string; appName: string }>("compose.create", {
        ...base,
        composeType: "docker-compose",
      });
      service = { kind: "compose", id: compose.composeId, name: repo.repo, appName: compose.appName, repo: repoKey(repo), status: "idle" };
      await progress(`Dokploy compose 생성: ${compose.appName}`);
      const source = githubId
        ? { sourceType: "github", githubId, owner: repo.owner, repository: repo.repo, branch: repo.defaultBranch }
        : { sourceType: "git", customGitUrl: repo.cloneUrl, customGitBranch: repo.defaultBranch };
      await this.dk.post("compose.update", { composeId: compose.composeId, ...source, composePath: plan.composePath });
      if (req.domain) {
        await this.dk.post("domain.create", {
          ...this.domainBody(req.domain, plan.port),
          composeId: compose.composeId,
          serviceName: plan.serviceName,
          domainType: "compose",
        });
        await progress(`도메인 연결: ${req.domain} -> ${plan.serviceName}:${plan.port}`);
      }
    } else {
      const app = await this.dk.post<{ applicationId: string; appName: string }>("application.create", base);
      service = { kind: "application", id: app.applicationId, name: repo.repo, appName: app.appName, repo: repoKey(repo), status: "idle" };
      await progress(`Dokploy 앱 생성: ${app.appName}`);
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
      await this.saveBuildType(app.applicationId, plan.buildType, plan.dockerfile);
      if (plan.setPortEnv) {
        await this.dk.post("application.saveEnvironment", {
          applicationId: app.applicationId,
          env: `PORT=${plan.port}`,
          buildArgs: null,
          buildSecrets: null,
          createEnvFile: false,
        });
      }
      await progress(`빌드 방식: ${plan.buildType === "railpack" ? `Railpack ${this.cfg.railpackVersion}` : `Dockerfile (${plan.dockerfile})`}`);
      if (req.domain) {
        await this.dk.post("domain.create", {
          ...this.domainBody(req.domain, plan.port),
          applicationId: app.applicationId,
          domainType: "application",
        });
        await progress(`도메인 연결: ${req.domain} -> :${plan.port}`);
      }
    }

    await progress("배포 시작");
    let outcome = await this.runAndWait(service, "deploy", progress);
    let usedAiDockerfile = false;

    if (outcome.status === "error" && plan.kind === "application" && plan.buildType === "railpack") {
      if (!this.cfg.ai) {
        await progress("Railpack 빌드 실패. AI_API_KEY가 없어서 Dockerfile 자동 생성은 건너뜀");
      } else {
        const result = await this.aiFallback(service, req, plan.port, outcome.logTail, progress);
        outcome = result.outcome;
        usedAiDockerfile = result.used;
      }
    }

    return {
      service,
      status: outcome.status,
      url: req.domain ? this.url(req.domain) : null,
      usedAiDockerfile,
      logTail: outcome.status === "done" ? null : outcome.logTail,
    };
  }

  private async saveBuildType(applicationId: string, buildType: "dockerfile" | "railpack", dockerfile: string | null) {
    await this.dk.post("application.saveBuildType", {
      applicationId,
      buildType,
      dockerfile: dockerfile ?? "Dockerfile",
      dockerContextPath: null,
      dockerBuildStage: null,
      herokuVersion: null,
      railpackVersion: this.cfg.railpackVersion,
    });
  }

  private async aiFallback(
    service: ManagedService,
    req: DeployRequest,
    port: number,
    firstLog: string | null,
    progress: Progress,
  ): Promise<{ outcome: Awaited<ReturnType<Deployer["runAndWait"]>>; used: boolean }> {
    const ai = this.cfg.ai;
    if (!ai) throw new Error("AI is not configured");
    const readFile = (path: string) => this.gh.fileOrNull(req.repo, req.repo.defaultBranch, path);
    let log = firstLog;
    let previous: string | null = null;
    let patchId: string | null = null;
    let outcome: Awaited<ReturnType<Deployer["runAndWait"]>> = { status: "error", logTail: firstLog };

    for (let attempt = 1; attempt <= ai.maxAttempts; attempt++) {
      await progress(`Railpack 실패 -> AI로 Dockerfile 생성 중 (${attempt}/${ai.maxAttempts})`);
      const dockerfile = await generateDockerfile(
        ai,
        {
          repo: repoKey(req.repo),
          files: req.files,
          readFile,
          port,
          failureLog: log,
          previousDockerfile: previous,
        },
        this.aiFetch,
      );
      if (patchId) {
        await this.dk.post("patch.update", { patchId, content: dockerfile, type: "create", enabled: true });
      } else {
        const patch = await this.dk.post<DkPatch>("patch.create", {
          applicationId: service.id,
          filePath: AI_DOCKERFILE,
          content: dockerfile,
          type: "create",
          enabled: true,
        });
        patchId = patch.patchId;
        await this.saveBuildType(service.id, "dockerfile", AI_DOCKERFILE);
      }
      await progress(`${AI_DOCKERFILE} 주입 후 Dockerfile 빌드로 재배포`);
      outcome = await this.runAndWait(service, "deploy", progress);
      if (outcome.status !== "error") return { outcome, used: true };
      log = outcome.logTail;
      previous = dockerfile;
    }
    return { outcome, used: true };
  }

  private async deployments(service: ManagedService): Promise<DkDeployment[]> {
    return service.kind === "application"
      ? this.dk.get<DkDeployment[]>("deployment.all", { applicationId: service.id })
      : this.dk.get<DkDeployment[]>("deployment.allByCompose", { composeId: service.id });
  }

  private async logTail(deploymentId: string): Promise<string | null> {
    const text = await this.dk.get<string>("deployment.readLogs", { deploymentId, tail: 80 }).catch(() => null);
    return typeof text === "string" && text.trim() ? text : null;
  }

  /** "deploy" pulls the latest commit and builds; "redeploy" rebuilds the already-cloned code. */
  async runAndWait(
    service: ManagedService,
    mode: "deploy" | "redeploy",
    progress: Progress,
  ): Promise<{ status: DeployResult["status"]; logTail: string | null }> {
    const before = new Set((await this.deployments(service)).map((d) => d.deploymentId));
    const idField = service.kind === "application" ? { applicationId: service.id } : { composeId: service.id };
    await this.dk.post(`${service.kind}.${mode}`, { ...idField, title: `deploy-bot ${mode}` });

    const deadline = this.now() + this.cfg.deployTimeoutMs;
    let announced = false;
    while (this.now() < deadline) {
      await this.sleep(this.cfg.pollIntervalMs);
      const current = (await this.deployments(service)).find((d) => !before.has(d.deploymentId));
      if (!current) continue;
      if (!announced) {
        announced = true;
        await progress("빌드 진행 중...");
      }
      if (TERMINAL.has(current.status)) {
        const status = current.status as "done" | "error" | "cancelled";
        return { status, logTail: status === "done" ? null : await this.logTail(current.deploymentId) };
      }
    }
    return { status: "timeout", logTail: null };
  }
}
