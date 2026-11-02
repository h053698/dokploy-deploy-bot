export type BuildPlan =
  | {
      kind: "compose";
      composePath: string;
      serviceName: string;
      port: number;
      services: string[];
      warnings: string[];
    }
  | {
      kind: "application";
      buildType: "dockerfile" | "railpack";
      dockerfile: string | null;
      port: number;
      setPortEnv: boolean;
      warnings: string[];
    };

const COMPOSE_NAMES = ["docker-compose.yml", "docker-compose.yaml", "compose.yml", "compose.yaml"];
const WEB_SERVICE_HINTS = ["web", "app", "frontend", "front", "server", "api", "backend", "site", "nginx"];
const DEFAULT_PORT = 3000;

const depth = (p: string) => p.split("/").length;
const basename = (p: string) => p.slice(p.lastIndexOf("/") + 1);
const shallowest = (paths: string[]) => [...paths].sort((a, b) => depth(a) - depth(b) || a.localeCompare(b))[0];

export function findComposeFile(files: string[]): string | null {
  const root = COMPOSE_NAMES.find((n) => files.includes(n));
  if (root) return root;
  return shallowest(files.filter((f) => depth(f) <= 2 && COMPOSE_NAMES.includes(basename(f)))) ?? null;
}

export function findDockerfile(files: string[]): string | null {
  if (files.includes("Dockerfile")) return "Dockerfile";
  return shallowest(files.filter((f) => depth(f) <= 2 && basename(f) === "Dockerfile")) ?? null;
}

export function exposedPort(dockerfile: string): number | null {
  for (const line of dockerfile.split("\n")) {
    const m = /^\s*EXPOSE\s+(\d+)/i.exec(line);
    if (m?.[1]) return Number(m[1]);
  }
  return null;
}

interface PortMapping {
  container: number;
  host: number | null;
}

function parsePortEntry(entry: unknown): PortMapping | null {
  if (typeof entry === "number") return { container: entry, host: null };
  if (typeof entry === "string") {
    const spec = entry.split("/")[0] ?? "";
    const parts = spec.split(":");
    const container = Number(parts.at(-1)?.split("-")[0]);
    const hostRaw = parts.length > 1 ? Number(parts.at(-2)?.split("-")[0]) : NaN;
    if (!Number.isInteger(container)) return null;
    return { container, host: Number.isInteger(hostRaw) ? hostRaw : null };
  }
  if (entry && typeof entry === "object" && "target" in entry) {
    const { target, published } = entry as { target: unknown; published?: unknown };
    const container = Number(target);
    const host = published === undefined ? null : Number(published);
    if (!Number.isInteger(container)) return null;
    return { container, host: host !== null && Number.isInteger(host) ? host : null };
  }
  return null;
}

interface ComposeService {
  name: string;
  ports: PortMapping[];
  expose: number[];
}

export function parseComposeServices(yaml: string): ComposeService[] {
  const doc = Bun.YAML.parse(yaml) as { services?: Record<string, Record<string, unknown> | null> } | null;
  const services = doc?.services;
  if (!services || typeof services !== "object") return [];
  return Object.entries(services).map(([name, svc]) => {
    const rawPorts = Array.isArray(svc?.ports) ? svc.ports : [];
    const rawExpose = Array.isArray(svc?.expose) ? svc.expose : [];
    return {
      name,
      ports: rawPorts.map(parsePortEntry).filter((p): p is PortMapping => p !== null),
      expose: rawExpose.map((e) => Number(String(e).split("/")[0])).filter(Number.isInteger),
    };
  });
}

export function pickWebService(services: ComposeService[]): { service: ComposeService; port: number } | null {
  const reachable = services.filter((s) => s.ports.length > 0 || s.expose.length > 0);
  const pool = reachable.length > 0 ? reachable : services;
  const hinted = WEB_SERVICE_HINTS.map((h) => pool.find((s) => s.name.toLowerCase() === h)).find(Boolean);
  const service = hinted ?? pool[0];
  if (!service) return null;
  const port = service.ports[0]?.container ?? service.expose[0] ?? DEFAULT_PORT;
  return { service, port };
}

export function guessRailpackPort(files: string[]): number {
  const python = ["requirements.txt", "pyproject.toml", "Pipfile", "manage.py"].some((f) => files.includes(f));
  const node = files.includes("package.json");
  if (python && !node) return 8000;
  if (files.includes("go.mod") || files.includes("Gemfile")) return 8080;
  return DEFAULT_PORT;
}

export type ReadFile = (path: string) => Promise<string | null>;

export async function analyzeRepo(files: string[], readFile: ReadFile): Promise<BuildPlan> {
  const composePath = findComposeFile(files);
  if (composePath) {
    const yaml = await readFile(composePath);
    const services = yaml ? parseComposeServices(yaml) : [];
    const picked = pickWebService(services);
    if (picked) {
      const warnings: string[] = [];
      const reserved = services.flatMap((s) => s.ports.filter((p) => p.host === 80 || p.host === 443).map(() => s.name));
      if (reserved.length > 0) {
        warnings.push(`${[...new Set(reserved)].join(", ")} 서비스가 호스트 80/443 포트를 열어서 Traefik과 충돌할 수 있어`);
      }
      return {
        kind: "compose",
        composePath: `./${composePath}`,
        serviceName: picked.service.name,
        port: picked.port,
        services: services.map((s) => s.name),
        warnings,
      };
    }
  }

  const dockerfile = findDockerfile(files);
  if (dockerfile) {
    const content = await readFile(dockerfile);
    const port = content ? exposedPort(content) : null;
    return {
      kind: "application",
      buildType: "dockerfile",
      dockerfile,
      port: port ?? DEFAULT_PORT,
      setPortEnv: port === null,
      warnings: port === null ? [`Dockerfile에 EXPOSE가 없어서 포트 ${DEFAULT_PORT}로 가정했어`] : [],
    };
  }

  return {
    kind: "application",
    buildType: "railpack",
    dockerfile: null,
    port: guessRailpackPort(files),
    setPortEnv: true,
    warnings: [],
  };
}

export function subdomainFor(repo: string): string {
  const slug = repo
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 63)
    .replace(/-$/, "");
  return slug || "app";
}

const HOST_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

export function normalizeDomain(input: string, baseDomain: string): string | null {
  const text = input
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "");
  const host = text.includes(".") ? text : `${text}.${baseDomain}`;
  return HOST_RE.test(host) ? host : null;
}
