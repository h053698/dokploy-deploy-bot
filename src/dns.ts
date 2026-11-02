import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export type DnsState = "direct" | "cloudflare" | "other" | "missing";

export interface DnsReport {
  state: DnsState;
  addresses: string[];
}

export type Resolver = (host: string) => Promise<string[]>;

const CLOUDFLARE_V4 = [
  "173.245.48.0/20",
  "103.21.244.0/22",
  "103.22.200.0/22",
  "103.31.4.0/22",
  "141.101.64.0/18",
  "108.162.192.0/18",
  "190.93.240.0/20",
  "188.114.96.0/20",
  "197.234.240.0/22",
  "198.41.128.0/17",
  "162.158.0.0/15",
  "104.16.0.0/13",
  "104.24.0.0/14",
  "172.64.0.0/13",
  "131.0.72.0/22",
];

const CLOUDFLARE_V6 = ["2400:cb00::/32", "2606:4700::/32", "2803:f800::/32", "2405:b500::/32", "2405:8100::/32", "2a06:98c0::/29", "2c0f:f248::/32"];

const v4ToInt = (ip: string) => ip.split(".").reduce((n, part) => n * 256 + Number(part), 0);

function v6ToBigInt(ip: string): bigint {
  const [head = "", tail] = ip.split("::");
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  const fill = tail === undefined ? 0 : 8 - left.length - right.length;
  const groups = [...left, ...Array(fill).fill("0"), ...right];
  return groups.reduce((n, g) => (n << 16n) | BigInt(Number.parseInt(g || "0", 16)), 0n);
}

function inCidr(ip: string, cidr: string): boolean {
  const [base = "", bitsText = "0"] = cidr.split("/");
  const bits = Number(bitsText);
  if (isIP(ip) === 4 && isIP(base) === 4) {
    const shift = 32 - bits;
    return Math.floor(v4ToInt(ip) / 2 ** shift) === Math.floor(v4ToInt(base) / 2 ** shift);
  }
  if (isIP(ip) === 6 && isIP(base) === 6) {
    const shift = BigInt(128 - bits);
    return v6ToBigInt(ip) >> shift === v6ToBigInt(base) >> shift;
  }
  return false;
}

export const isCloudflareIp = (ip: string) => [...CLOUDFLARE_V4, ...CLOUDFLARE_V6].some((cidr) => inCidr(ip, cidr));

export const systemResolver: Resolver = async (host) => {
  try {
    const rows = await lookup(host, { all: true });
    return rows.map((row) => row.address);
  } catch {
    return [];
  }
};

export function classify(addresses: string[], serverIps: ReadonlySet<string>): DnsReport {
  if (addresses.length === 0) return { state: "missing", addresses };
  if (addresses.some((ip) => serverIps.has(ip))) return { state: "direct", addresses };
  if (addresses.every(isCloudflareIp)) return { state: "cloudflare", addresses };
  return { state: "other", addresses };
}

export async function checkDomain(host: string, serverIps: ReadonlySet<string>, resolve: Resolver = systemResolver): Promise<DnsReport> {
  return classify(await resolve(host), serverIps);
}

export async function serverAddresses(dokployUrl: string, resolve: Resolver = systemResolver): Promise<Set<string>> {
  const host = new URL(dokployUrl).hostname;
  if (isIP(host)) return new Set([host]);
  return new Set(await resolve(host));
}
