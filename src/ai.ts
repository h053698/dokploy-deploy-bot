import type { AiConfig, AiProvider } from "./config.ts";
import type { FetchLike } from "./dokploy.ts";

const MANIFESTS = [
  "package.json",
  "requirements.txt",
  "pyproject.toml",
  "Pipfile",
  "go.mod",
  "Cargo.toml",
  "Gemfile",
  "composer.json",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "deno.json",
  "next.config.js",
  "next.config.mjs",
  "next.config.ts",
  "vite.config.ts",
  "vite.config.js",
  "Procfile",
  "README.md",
];
const MAX_FILE_CHARS = 4000;
const MAX_LISTED_FILES = 300;

export interface DockerfileRequest {
  repo: string;
  files: string[];
  readFile: (path: string) => Promise<string | null>;
  port: number;
  failureLog: string | null;
  previousDockerfile: string | null;
}

export function extractDockerfile(reply: string): string | null {
  const fenced = /```(?:dockerfile|Dockerfile|docker)?\s*\n([\s\S]*?)```/.exec(reply);
  const body = (fenced?.[1] ?? reply).trim();
  return /^\s*(?:#.*\n\s*)*(?:ARG\s.+\n\s*)*FROM\s/im.test(body) ? `${body}\n` : null;
}

async function buildPrompt(req: DockerfileRequest): Promise<string> {
  const listed = req.files.slice(0, MAX_LISTED_FILES).join("\n");
  const present = MANIFESTS.filter((m) => req.files.includes(m));
  const contents = await Promise.all(
    present.map(async (path) => {
      const text = await req.readFile(path);
      return text === null ? "" : `--- ${path} ---\n${text.slice(0, MAX_FILE_CHARS)}`;
    }),
  );
  const parts = [
    `Repository: ${req.repo}`,
    `The app must listen on 0.0.0.0, port ${req.port} (also exposed as the PORT env var). Include "EXPOSE ${req.port}".`,
    `Files (${req.files.length} total${req.files.length > MAX_LISTED_FILES ? `, first ${MAX_LISTED_FILES} shown` : ""}):\n${listed}`,
    contents.filter(Boolean).join("\n\n"),
  ];
  if (req.failureLog) parts.push(`The previous build failed. Log tail:\n${req.failureLog.slice(-6000)}`);
  if (req.previousDockerfile) parts.push(`Dockerfile that failed:\n${req.previousDockerfile}`);
  return parts.join("\n\n");
}

const SYSTEM = `You write production Dockerfiles for arbitrary GitHub repositories so they can be built with "docker build" from the repository root and run behind a reverse proxy.
Rules: use official, specific base image tags; multi-stage builds when there is a build step; install dependencies from the lockfile that exists; never reference files that are not in the file list; run a long-lived HTTP server in the foreground; serve static sites with a small web server on the required port.
Reply with exactly one \`\`\`dockerfile code block and nothing else.`;

export interface GeneratedDockerfile {
  dockerfile: string;
  provider: string;
  model: string;
  failures: string[];
}

async function askProvider(provider: AiProvider, prompt: string, timeoutMs: number, fetchImpl: FetchLike): Promise<string> {
  const res = await fetchImpl(`${provider.baseUrl}/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${provider.apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: provider.model,
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: prompt },
      ],
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const body = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  const reply = body.choices?.[0]?.message?.content ?? "";
  const dockerfile = extractDockerfile(reply);
  if (!dockerfile) throw new Error(`no Dockerfile in reply: ${reply.slice(0, 120)}`);
  return dockerfile;
}

export async function generateDockerfile(
  ai: AiConfig,
  req: DockerfileRequest,
  fetchImpl: FetchLike = fetch,
): Promise<GeneratedDockerfile> {
  const prompt = await buildPrompt(req);
  const failures: string[] = [];
  for (const provider of ai.providers) {
    try {
      const dockerfile = await askProvider(provider, prompt, ai.timeoutMs, fetchImpl);
      return { dockerfile, provider: provider.name, model: provider.model, failures };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      failures.push(`${provider.name}: ${reason}`);
      console.warn(`[deploy-bot] AI provider ${provider.name} (${provider.model}) failed: ${reason}`);
    }
  }
  throw new Error(`모든 AI 제공자가 실패했어\n${failures.join("\n")}`);
}
