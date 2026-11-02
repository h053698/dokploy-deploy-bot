# dokploy-deploy-bot

A Telegram bot that deploys GitHub repos to Dokploy with one command.

```
/deploy https://github.com/owner/repo
```

1. The bot reads the repo through the GitHub API and picks a build method.
   - `docker-compose.yml` / `compose.yaml` → Dokploy Compose (the domain attaches to the `web`/`app`/`frontend`… service, or to the first service that has ports)
   - `Dockerfile` → Dockerfile build (port taken from `EXPOSE`)
   - Neither → **Railpack**. If the Railpack build fails, an AI writes a Dockerfile, the bot injects it as `Dockerfile.deploy-bot` through a Dokploy Patch, and the build is retried.
2. It asks which domain to use: default `<repo>.arpa.page`, enter your own, or no domain.
3. It posts a summary of how the service will be set up, then creates the project/app/domain in Dokploy and deploys.
4. Progress shows up as a single message that keeps updating. At the end you get the URL, or a failure with the tail of the log.

| Command | What it does |
|---|---|
| `/deploy <url>` | New deploy. If the repo is already deployed, shows update/rebuild buttons instead |
| `/update [name]` | Pulls the latest GitHub code and deploys again (Dokploy `deploy`) |
| `/redeploy [name]` | Rebuilds the already-cloned code without pulling (Dokploy `redeploy`) |
| `/list` | Lists services the bot manages |
| `/allow <user id>` | Admin only. Lets that user use the bot in DMs. In a group you can also reply to the person's message with `/allow` |
| `/disallow <user id>` | Admin only. Removes a user added with `/allow` |
| `/allowed` | Admin only. Shows admins, allowed users, and allowed groups |

A partial or empty name brings up buttons to choose from. Only services the bot created (description `deploy-bot repo:owner/repo`, inside the `DOKPLOY_PROJECT` project) are managed.

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

## Notes

- Private repos: if the Dokploy GitHub App has access, the bot connects through it. Otherwise it clones the public URL. To analyze a private repo you also need `GITHUB_TOKEN`.
- AI: set any of `GEMINI_API_KEY`, `MISTRAL_API_KEY`, `OPENROUTER_API_KEY`, or a custom OpenAI-compatible `AI_BASE_URL`/`AI_API_KEY`/`AI_MODEL`. Every provider with a key joins a fallback chain (custom > Gemini > Mistral > OpenRouter, or `AI_PROVIDER_ORDER`). If one fails, is rate-limited, or replies without a Dockerfile, the next one is tried, and the progress message names the provider that answered. With no keys, the AI fallback is off.
- You can edit or delete the generated Dockerfile in the Dokploy service under Patches.
- For a Dockerfile/Railpack app with no `EXPOSE`, the bot sets the `PORT` env var to the port it assumed (Railpack: Node 3000, Python 8000, Go/Ruby 8080).
