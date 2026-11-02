export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export class DokployError extends Error {
  constructor(
    readonly path: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(`Dokploy ${path} -> ${status}: ${body.slice(0, 300)}`);
  }
}

type Query = Record<string, string | number | boolean | undefined>;

export class Dokploy {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  private async parse<T>(path: string, res: Response): Promise<T> {
    const text = await res.text();
    if (!res.ok) throw new DokployError(path, res.status, text);
    if (!text) return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      return text as T;
    }
  }

  async get<T>(path: string, query: Query = {}): Promise<T> {
    const url = new URL(`${this.baseUrl}/api/${path}`);
    for (const [k, v] of Object.entries(query)) if (v !== undefined) url.searchParams.set(k, String(v));
    const res = await this.fetchImpl(url, { headers: { "x-api-key": this.apiKey } });
    return this.parse<T>(path, res);
  }

  async post<T>(path: string, body: unknown): Promise<T> {
    const res = await this.fetchImpl(`${this.baseUrl}/api/${path}`, {
      method: "POST",
      headers: { "x-api-key": this.apiKey, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return this.parse<T>(path, res);
  }
}

// Fields the bot reads, per Dokploy v0.30.10 OpenAPI.
export interface DkService {
  name: string;
  appName: string;
  description: string | null;
}
export interface DkApplicationSummary extends DkService {
  applicationId: string;
  applicationStatus: string;
}
export interface DkComposeSummary extends DkService {
  composeId: string;
  composeStatus: string;
}
export interface DkEnvironment {
  environmentId: string;
  name: string;
  isDefault: boolean;
  applications: DkApplicationSummary[];
  compose: DkComposeSummary[];
}
export interface DkProject {
  projectId: string;
  name: string;
  environments: DkEnvironment[];
}
export interface DkDeployment {
  deploymentId: string;
  status: "running" | "done" | "error" | "cancelled" | string;
  title: string;
  createdAt: string;
  errorMessage: string | null;
}
export interface DkDomain {
  domainId: string;
  host: string;
  https: boolean;
  port: number | null;
}
export interface DkPatch {
  patchId: string;
  filePath: string;
  type: string;
  enabled: boolean;
}
export interface DkGithubProvider {
  githubId: string;
}
export interface DkGithubRepo {
  name: string;
  owner: { login: string };
}
