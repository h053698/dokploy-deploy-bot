import { describe, expect, test } from "bun:test";
import { checkDomain, classify, isCloudflareIp, serverAddresses } from "../src/dns.ts";

const SERVER = new Set(["203.0.113.10"]);

describe("isCloudflareIp", () => {
  test("matches addresses inside Cloudflare ranges and rejects others", () => {
    expect(isCloudflareIp("104.21.91.175")).toBe(true);
    expect(isCloudflareIp("172.67.176.224")).toBe(true);
    expect(isCloudflareIp("2606:4700:3030::6815:5baf")).toBe(true);
    expect(isCloudflareIp("203.0.113.10")).toBe(false);
    expect(isCloudflareIp("104.15.255.255")).toBe(false);
    expect(isCloudflareIp("2001:db8::1")).toBe(false);
  });
});

describe("classify", () => {
  test("no records is missing", () => {
    expect(classify([], SERVER).state).toBe("missing");
  });
  test("the Dokploy server address is direct", () => {
    expect(classify(["203.0.113.10"], SERVER).state).toBe("direct");
  });
  test("only Cloudflare addresses is cloudflare", () => {
    expect(classify(["104.21.91.175", "172.67.176.224"], SERVER).state).toBe("cloudflare");
  });
  test("any other address is other, even if one of them is Cloudflare", () => {
    expect(classify(["198.51.100.7"], SERVER).state).toBe("other");
    expect(classify(["104.21.91.175", "198.51.100.7"], SERVER).state).toBe("other");
  });
});

describe("checkDomain / serverAddresses", () => {
  test("uses the injected resolver", async () => {
    const report = await checkDomain("shop.example.com", SERVER, async () => ["203.0.113.10"]);
    expect(report).toEqual({ state: "direct", addresses: ["203.0.113.10"] });
  });
  test("a literal IP in DOKPLOY_URL is used without a lookup", async () => {
    const ips = await serverAddresses("http://198.51.100.20:3000", async () => {
      throw new Error("must not resolve");
    });
    expect([...ips]).toEqual(["198.51.100.20"]);
  });
  test("a hostname in DOKPLOY_URL is resolved", async () => {
    const ips = await serverAddresses("http://dokploy.test", async () => ["203.0.113.10"]);
    expect([...ips]).toEqual(["203.0.113.10"]);
  });
});
