import type { AiConfig, AiProvider } from "./config.ts";
import type { FetchLike } from "./dokploy.ts";

const LEVEL_NAME_TO_TYPE: Record<string, "error" | "other"> = {
  error: "error",
  err: "error",
  fatal: "error",
  critical: "error",
  panic: "error",
  alert: "error",
  emergency: "error",
};

function explicitLevel(message: string): "error" | "other" | null {
  const named = message.match(/"(?:level|severity|log\.level|loglevel)"\s*:\s*"([a-z]+)"/i) ?? message.match(/(?:^|\s)(?:level|severity)=([a-z]+)\b/i);
  if (named?.[1]) return LEVEL_NAME_TO_TYPE[named[1].toLowerCase()] ?? "other";
  const numeric = message.match(/"level"\s*:\s*(\d{1,2})\b/);
  if (numeric?.[1]) return Number(numeric[1]) >= 50 || Number(numeric[1]) <= 3 ? "error" : "other";
  return null;
}

export function isErrorLine(message: string): boolean {
  const explicit = explicitLevel(message);
  if (explicit) return explicit === "error";
  const status = message.match(/"statusCode"\s*:\s*"?(\d{3})"?/);
  if (status) return Number(status[1]) >= 500;
  const lower = message.toLowerCase();
  if (/(?:^|\s)(?:info|inf|information):?\s/.test(lower) || /\[(?:info|information)\]/.test(lower) || /\b(?:status|state|current|progress)\b:?\s/.test(lower) || /\b(?:processing|executing|performing)\b/.test(lower)) {
    return false;
  }
  const scope = lower
    .replace(/\b(?:error|err|errors|failed|failure|failures)\s*:\s*(?:none|null|nil|false|0|no|-|""|'')(?=[,;.)\]]|$)/gi, "")
    .replace(/\b(?:error|err|errors|failed|failure|failures)\s*=\s*(?:none|null|nil|false|0|no|-|""|'')(?=[\s,;.)\]]|$)/gi, "");
  return (
    /(?:^|\s)(?:error|err):?\s/.test(scope) ||
    /\b(?:exception|failed|failure)\b/.test(scope) ||
    /\b(?:uncaught|unhandled)\s+(?:exception|error)\b/.test(scope) ||
    /\b(?:errno|code):\s*(?:\d+|[a-z_]+)\b/.test(scope) ||
    /\[(?:error|err|fatal)\]/.test(scope) ||
    /\b(?:crash|critical|fatal)\b/.test(scope) ||
    /\b(?:fail(?:ed|ure)?|broken|dead)\b/.test(scope)
  );
}

const ANSI = new RegExp(String.fromCharCode(27) + "\\[[0-9;]*m", "g");

export function errorLines(log: string, limit = 12): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of log.replace(ANSI, "").split("\n")) {
    const line = raw.replace(/^\s*\d+\s+/, "").replace(/^\d{4}-\d{2}-\d{2}[T ][\d:.]+(?:Z| UTC)?\s*/, "").trim();
    if (!line || !isErrorLine(line) || seen.has(line)) continue;
    seen.add(line);
    out.push(line.slice(0, 400));
  }
  return out.slice(-limit);
}

export type Fault = { kind: "port_conflict"; port: number } | { kind: "name_conflict"; name: string } | { kind: "unknown" };

const NAME_IN_USE = [
  /The container name "\/?([\w.-]+)" is already in use by container/i,
  /container name \\?"?\/?([\w.-]+)\\?"? is already in use/i,
];

const PORT_IN_USE = [
  /Bind for [\d.:\[\]a-f]*?:(\d{2,5}) failed: port is already allocated/i,
  /listen tcp[ \d.:\[\]a-f]*?:(\d{2,5}): bind: address already in use/i,
  /(?:port|ports?) (?:is )?(?:\w+ )?(\d{2,5}) (?:is )?(?:already )?(?:allocated|in use)/i,
  /address already in use.*?:(\d{2,5})\b/i,
];

export function detectFault(lines: string[]): Fault {
  for (const line of lines) {
    for (const pattern of NAME_IN_USE) {
      const m = pattern.exec(line);
      if (m?.[1]) return { kind: "name_conflict", name: m[1] };
    }
  }
  for (const line of lines) {
    for (const pattern of PORT_IN_USE) {
      const m = pattern.exec(line);
      if (m?.[1]) return { kind: "port_conflict", port: Number(m[1]) };
    }
  }
  return { kind: "unknown" };
}

export function pickFreePort(failed: number, used: ReadonlySet<number>): number {
  let port = failed + 100;
  while (used.has(port) && port < 65535) port++;
  return port;
}

export function composePorts(composeFile: string): { line: number; text: string; host: number; container: number }[] {
  const out: { line: number; text: string; host: number; container: number }[] = [];
  composeFile.split("\n").forEach((text, line) => {
    const m = /^(\s*-\s*["']?)(?:[\d.]+:)?(\d{2,5}):(\d{2,5})(?:\/\w+)?(["']?\s*)$/.exec(text);
    if (m) out.push({ line, text, host: Number(m[2]), container: Number(m[3]) });
  });
  return out;
}

export function rewriteHostPort(composeFile: string, oldHost: number, newHost: number): string | null {
  const lines = composeFile.split("\n");
  let changed = false;
  for (const entry of composePorts(composeFile)) {
    if (entry.host !== oldHost) continue;
    lines[entry.line] = entry.text.replace(new RegExp("(?<![\\d.])" + oldHost + ":" + entry.container), newHost + ":" + entry.container);
    changed = true;
  }
  return changed ? lines.join("\n") : null;
}

export const PORT_MAP_TAG = "# deploy-bot port-map:";

export function parsePortMaps(content: string): Map<number, number> {
  const maps = new Map<number, number>();
  for (const m of content.matchAll(/^# deploy-bot port-map: (\d+)->(\d+)\s*$/gm)) maps.set(Number(m[1]), Number(m[2]));
  return maps;
}

export function renderPortPatch(upstream: string, ports: ReadonlyMap<number, number>, names: ReadonlyMap<string, string> = new Map()): string | null {
  let body = upstream;
  const applied: string[] = [];
  for (const [from, to] of ports) {
    const next = rewriteHostPort(body, from, to);
    if (!next) continue;
    body = next;
    applied.push(`${PORT_MAP_TAG} ${from}->${to}`);
  }
  for (const [from, to] of names) {
    const next = rewriteContainerName(body, from, to);
    if (!next) continue;
    body = next;
    applied.push(`${NAME_MAP_TAG} ${from}->${to}`);
  }
  return applied.length ? `${applied.join("\n")}\n${body}` : null;
}

export const NAME_MAP_TAG = "# deploy-bot name-map:";

export function parseNameMaps(content: string): Map<string, string> {
  const maps = new Map<string, string>();
  for (const m of content.matchAll(/^# deploy-bot name-map: (\S+)->(\S+)\s*$/gm)) maps.set(m[1] as string, m[2] as string);
  return maps;
}

export function rewriteContainerName(composeFile: string, from: string, to: string): string | null {
  const escaped = from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp("^(\\s*container_name:\\s*)([\"']?)" + escaped + "\\2(\\s*)$", "gm");
  let changed = false;
  const next = composeFile.replace(pattern, (_all, lead: string, quote: string, tail: string) => {
    changed = true;
    return lead + quote + to + quote + tail;
  });
  return changed ? next : null;
}

export function pickFreeName(base: string, suffix: string, used: ReadonlySet<string>): string {
  let name = base + "-" + suffix;
  for (let n = 2; used.has(name); n++) name = base + "-" + suffix + n;
  return name;
}

const PORT_PROMPT = [
  "You repair Docker Compose deployments. Reply with one JSON object only, no prose.",
  'Schema: {"cause": "port_conflict" | "other", "hostPort": number | null, "reason": string}',
  'Use "port_conflict" only when the error lines show a host port that is already taken. Put that host port in hostPort.',
].join("\n");

export async function classifyWithAi(ai: AiConfig, lines: string[], fetchImpl: FetchLike): Promise<{ fault: Fault; reason: string; provider: string } | null> {
  const prompt = "Error lines from the deployment log:\n" + lines.join("\n");
  for (const provider of ai.providers) {
    try {
      const reply = await ask(provider, prompt, ai.timeoutMs, fetchImpl);
      const json = /\{[\s\S]*\}/.exec(reply)?.[0];
      if (!json) continue;
      const parsed = JSON.parse(json) as { cause?: string; hostPort?: number | null; reason?: string };
      if (parsed.cause === "port_conflict" && Number.isInteger(parsed.hostPort) && (parsed.hostPort as number) > 0 && (parsed.hostPort as number) < 65536) {
        return { fault: { kind: "port_conflict", port: parsed.hostPort as number }, reason: String(parsed.reason ?? "").slice(0, 160), provider: provider.name };
      }
      return { fault: { kind: "unknown" }, reason: String(parsed.reason ?? "").slice(0, 160), provider: provider.name };
    } catch (error) {
      console.warn("[deploy-bot] AI log triage via " + provider.name + " failed: " + (error instanceof Error ? error.message : String(error)));
    }
  }
  return null;
}

async function ask(provider: AiProvider, prompt: string, timeoutMs: number, fetchImpl: FetchLike): Promise<string> {
  const res = await fetchImpl(provider.baseUrl + "/chat/completions", {
    method: "POST",
    headers: { authorization: "Bearer " + provider.apiKey, "content-type": "application/json" },
    body: JSON.stringify({ model: provider.model, messages: [{ role: "system", content: PORT_PROMPT }, { role: "user", content: prompt }] }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error("HTTP " + res.status);
  const body = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  return body.choices?.[0]?.message?.content ?? "";
}
