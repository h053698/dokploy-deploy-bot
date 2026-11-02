export interface AiConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  maxAttempts: number;
}

export interface Config {
  telegramToken: string;
  telegramProxy: string | null;
  allowedUserIds: Set<number>;
  allowedChatIds: Set<number>;
  dokployUrl: string;
  dokployApiKey: string;
  dokployProject: string;
  dokployServerId: string | null;
  baseDomain: string;
  https: boolean;
  railpackVersion: string;
  githubApiUrl: string;
  githubToken: string | null;
  ai: AiConfig | null;
  deployTimeoutMs: number;
  pollIntervalMs: number;
}

type Env = Record<string, string | undefined>;

function required(env: Env, key: string): string {
  const value = env[key]?.trim();
  if (!value) throw new Error(`Missing required env var ${key}`);
  return value;
}

function optional(env: Env, key: string): string | null {
  const value = env[key]?.trim();
  return value ? value : null;
}

function positiveInt(env: Env, key: string, fallback: number): number {
  const raw = optional(env, key);
  if (raw === null) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${key} must be a positive integer, got "${raw}"`);
  return value;
}

function idSet(env: Env, key: string): Set<number> {
  return new Set(
    (optional(env, key) ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => {
        const id = Number(s);
        if (!Number.isSafeInteger(id)) throw new Error(`${key} contains a non-numeric id "${s}"`);
        return id;
      }),
  );
}

export function loadConfig(env: Env = process.env): Config {
  const allowedUserIds = idSet(env, "ALLOWED_USER_IDS");
  const allowedChatIds = idSet(env, "ALLOWED_CHAT_IDS");

  const aiKey = optional(env, "AI_API_KEY");
  let ai: AiConfig | null = null;
  if (aiKey) {
    ai = {
      baseUrl: (optional(env, "AI_BASE_URL") ?? "https://api.openai.com/v1").replace(/\/+$/, ""),
      apiKey: aiKey,
      model: required(env, "AI_MODEL"),
      maxAttempts: positiveInt(env, "AI_MAX_ATTEMPTS", 2),
    };
  }

  return {
    telegramToken: required(env, "TELEGRAM_BOT_TOKEN"),
    telegramProxy: optional(env, "TELEGRAM_PROXY"),
    allowedUserIds,
    allowedChatIds,
    dokployUrl: required(env, "DOKPLOY_URL").replace(/\/+$/, ""),
    dokployApiKey: required(env, "DOKPLOY_API_KEY"),
    dokployProject: optional(env, "DOKPLOY_PROJECT") ?? "deploy-bot",
    dokployServerId: optional(env, "DOKPLOY_SERVER_ID"),
    baseDomain: (optional(env, "BASE_DOMAIN") ?? "arpa.page").replace(/^\.+/, ""),
    https: (optional(env, "DOMAIN_HTTPS") ?? "true") !== "false",
    railpackVersion: optional(env, "RAILPACK_VERSION") ?? "0.15.4",
    githubApiUrl: (optional(env, "GITHUB_API_URL") ?? "https://api.github.com").replace(/\/+$/, ""),
    githubToken: optional(env, "GITHUB_TOKEN"),
    ai,
    deployTimeoutMs: positiveInt(env, "DEPLOY_TIMEOUT_MIN", 30) * 60_000,
    pollIntervalMs: positiveInt(env, "POLL_INTERVAL_MS", 5000),
  };
}
