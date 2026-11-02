export interface AiProvider {
  name: string;
  baseUrl: string;
  apiKey: string;
  model: string;
}

export interface AiConfig {
  providers: AiProvider[];
  maxAttempts: number;
  timeoutMs: number;
}

const PRESETS = [
  { name: "ollama", key: "OLLAMA_API_KEY", baseUrl: "https://ollama.com/v1", model: "gpt-oss:120b" },
  { name: "mistral", key: "MISTRAL_API_KEY", baseUrl: "https://api.mistral.ai/v1", model: "codestral-latest" },
  { name: "openrouter", key: "OPENROUTER_API_KEY", baseUrl: "https://openrouter.ai/api/v1", model: "openrouter/free" },
] as const;

function loadAi(env: Env): AiConfig | null {
  const providers: AiProvider[] = [];
  for (const preset of PRESETS) {
    const apiKey = optional(env, preset.key);
    if (!apiKey) continue;
    const prefix = preset.name.toUpperCase();
    providers.push({
      name: preset.name,
      baseUrl: preset.baseUrl,
      apiKey,
      model: optional(env, `${prefix}_MODEL`) ?? preset.model,
    });
  }
  const customKey = optional(env, "AI_API_KEY");
  if (customKey) {
    providers.push({
      name: "custom",
      baseUrl: (optional(env, "AI_BASE_URL") ?? "https://api.openai.com/v1").replace(/\/+$/, ""),
      apiKey: customKey,
      model: required(env, "AI_MODEL"),
    });
  }
  const order = (optional(env, "AI_PROVIDER_ORDER") ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (order.length > 0) {
    const unknown = order.filter((n) => !providers.some((p) => p.name === n));
    if (unknown.length > 0) throw new Error(`AI_PROVIDER_ORDER names providers without a key: ${unknown.join(", ")}`);
    providers.sort((a, b) => order.indexOf(a.name) - order.indexOf(b.name));
    providers.splice(0, providers.length, ...providers.filter((p) => order.includes(p.name)));
  }
  if (providers.length === 0) return null;
  return {
    providers,
    maxAttempts: positiveInt(env, "AI_MAX_ATTEMPTS", 2),
    timeoutMs: positiveInt(env, "AI_TIMEOUT_SEC", 60) * 1000,
  };
}

export interface Config {
  telegramToken: string;
  telegramProxy: string | null;
  allowedUserIds: Set<number>;
  allowedChatIds: Set<number>;
  adminUserIds: Set<number>;
  accessFile: string;
  dokployUrl: string;
  dokployApiKey: string;
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

  const ai = loadAi(env);

  return {
    telegramToken: required(env, "TELEGRAM_BOT_TOKEN"),
    telegramProxy: optional(env, "TELEGRAM_PROXY"),
    allowedUserIds,
    allowedChatIds,
    adminUserIds: idSet(env, "ADMIN_USER_IDS"),
    accessFile: optional(env, "ACCESS_FILE") ?? "data/access.json",
    dokployUrl: required(env, "DOKPLOY_URL").replace(/\/+$/, ""),
    dokployApiKey: required(env, "DOKPLOY_API_KEY"),
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
