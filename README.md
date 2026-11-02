# dokploy-deploy-bot

A Telegram bot that deploys GitHub repos to Dokploy with one command.

```
/deploy https://github.com/owner/repo
```

1. The bot reads the repo through the GitHub API and picks a build method.
   - `docker-compose.yml` / `compose.yaml` → Dokploy Compose (the domain attaches to the `web`/`app`/`frontend`… service, or to the first service that has ports)
   - `Dockerfile` → Dockerfile build (port taken from `EXPOSE`)
   - Neither → **Railpack**. If the Railpack build fails, an AI writes a Dockerfile, the bot injects it as `Dockerfile.deploy-bot` through a Dokploy Patch, and the build is retried.
2. A single message walks you through the choices with buttons: **build** (⭐ recommended from what the repo has: Compose, Dockerfile, Railpack; also Nixpacks, Heroku, Paketo, Static, or "AI writes a Dockerfile") → **project** (suggests a new project named after the repo, or pick an existing one, or type a name) → **environment** (existing ones, `+ staging` / `+ dev`, or type a name; missing ones are created) → **domain** (`<repo>.arpa.page`, `<repo>-<env>.arpa.page` outside production, your own, or none) → **confirm**.
3. After you press 🚀, one live message shows each step, the elapsed time, and the last lines of the build log while it runs. The wizard's button turns into a disabled "⏳ 배포 진행 중..." and then "✅ 배포 완료" / "❌ 배포 실패".
4. The result is a rich message (table + collapsible log) with buttons: open the site, open it in Dokploy, copy the URL, build log, runtime log, update, rebuild.
5. Everything the bot sends stays in the forum topic where the command was typed.

| Command | What it does |
|---|---|
| `/deploy <url>` | New deploy. If the repo is already deployed, shows update/rebuild buttons instead |
| `/update [name]` | Pulls the latest GitHub code and deploys again (Dokploy `deploy`) |
| `/redeploy [name]` | Rebuilds the already-cloned code without pulling (Dokploy `redeploy`) |
| `/logs [name]` | Shows the running service's recent logs (with a refresh button) |
| `/list` | Lists bot-managed services grouped by project / environment |
| `/allow <user id>` | Admin only. Lets that user use the bot in DMs. In a group you can also reply to the person's message with `/allow` |
| `/disallow <user id>` | Admin only. Removes a user added with `/allow` |
| `/allowed` | Admin only. Shows admins, allowed users, and allowed groups |

A partial or empty name brings up buttons to choose from. The bot manages every service it created (description `deploy-bot repo:owner/repo`) in any project or environment. The same repo can live in several environments; pickers show which one.

## Setup

1. Create a bot with @BotFather and get the token.
2. Create an API key in Dokploy under Settings → Profile → API/CLI.
3. **Wildcard DNS**: point `*.arpa.page` with an A record to the Dokploy server IP (`182.215.187.53`). Without it the domain won't resolve, and the Let's Encrypt certificate can't be issued either.
4. Copy `.env.example` to `.env` and fill it in.
   - `ADMIN_USER_IDS`: admins. They can use the bot in DMs and manage users with `/allow`, `/disallow`, `/allowed`. When someone who is not allowed DMs the bot, every admin gets a request with an approve button.
   - `ALLOWED_USER_IDS`: users who can use the bot in DMs. Send `/start` in a DM and the bot replies with your ID. Users added with `/allow` are stored in `ACCESS_FILE` (default `data/access.json`) and survive restarts; mount `/app/data` as a volume when running in Docker.
   - `ALLOWED_CHAT_IDS`: groups where any member can use the bot. Invite the bot and send `/start@<bot username>`; it replies with the group ID.
   - Any other DM or group is denied. In groups the bot ignores plain chatter and only answers commands.
   - `TELEGRAM_PROXY`: set this only if `api.telegram.org` is unreachable directly (for example `http://127.0.0.1:7897`).

```sh
bun install
bun run start      # local
bun test           # tests
bun run typecheck
```

Deploying on Dokploy: this repo has a `Dockerfile`, so you can register it as a Dockerfile app in Dokploy, add the environment variables, and deploy. It needs no domain (it uses long polling). Port 3000 only serves a health check (`ok`).

## Cloudflare

Behind the Cloudflare proxy with SSL mode **Flexible**, set `DOMAIN_TLS=cloudflare`. Cloudflare talks to Dokploy over plain HTTP, so the Dokploy domain must have HTTPS off (otherwise Traefik redirects http to https forever). The bot then creates the domain with HTTPS off and still shows `https://` links. With `DOMAIN_TLS=letsencrypt` it asks Dokploy for a Let's Encrypt certificate instead.

## Group topics and admin rights

Messages are sent into the topic where the command was typed. Ephemeral (only-you) replies need the bot to be a group admin; without it the bot falls back to normal messages.

## Notes

- Private repos: if the repo is inside a Dokploy GitHub App installation, the bot both reads it (it mints a short-lived installation token from the app's credentials in Dokploy) and connects Dokploy to it through the app. No `GITHUB_TOKEN` needed. Repos outside every installation need `GITHUB_TOKEN` to be read, and Dokploy can only clone them if they are public.
- AI: set any of `OLLAMA_API_KEY` (Ollama Cloud, pay per token), `MISTRAL_API_KEY`, `OPENROUTER_API_KEY`, or a custom OpenAI-compatible `AI_BASE_URL`/`AI_API_KEY`/`AI_MODEL`. Every provider with a key joins a fallback chain (Ollama > Mistral > OpenRouter > custom, or `AI_PROVIDER_ORDER`). If one fails, is rate-limited, times out, or replies without a Dockerfile, the next one is tried, and the progress message names the provider that answered. With no keys, the AI fallback is off.
- You can edit or delete the generated Dockerfile in the Dokploy service under Patches.
- For a Dockerfile/Railpack app with no `EXPOSE`, the bot sets the `PORT` env var to the port it assumed (Railpack: Node 3000, Python 8000, Go/Ruby 8080).
