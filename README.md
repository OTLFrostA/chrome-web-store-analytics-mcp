# Chrome Web Store Analytics MCP

A self-hostable MCP server for querying **Chrome Web Store extension analytics from ChatGPT or another OAuth-capable MCP client**. It requests read-only access from Google and can report installs, uninstalls, users, impressions, page views and supported breakdowns.

This repository explains **how to run your own instance**. We are **not publishing a hosted MCP connection URL** or offering a shared hosted service at this time.

## What it does

- Sign in with Google OAuth using `chromewebstore.readonly` (no publishing or editing permissions).
- Connect extensions using a public Chrome Web Store detail URL and your Publisher ID.
- Ask an MCP client for recent metrics, with dimensions including country, OS, install source and app version when supported by Google.
- Keep authorization state in Cloudflare KV and extension associations and historical metrics in D1. Optional daily collection includes Chrome Web Store internal search ranking and Google organic search ranking via each user's own SerpAPI key.

**You must own or have authorized access to the extension analytics you want to view.** The Chrome Web Store API does not return search-keyword data.

## Self-host on Cloudflare Workers

**Prerequisites:** Node.js 22+, a Cloudflare account with Workers/KV/D1 enabled, and a Google Cloud project for OAuth.

### 1. Set up the project

```sh
git clone https://github.com/OTLFrostA/chrome-web-store-analytics-mcp.git
cd chrome-web-store-analytics-mcp
npm ci
npx wrangler login
cp wrangler.example.toml wrangler.toml
```

Edit your **local** `wrangler.toml`:
- Choose a unique Worker `name`.
- Uncomment and set `account_id` for **your** Cloudflare account.
- Set `MCP_RESOURCE` to your final HTTPS Worker endpoint ending in `/mcp` (for example, `https://my-cws-mcp.MY_SUBDOMAIN.workers.dev/mcp`).

Your Workers subdomain can be found in the Cloudflare Workers & Pages dashboard. The `wrangler.toml` file is git-ignored so you don't accidentally publish your own deployment details.

### 2. Create separate KV and D1 resources

```sh
npx wrangler kv namespace create OAUTH_KV
npx wrangler d1 create cws_analytics_mcp
```

Copy the newly created IDs into your `wrangler.toml`, uncommenting the relevant binding sections. The included `GOOGLE_API_RATE_LIMITER` binding should also remain enabled; change its integer `namespace_id` if it conflicts with a different limiter in your account:

```toml
[[kv_namespaces]]
binding = "OAUTH_KV"
id = "YOUR_KV_NAMESPACE_ID"

[[d1_databases]]
binding = "MCP_DB"
database_name = "cws_analytics_mcp"
database_id = "YOUR_D1_DATABASE_ID"
```

Initialize **only your own** D1 database:

```sh
npx wrangler d1 execute cws_analytics_mcp --remote --file=schema.sql
```

### 3. Configure Google OAuth

1. In [Google Cloud Console](https://console.cloud.google.com/), create or choose a project and enable the **Chrome Web Store API**.
2. Set up [Google Auth Platform](https://console.cloud.google.com/auth/overview). Use **External** if people outside your Google Workspace organization need to connect. Testing mode restricts access to test users; a production OAuth app may require Google verification depending on the requested scopes.
3. Create an **OAuth 2.0 Client ID**, application type **Web application**.
4. Add an **Authorized redirect URI** matching your own Worker hostname, ending in `/callback` — for example, `https://my-cws-mcp.MY_SUBDOMAIN.workers.dev/callback`.
5. Record the **Client ID** and **Client Secret** securely. These identify your *app*, not an individual user's publisher account.

### 4. Deploy and configure the Worker

```sh
npm test
npm run check
node scripts/validate-deploy.mjs
npm run deploy
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET
```

The first deploy creates the Worker. `wrangler secret put` prompts for each value without committing it to Git. You can instead add them as **Secrets** under Cloudflare Workers & Pages → your Worker → **Settings → Variables and Secrets**.

Confirm that `https://YOUR_WORKER_HOST/` loads, and that Google OAuth uses the same hostname as the redirect URI you configured. Normal `wrangler deploy` operations preserve existing Worker secrets.

### 5. Connect your own MCP to ChatGPT

1. In a ChatGPT plan/workspace that supports custom MCP connectors, add a remote MCP server under **Settings → Plugins** (UI labels and availability can vary).
2. Paste **your own** server URL: `https://YOUR_WORKER_HOST/mcp`.
3. Complete the Google OAuth sign-in and approve read-only Chrome Web Store access.
4. Ask ChatGPT to **open Chrome Web Store extension settings**. Enter your extension's public Store URL and its Publisher ID. Find the latter in the [Chrome Web Store Developer Dashboard](https://chrome.google.com/webstore/developer/dashboard) → select your publisher → **Publisher → Settings**; the publisher-specific Settings page URL also works.
5. Once linked, ask things like:
   - "Show daily installs for my extension over the last 7 days."
   - "Compare impressions by country."
   - "How many active users did my extension have last week?"

If your client doesn't support the interactive settings UI, provide the Store URL and Publisher ID to the client and ask it to call `connect_extension`. The MCP validates Google analytics access before saving the association.

## CI/CD

**CI runs automatically; production deployment requires a version tag.** Pull requests and pushes to `main` trigger [MCP CI](.github/workflows/ci.yml), which runs tests and a Wrangler dry-run build. Ordinary pushes and merges cannot publish a Worker.

Production deployments use [Deploy MCP (release tag)](.github/workflows/deploy.yml). The **only** deployment trigger is pushing a `vX.Y.Z` tag to GitHub. The release tag must match `package.json` version and point to a commit already in `main`.

To deploy a release version (for example `0.3.0`), after merging the desired changes into `main`:

```sh
git checkout main
git pull --ff-only
git tag v0.3.0
git push origin v0.3.0
```

For subsequent releases, bump the version in `package.json` and `package-lock.json`, commit it to `main`, then tag and push the corresponding `vX.Y.Z`. You can also create a new version tag in the GitHub Releases interface. The GitHub Actions workflow verifies the tag format, matching package version, source commit ancestry, tests and build **before** deploying the exact tagged commit. The `production` environment can additionally require approval.

The upstream deployment uses three Actions **environment secrets** on `production`:

| Secret | Value |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | Cloudflare token with Workers Editor for the intended Worker |
| `CLOUDFLARE_ACCOUNT_ID` | The matching Cloudflare account ID |
| `WRANGLER_PRODUCTION_CONFIG` | Complete production `wrangler.toml` (Worker URL, KV/D1 IDs, and the `GOOGLE_API_RATE_LIMITER` binding) |

The production configuration must include the rate limiter defined in `wrangler.example.toml`:

```toml
[[ratelimits]]
name = "GOOGLE_API_RATE_LIMITER"
namespace_id = "1001"

[ratelimits.simple]
limit = 20
period = 60
```

Choose a unique rate-limit namespace within your Cloudflare account. The predeploy validation rejects missing required bindings **before** publishing and checks that the private configuration's `account_id` matches the `CLOUDFLARE_ACCOUNT_ID` environment secret. No real account or resource IDs belong in the public workflow. The workflow writes private configuration only on the GitHub runner and never applies D1 migrations automatically. Worker secrets stay in Cloudflare.

**No deployment toggle or Run workflow button is needed:** `CF_DEPLOY_ENABLED` is unused and may be deleted from Actions variables.

**Forks:** The upstream tag-triggered deployment workflow intentionally runs only in the upstream repository. Fork maintainers must adapt the repository check and configure their own production environment secrets. You can always self-host and deploy manually with `npm run deploy`.

## Privacy and security

This app stores per-user Google OAuth grants/refresh tokens in Cloudflare KV, and stores account-scoped extension settings and opt-in metrics/ranking history in Cloudflare D1. Optional user-provided SerpAPI keys are AES-GCM encrypted and stored in KV, never in D1 or source control. Cloudflare and your MCP client may retain operational logs and/or conversation history.

Do not commit OAuth secrets, Cloudflare API tokens or your local `wrangler.toml`. Review the privacy policy, Google OAuth consent settings, security controls and data-retention implications before allowing third-party users to connect to your instance.

## Support

[Issues and feature requests](https://github.com/OTLFrostA/chrome-web-store-analytics-mcp/issues). This is an independent project, not affiliated with Google, Chrome, Cloudflare or OpenAI.

## Account safety and revocation

- The Google consent scope is `openid email chromewebstore.readonly`, not extension publishing access.
- The pinned Cloudflare OAuth Provider v1.2.4 stores issued tokens by hash and AES-GCM-encrypts authorization `props`. D1 stores extension associations and opt-in metrics/ranking histories; the scheduled Google credential is AES-GCM encrypted in KV.
- The settings panel's **Disconnect Google account** action (or the `disconnect_google_account` MCP tool, invoked only with explicit user approval) revokes upstream Google access, deletes that account's D1 extension links, and revokes MCP grants. Reconnection is required afterward. Google token revocation can also invalidate other grants under the same Google Cloud project.
- Self-service disconnection checks all existing grants first and declines to proceed when an account has more than eight active grants, rather than risk partial deletion on Workers Free. In that case, revoke access in Google Account settings and request server-side cleanup.
- Linking and metric queries share a **per-verified-Google-account limit of 20 Google API requests per minute, per Cloudflare location**. Cloudflare's rate limit is approximate, not a global strict quota. Every self-hosting deployment must include the `GOOGLE_API_RATE_LIMITER` binding in its private `wrangler.toml`.
- Token refresh and every metrics page each consume one unit of that budget. A query can be interrupted when the remaining budget runs out; wait before retrying.
- Anonymous `POST /oauth/register` requests use the same binding with separate per-IP and aggregate keys: each budget allows 20 attempts per minute per Cloudflare location with the example configuration. Rejected requests do not reach OAuth KV. Missing or failed protection returns 503; exhausted budgets return 429 with `Retry-After`. Cloudflare sets the source-IP header; custom reverse proxies must preserve a trustworthy source IP. These approximate local budgets do not replace edge WAF rules or a strict global quota.
- Registration payloads are limited to 16 KiB, five redirect URIs (2,048 characters each), and a 200-character client name. The OAuth provider still validates redirect URI safety and protocol compatibility. Dynamic registrations expire after seven days; the provider renews registrations used by active grants.
- If D1 deletion fails during disconnection, the server still attempts to revoke every verified MCP grant and reports incomplete cleanup for operator follow-up. An error does not mean no changes were made.
- Production CI masks quoted configuration values and endpoint host/origin components before running Wrangler. Existing public logs must be deleted separately if they were produced before this protection.
- Account-owned D1 statements must always bind the verified Google subject, never an extension or publisher identifier supplied by a client.

Before inviting third-party users, perform a manual two-account test: sign in separately with Google A and Google B, link distinct extensions, then verify neither account can enumerate, query or delete the other's associations. Unit tests use fake users and must never use real Google tokens.


## Optional daily data collection (opt-in)

The collector supports Chrome Web Store daily analytics, Chrome Web Store internal keyword rankings, and optional Google organic rankings (user-owned SerpAPI account), all in the same Worker and D1. By default, this feature is OFF for each Google account. Call `enable_daily_collection` once using the connected OAuth session to store an AES-GCM encrypted scheduled refresh credential. Disabling the collector deletes that copy; disconnecting the account deletes its private histories and credential.

Each collector registers an ID, its collection function, and its desired local hour. An hourly UTC Cloudflare Cron invokes only collectors due in the `America/Los_Angeles` timezone; all three built-in tasks default to 8:00 AM PT, including DST. Every scheduled task/day/extension is deduplicated. Use `collect_now` for manual reruns or initial data backfill, `set_ranking_keywords` to track up to 20 search phrases, `get_collection_status` to inspect runs and failures, and `get_saved_metrics`/`get_ranking_history` to read historical data.

Ranking keywords are **runtime data in D1**, scoped by the authorized Google account and the linked extension. There are no hard-coded or shared default search phrases. Use `set_ranking_keywords` with 1–20 phrases to configure a specific extension; send an empty array (`keywords: []`) to clear its tracking. With no configured keywords, ranking collection is skipped without error or a recorded run, while analytics continues normally. Previously saved ranking history is retained.

### Optional Google organic search rankings (SerpAPI BYOK)

Google Search rankings are a **separate** task from Chrome Web Store internal search rankings. Users must explicitly configure their own SerpAPI credential and per-extension keywords. The app owner supplies **no shared SerpAPI token or Gemini-specific default keywords**.

1. Use `open_serpapi_settings` to open a private password-entry form and add your personal SerpAPI API key. The server verifies it against SerpAPI's quota-free Account API before encrypting it with the existing `SCHEDULE_TOKEN_KEY` and saving it under your Google subject in KV. The key is never returned. Never paste keys into a public issue or chat.
2. Call `set_google_search_keywords` with the target extension and up to 20 Google organic search queries. An empty array turns Google keyword monitoring off for that extension without deleting its history.
3. `get_serpapi_status` reports whether **your** key exists and tracks your request count. `set_serpapi_monthly_limit` changes your account-level monthly request cap (default 200); all linked extensions share that cap. Always choose a cap that fits your own SerpAPI plan. This protective counter resets by Pacific calendar month and may differ from SerpAPI's billing cycle.
4. `collect_now` with `taskId: "google-search-ranking"` queries on demand; `get_google_search_history` reads results. Scheduled collection runs at 8:00 AM PT only if your key, keywords, and daily collection subscription are configured.

Each search keyword/date/account/extension is reserved in D1 before the external API request. Retriggering the same day does not spend more requests. Failed requests are stored with redacted status codes; a `not_found` result means only that the Web Store listing was absent from returned Google organic results. The Worker does not return plaintext SerpAPI keys, provider account emails or complete provider responses. If your Key is missing, the Google Search task skips cleanly; Analytics and internal store ranking still run.

`remove_serpapi_key` deletes your encrypted key but retains search history. `disconnect_google_account` deletes it alongside account-scoped histories. Cloudflare Worker secrets cannot be extracted in plaintext: anyone migrating from a legacy shared Worker secret must enter their own SerpAPI key once in the new UI.

The analytics collector uses Google's official API, backfills up to 90 complete UTC days on its first successful run, then refreshes a 14-day correction window. The Chrome Web Store ranking collector uses an **undocumented** Chrome Web Store search RPC that may change without notice. A null rank means the extension was not found among returned results, NOT rank zero.

### Deploy requirements

Keep the existing `MCP_DB` and `OAUTH_KV` bindings and initialize `schema.sql` for a new database. Apply `migrations/0001_collectors.sql` and then `migrations/0002_google_search.sql` to the existing D1 using an authorized Cloudflare account before deploying. The tag release workflow configures the hourly Cron trigger; it runs D1 migrations automatically only when the GitHub repository/environment variable `ENABLE_D1_MIGRATIONS` is set to `true` and its Cloudflare API token has D1 permissions. The initial v0.2.0 production schema was pre-applied through Cloudflare. This keeps the least-privilege Worker deployment token usable. To enable scheduled Google access, configure `SCHEDULE_TOKEN_KEY` as a Worker secret containing a persistent random 32-byte base64 key (for example `openssl rand -base64 32` piped into `wrangler secret put SCHEDULE_TOKEN_KEY`). **Do not commit this key or rotate it without migrating stored credentials; it also protects per-user SerpAPI keys.** Verify migrations, secrets, CI, and isolated staging before publishing a production tag.

For safety, `main` pushes do not deploy; production runs only from version tags under the existing release workflow. Do not reuse production KV, D1, or OAuth client secrets when validating new collectors in staging.
