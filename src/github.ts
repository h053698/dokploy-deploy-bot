import type { FetchLike } from "./dokploy.ts";

export interface RepoRef {
  owner: string;
  repo: string;
}

export interface RepoInfo extends RepoRef {
  defaultBranch: string;
  private: boolean;
  cloneUrl: string;
  htmlUrl: string;
}

const NAME = "[A-Za-z0-9_.-]+";
const PATTERNS = [
  new RegExp(`^(?:https?://)?(?:www\\.)?github\\.com/(${NAME})/(${NAME}?)(?:\\.git)?(?:[/?#].*)?$`),
  new RegExp(`^git@github\\.com:(${NAME})/(${NAME}?)(?:\\.git)?$`),
  new RegExp(`^(${NAME})/(${NAME}?)(?:\\.git)?$`),
];

export function parseRepoUrl(input: string): RepoRef | null {
  const text = input.trim();
  for (const pattern of PATTERNS) {
    const m = pattern.exec(text);
    if (m?.[1] && m[2]) return { owner: m[1], repo: m[2] };
  }
  return null;
}

export const repoKey = (ref: RepoRef) => `${ref.owner}/${ref.repo}`.toLowerCase();

export class GitHubError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export type RepoTokenSource = (ref: RepoRef) => Promise<string | null>;

export class GitHub {
  private readonly repoTokens = new Map<string, string>();

  constructor(
    private readonly apiUrl: string,
    private readonly token: string | null,
    private readonly fetchImpl: FetchLike = fetch,
    private readonly appToken: RepoTokenSource | null = null,
  ) {}

  private send(path: string, accept: string, token: string | null): Promise<Response> {
    const headers: Record<string, string> = { accept, "user-agent": "dokploy-deploy-bot" };
    if (token) headers.authorization = `Bearer ${token}`;
    return this.fetchImpl(`${this.apiUrl}${path}`, { headers });
  }

  private async request(ref: RepoRef, path: string, accept = "application/vnd.github+json"): Promise<Response> {
    const key = repoKey(ref);
    const known = this.repoTokens.get(key);
    if (known) return this.send(path, accept, known);
    const res = await this.send(path, accept, this.token);
    if (res.status !== 404 || !this.appToken) return res;
    const appToken = await this.appToken(ref);
    if (!appToken) return res;
    this.repoTokens.set(key, appToken);
    return this.send(path, accept, appToken);
  }

  async repo(ref: RepoRef): Promise<RepoInfo> {
    const res = await this.request(ref, `/repos/${ref.owner}/${ref.repo}`);
    if (res.status === 404) {
      throw new GitHubError(
        `GitHub 레포 ${ref.owner}/${ref.repo}를 찾을 수 없어. 이름이 맞는지 확인하고, 비공개 레포면 Dokploy GitHub App 설치 범위에 추가하거나 GITHUB_TOKEN을 넣어줘`,
        404,
      );
    }
    if (!res.ok) throw new GitHubError(`GitHub API ${res.status}: ${(await res.text()).slice(0, 200)}`, res.status);
    const body = (await res.json()) as {
      name: string;
      owner: { login: string };
      default_branch: string;
      private: boolean;
      clone_url: string;
      html_url: string;
    };
    return {
      owner: body.owner.login,
      repo: body.name,
      defaultBranch: body.default_branch,
      private: body.private,
      cloneUrl: body.clone_url,
      htmlUrl: body.html_url,
    };
  }

  async treeBlobs(ref: RepoRef, branch: string): Promise<string[]> {
    const res = await this.request(ref, `/repos/${ref.owner}/${ref.repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`);
    if (res.status === 409) throw new GitHubError(`${ref.owner}/${ref.repo} 레포가 비어 있어. 코드를 먼저 push해줘`, 409);
    if (!res.ok) throw new GitHubError(`GitHub tree ${res.status}: ${(await res.text()).slice(0, 200)}`, res.status);
    const body = (await res.json()) as { tree: { path: string; type: string }[] };
    return body.tree.filter((e) => e.type === "blob").map((e) => e.path);
  }

  async fileOrNull(ref: RepoRef, branch: string, path: string): Promise<string | null> {
    const encoded = path.split("/").map(encodeURIComponent).join("/");
    const res = await this.request(
      ref,
      `/repos/${ref.owner}/${ref.repo}/contents/${encoded}?ref=${encodeURIComponent(branch)}`,
      "application/vnd.github.raw",
    );
    if (res.status === 404) return null;
    if (!res.ok) throw new GitHubError(`GitHub file ${path} ${res.status}`, res.status);
    return res.text();
  }
}
