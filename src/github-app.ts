import { createSign } from "node:crypto";
import type { Dokploy, FetchLike } from "./dokploy.ts";
import { type RepoRef, repoKey } from "./github.ts";

interface AppCredentials {
  githubAppId: number | string;
  githubInstallationId: string;
  githubPrivateKey: string;
}

interface CachedToken {
  token: string;
  expiresAt: number;
}

const REPO_LIST_TTL_MS = 5 * 60_000;
const TOKEN_SAFETY_MS = 5 * 60_000;

export function createAppJwt(appId: number | string, privateKeyPem: string, nowMs: number): string {
  const now = Math.floor(nowMs / 1000);
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const unsigned = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({ iat: now - 60, exp: now + 540, iss: String(appId) })}`;
  const signature = createSign("RSA-SHA256").update(unsigned).sign(privateKeyPem).toString("base64url");
  return `${unsigned}.${signature}`;
}

export class GitHubAppTokens {
  private repoLists = new Map<string, { keys: Set<string>; loadedAt: number }>();
  private tokens = new Map<string, CachedToken>();

  constructor(
    private readonly dk: Dokploy,
    private readonly githubApiUrl: string,
    private readonly fetchImpl: FetchLike = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  private async reposOf(githubId: string): Promise<Set<string>> {
    const cached = this.repoLists.get(githubId);
    if (cached && this.now() - cached.loadedAt < REPO_LIST_TTL_MS) return cached.keys;
    const repos = await this.dk.get<{ name: string; owner: { login: string } }[]>("github.getGithubRepositories", { githubId });
    const keys = new Set(repos.map((r) => repoKey({ owner: r.owner.login, repo: r.name })));
    this.repoLists.set(githubId, { keys, loadedAt: this.now() });
    return keys;
  }

  private async installationToken(githubId: string): Promise<string> {
    const cached = this.tokens.get(githubId);
    if (cached && cached.expiresAt - TOKEN_SAFETY_MS > this.now()) return cached.token;
    const creds = await this.dk.get<AppCredentials>("github.one", { githubId });
    const jwt = createAppJwt(creds.githubAppId, creds.githubPrivateKey, this.now());
    const res = await this.fetchImpl(`${this.githubApiUrl}/app/installations/${creds.githubInstallationId}/access_tokens`, {
      method: "POST",
      headers: { authorization: `Bearer ${jwt}`, accept: "application/vnd.github+json", "user-agent": "dokploy-deploy-bot" },
    });
    if (!res.ok) throw new Error(`GitHub App 토큰 발급 실패 (${res.status}): ${(await res.text()).slice(0, 200)}`);
    const body = (await res.json()) as { token: string; expires_at: string };
    this.tokens.set(githubId, { token: body.token, expiresAt: Date.parse(body.expires_at) });
    return body.token;
  }

  async tokenFor(ref: RepoRef): Promise<string | null> {
    const key = repoKey(ref);
    const providers = await this.dk.get<{ githubId: string }[]>("github.githubProviders");
    for (const { githubId } of providers) {
      const repos = await this.reposOf(githubId).catch(() => new Set<string>());
      if (repos.has(key)) return this.installationToken(githubId);
    }
    return null;
  }
}
