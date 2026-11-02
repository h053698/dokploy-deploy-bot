import { Bot } from "grammy";
import { Access } from "./access.ts";
import { COMMANDS, createBot } from "./bot.ts";
import { loadConfig } from "./config.ts";
import { Deployer } from "./deployer.ts";
import { Dokploy } from "./dokploy.ts";
import { GitHub } from "./github.ts";

const cfg = loadConfig();
const dk = new Dokploy(cfg.dokployUrl, cfg.dokployApiKey);
const gh = new GitHub(cfg.githubApiUrl, cfg.githubToken);
const proxy = cfg.telegramProxy;
const telegram = new Bot(
  cfg.telegramToken,
  proxy
    ? { client: { baseFetchConfig: {}, fetch: ((input, init) => fetch(input, { ...init, proxy })) as typeof fetch } }
    : {},
);
const access = await Access.load(cfg.accessFile, cfg.allowedUserIds, cfg.adminUserIds);
const { bot } = createBot({ cfg, access, deployer: new Deployer(cfg, dk, gh), gh }, telegram);
const acl = access.list();
console.log(`[deploy-bot] admins=${acl.admins.length} users=${acl.env.length}+${acl.added.length} groups=${cfg.allowedChatIds.size} (${cfg.accessFile})`);
if (acl.admins.length === 0) console.warn("[deploy-bot] ADMIN_USER_IDS is empty: nobody can use /allow.");
console.log(`[deploy-bot] ai=${cfg.ai ? cfg.ai.providers.map((p) => `${p.name}:${p.model}`).join(" > ") : "off"}`);

const server = Bun.serve({
  port: Number(process.env.PORT ?? 3000),
  fetch: () => new Response("ok"),
});

const stop = async () => {
  await bot.stop();
  await server.stop();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);

await bot.api.setMyCommands(COMMANDS);
console.log(`[deploy-bot] health on :${server.port}, polling Telegram...`);
await bot.start({ drop_pending_updates: true });
