# Chrome Web Store Analytics MCP

A self-hostable MCP server for querying **Chrome Web Store extension analytics from ChatGPT or another OAuth-capable MCP client**. It requests read-only access from Google and can report installs, uninstalls, users, impressions, page views and supported breakdowns.

This repository explains **how to run your own instance**. We are **not publishing a hosted MCP connection URL** or offering a shared hosted service at this time.

## What it does

- Sign in with Google OAuth using `chromewebstore.readonly` (no publishing or editing permissions).
- Connect extensions using a public Chrome Web Store detail URL and your Publisher ID.
- Ask an MCP client for recent metrics, with dimensions including country, OS, install source and app version when supported by Google.
- Keep authorization state in Cloudflare KV and extension associations and historical metrics in D1. Optional daily collection includes Chrome Web Store internal search ranking and Google organic search ranking via each user's own Bright Data token.

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

**CI runs automatically; production deployment is explicit.** Pull requests and pushes to `main` trigger [MCP CI](.github/workflows/ci.yml), which runs tests and a Wrangler dry-run build. Ordinary pushes and merges do not publish a Worker.

Production deployments use [Deploy MCP (release tag or manual)](.github/workflows/deploy.yml). You can either push a `vX.Y.Z` release tag **or** manually start the workflow from the current `main` branch. The tag path requires a matching `package.json` version and a commit already on `main`; the manual path rejects other branches and stale commits.

To deploy a release version (for example `0.3.0`), after merging the desired changes into `main`:

```sh
git checkout main
git pull --ff-only
git tag v0.3.0
git push origin v0.3.0
```

For subsequent tagged releases, bump the version in `package.json` and `package-lock.json`, commit it to `main`, then tag and push the corresponding `vX.Y.Z`. You can also create a new version tag in the GitHub Releases interface. The workflow verifies the tag format, matching package version, source commit ancestry, tests and build **before** deploying the exact tagged commit.

**To deploy manually without creating a tag:**

1. Open GitHub **Actions → Deploy MCP (release tag or manual)**.
2. Click **Run workflow**, select the **main** branch, then click **Run workflow** again to confirm.
3. Inspect the run: it verifies that the selected commit is the current `main` HEAD, then runs tests, a Wrangler dry-run build, production configuration validation, deploy, and a public-page smoke test.

Manual runs do not bump the package version or make a GitHub release. Both paths use the same `production` environment and existing Cloudflare secrets; if environment approval is configured, the deployment waits for approval.

**Automation-friendly explicit production deploy:** when the GitHub integration cannot call the Actions Run workflow API, create or update **only** `.github/deploy-requests/production.txt` on `main` in a single commit. The deploy workflow runs on that exact file change, verifies that it is the only changed file and the commit is the current `main`, then follows the same tests, build, secret validation and production environment approval. Ordinary pushes, PR merges without this marker, and edits to other paths do **not** trigger production CD. The commit may specify the reason for the deployment and the target package version; never put credentials in the marker.

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

**Manual trigger is supported:** the **Run workflow** button appears once this workflow is present on the default branch. `CF_DEPLOY_ENABLED` is unused and may be deleted from Actions variables.

**Forks:** This upstream production deployment workflow (tag or manual) intentionally runs only in the upstream repository. Fork maintainers must adapt the repository check and configure their own production environment secrets. You can always self-host and deploy locally with `npm run deploy`.

## Privacy and security

This app stores per-user Google OAuth grants/refresh tokens in Cloudflare KV, and stores account-scoped extension settings and opt-in metrics/ranking history in Cloudflare D1. Optional user-provided Bright Data tokens are AES-GCM encrypted and stored in KV, never in D1 or source control. Cloudflare and your MCP client may retain operational logs and/or conversation history.

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

The collector supports Chrome Web Store daily analytics, Chrome Web Store internal keyword rankings, and optional Google organic rankings (user-owned Bright Data account), all in the same Worker and D1. By default, this feature is OFF for each Google account. Call `enable_daily_collection` once using the connected OAuth session to store an AES-GCM encrypted scheduled refresh credential. Disabling the collector deletes that copy; disconnecting the account deletes its private histories and credential.

Each collector registers an ID, its collection function, and its desired local hour. An hourly UTC Cloudflare Cron invokes only collectors due in the `America/Los_Angeles` timezone; all three built-in tasks default to 8:00 AM PT, including DST. Every scheduled task/day/extension is deduplicated. Use `collect_now` for manual reruns or initial data backfill, `set_ranking_keywords` to track up to 20 search phrases, `get_collection_status` to inspect runs and failures, and `get_saved_metrics`/`get_ranking_history` to read historical data.

Ranking keywords are **runtime data in D1**, scoped by the authorized Google account and the linked extension. There are no hard-coded or shared default search phrases. Use `set_ranking_keywords` with 1–20 phrases to configure a specific extension; send an empty array (`keywords: []`) to clear its tracking. With no configured keywords, ranking collection is skipped without error or a recorded run, while analytics continues normally. Previously saved ranking history is retained.

### Optional Google organic search rankings (Bright Data BYOK)

Google organic ranking is **separate** from Chrome Web Store internal search ranking. There are no shared provider credentials or built-in product keywords. Each connected Google account configures its own Bright Data API token and keywords per linked extension.

1. Register for a [Bright Data account](https://brightdata.com/products/web-scraper/google) with a free monthly allowance and generate an API token. The free pool is shared with other Bright Data products; verify the terms in your account before enabling collection.
2. Call `open_brightdata_settings` and enter the token privately. `set_brightdata_key` verifies it via Bright Data's read-only zone listing and stores it using AES-GCM encryption in Cloudflare KV. It also deletes the old, unused SerpAPI secret for that Google account.
3. Call `set_google_search_keywords` with **0–100 phrases** for each extension. Keyword sets are account/extension-scoped runtime data in D1, not source-controlled defaults. An empty list pauses organic ranking without removing history. Choose keywords based on your actual goals; the system does not require exactly six keywords.
4. `get_brightdata_status` displays whether the token exists and your local monthly keyword-record usage. `set_brightdata_monthly_limit` sets a local cap of 1–5000 records/month across all your extensions, defaulting to **200** for a cautious initial rollout. This is **not** the real shared Bright Data account balance; if you have other workloads, keep the cap lower. Avoid adding payment funds or auto-recharge if you want to guarantee no paid usage.
5. Call `collect_now` with `taskId: "google-search-ranking"` to **submit** the 100-result dataset job. The collector stores its opaque snapshot ID in account-bound KV and returns `pending`, not a completed rank. Call `refresh_google_search_rankings` to poll it on demand, or let the hourly Cloudflare Cron retrieve the result. `get_google_search_history` returns historical results; existing older SerpAPI history is preserved in the same table.

This implementation uses Bright Data's [Google Top-100 dataset](https://brightdata.com/blog/web-data/google-search-url-parameters) (`gd_mfz5x93lmsjjjylob`) with `start_page:1`, `end_page:10`. It submits one async batch containing all due keyword records for the extension, polls `/datasets/v3/progress/{snapshot_id}`, then downloads `/datasets/v3/snapshot/{snapshot_id}?format=json` once ready. No provider tokens, raw result dumps or complete response bodies are saved or returned through MCP.

Each keyword/date/account/extension is **reserved in D1 before a billable submission**. Repeated daily requests skip existing records; the cap counts reserved keyword records, including failed and legacy SerpAPI records, and resets by Pacific calendar month. Incomplete responses are marked as errors rather than incorrectly reporting "not found"; `not_found` means only not found within the organic results Bright Data returned. Collection safely skips if no Bright Data token exists; Chrome Web Store analytics and internal search continue working.

The Google Search snapshot polling is separate from the initial submission, so asynchronous jobs do not exceed an MCP HTTP timeout. Snapshot metadata expires in KV after seven days; finished jobs are removed. Token verification does not issue a billable Google search request. **You must configure a new Bright Data token after deploying the upgrade; Bright Data tokens are not reused.**

The analytics collector uses Google's official API, backfills up to 90 complete UTC days on its first successful run, then refreshes a 14-day correction window. The Chrome Web Store ranking collector uses an **undocumented** Chrome Web Store search RPC that may change without notice. A null rank means the extension was not found among returned results, NOT rank zero.

### Deploy requirements

Keep the existing `MCP_DB` and `OAUTH_KV` bindings and initialize `schema.sql` for a new database. Apply `migrations/0001_collectors.sql` and then `migrations/0002_google_search.sql` to the existing D1 using an authorized Cloudflare account before deploying. The tag release workflow configures the hourly Cron trigger; it runs D1 migrations automatically only when the GitHub repository/environment variable `ENABLE_D1_MIGRATIONS` is set to `true` and its Cloudflare API token has D1 permissions. The initial v0.2.0 production schema was pre-applied through Cloudflare. This keeps the least-privilege Worker deployment token usable. To enable scheduled Google access, configure `SCHEDULE_TOKEN_KEY` as a Worker secret containing a persistent random 32-byte base64 key (for example `openssl rand -base64 32` piped into `wrangler secret put SCHEDULE_TOKEN_KEY`). **Do not commit this key or rotate it without migrating stored credentials; it also protects per-user Bright Data tokens.** Verify migrations, secrets, CI, and isolated staging before publishing a production tag.

For safety, `main` pushes do not deploy; production runs only from version tags under the existing release workflow. Do not reuse production KV, D1, or OAuth client secrets when validating new collectors in staging.
