import { describe, expect, test } from "bun:test";
import { generateDockerfile } from "../src/ai.ts";
import { loadConfig } from "../src/config.ts";

const BASE = { TELEGRAM_BOT_TOKEN: "1:x", DOKPLOY_URL: "http://d", DOKPLOY_API_KEY: "k" };

describe("AI provider chain config", () => {
  test("keys define the chain in ollama > mistral > openrouter order", () => {
    const cfg = loadConfig({ ...BASE, OPENROUTER_API_KEY: "o", MISTRAL_API_KEY: "m", OLLAMA_API_KEY: "ol" });
    expect(cfg.ai?.providers.map((p) => [p.name, p.baseUrl, p.model])).toEqual([
      ["ollama", "https://ollama.com/v1", "gpt-oss:120b"],
      ["mistral", "https://api.mistral.ai/v1", "codestral-latest"],
      ["openrouter", "https://openrouter.ai/api/v1", "openrouter/free"],
    ]);
  });

  test("GROQ_API_KEY and GEMINI_API_KEY are not providers", () => {
    expect(loadConfig({ ...BASE, GROQ_API_KEY: "g", GEMINI_API_KEY: "ge" }).ai).toBeNull();
  });

  test("model override, custom provider last, and explicit order", () => {
    const cfg = loadConfig({
      ...BASE,
      AI_API_KEY: "c",
      AI_BASE_URL: "http://local/v1/",
      AI_MODEL: "llama",
      OLLAMA_API_KEY: "ol",
      OLLAMA_MODEL: "glm-5.3-flash",
      MISTRAL_API_KEY: "m",
    });
    expect(cfg.ai?.providers.map((p) => `${p.name}:${p.model}`)).toEqual(["ollama:glm-5.3-flash", "mistral:codestral-latest", "custom:llama"]);
    expect(cfg.ai?.providers[2]?.baseUrl).toBe("http://local/v1");

    const ordered = loadConfig({ ...BASE, OLLAMA_API_KEY: "ol", MISTRAL_API_KEY: "m", OPENROUTER_API_KEY: "o", AI_PROVIDER_ORDER: "openrouter, ollama" });
    expect(ordered.ai?.providers.map((p) => p.name)).toEqual(["openrouter", "ollama"]);
  });

  test("no keys disables AI; ordering a provider without a key is an error", () => {
    expect(loadConfig(BASE).ai).toBeNull();
    expect(() => loadConfig({ ...BASE, OLLAMA_API_KEY: "ol", AI_PROVIDER_ORDER: "ollama,mistral" })).toThrow("mistral");
  });
});

describe("generateDockerfile fallback", () => {
  const ai = {
    maxAttempts: 1,
    timeoutMs: 5000,
    providers: [
      { name: "ollama", baseUrl: "http://ollama.test", apiKey: "ol", model: "m1" },
      { name: "mistral", baseUrl: "http://mistral.test", apiKey: "m", model: "m2" },
      { name: "openrouter", baseUrl: "http://or.test", apiKey: "o", model: "m3" },
    ],
  };
  const req = { repo: "o/r", files: ["package.json"], readFile: async () => "{}", port: 3000, failureLog: null, previousDockerfile: null };
  const dockerReply = () => Response.json({ choices: [{ message: { content: "```dockerfile\nFROM node:22\n```" } }] });

  test("rate-limited and garbage replies fall through to the next provider", async () => {
    const hits: string[] = [];
    const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      hits.push(`${new URL(url).host} ${new Headers(init?.headers).get("authorization")}`);
      if (url.startsWith("http://ollama.test")) return new Response("rate limited", { status: 429 });
      if (url.startsWith("http://mistral.test")) return Response.json({ choices: [{ message: { content: "sorry" } }] });
      return dockerReply();
    };
    const result = await generateDockerfile(ai, req, fetchImpl);
    expect(hits).toEqual(["ollama.test Bearer ol", "mistral.test Bearer m", "or.test Bearer o"]);
    expect(result).toMatchObject({ provider: "openrouter", model: "m3", dockerfile: "FROM node:22\n" });
    expect(result.failures).toEqual(["ollama: HTTP 429: rate limited", "mistral: no Dockerfile in reply: sorry"]);
  });

  test("first healthy provider wins without calling the rest", async () => {
    const hits: string[] = [];
    const fetchImpl = async (input: string | URL | Request) => {
      hits.push(new URL(String(input)).host);
      return dockerReply();
    };
    expect((await generateDockerfile(ai, req, fetchImpl)).provider).toBe("ollama");
    expect(hits).toEqual(["ollama.test"]);
  });

  test("network errors on every provider surface each reason", async () => {
    const fetchImpl = async () => {
      throw new Error("ECONNREFUSED");
    };
    const error = await generateDockerfile(ai, req, fetchImpl).catch((e: Error) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("ollama: ECONNREFUSED");
    expect((error as Error).message).toContain("openrouter: ECONNREFUSED");
  });
});
