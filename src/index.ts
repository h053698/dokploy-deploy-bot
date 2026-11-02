import { Bot } from "grammy";
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
const { bot } = createBot({ cfg, deployer: new Deployer(cfg, dk, gh), gh }, telegram);
if (cfg.allowedUserIds.size === 0 && cfg.allowedChatIds.size === 0) {
  console.warn("[deploy-bot] ALLOWED_USER_IDS and ALLOWED_CHAT_IDS are empty: every chat is denied. Send /start to get ids.");
}

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
