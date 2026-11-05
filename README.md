# Chrome Web Store Analytics MCP

Explore your Chrome extension's analytics, ratings, reviews, publishing status, and search rankings in **ChatGPT** or another OAuth-capable MCP client. Google access is **read-only**: this MCP cannot edit listings, publish updates, or reply to reviews.

## Connect

**Hosted MCP server:** [https://cws-analytics-mcp.cws-analytics-mcp.workers.dev/mcp](https://cws-analytics-mcp.cws-analytics-mcp.workers.dev/mcp)

1. In ChatGPT, add a custom remote MCP server under **Settings → Plugins** (availability depends on your plan or workspace).
2. Paste the MCP URL above and sign in with a Google account that has access to your Chrome Web Store publisher.
3. Ask ChatGPT to **open Chrome Web Store extension settings**. Enter your extension's public Store URL and **Publisher ID** (find it in [Developer Dashboard](https://chrome.google.com/webstore/developer/dashboard) → **Publisher → Settings**).
4. Ask for analytics or reviews. To keep history, ask ChatGPT to **enable daily collection**; configure tracked keywords in **keyword settings**.

## Example prompts

- “Show installs and active users for my extension over the last 90 days.”
- “Compare impressions by country over the last month.”
- “Fetch the latest reviews and summarize common complaints.”
- “What version is published, is another revision pending review, and are there policy warnings?”
- “Show my average rating and 1–5 star rating breakdown.”
- “How did my rating and publishing status change over the past month?”
- “Show the saved Google Search results for my monitored keywords.”
- “Track these Chrome Web Store search keywords for my extension: …”
- “Enable daily collection and show my historical metrics and rankings.”

Every successful external query saves its useful results to account-scoped history, whether you query manually or enable Cron. Removing a linked extension clears its saved history.

Analytics and reviews use Google's official Chrome Web Store API. Metrics can lag and the API provides up to **90 complete days** per live query. Chrome Web Store keyword ranking uses public search results, not an official ranking API. Optional **Google organic search** ranking uses your own [Bright Data](https://brightdata.com/) API key; you can configure it privately through the MCP.

## Self-host on Cloudflare

1. Have **Node.js 22+**, a Cloudflare account (Workers/KV/D1), and a Google Cloud project with the **Chrome Web Store API** enabled.
2. `git clone https://github.com/OTLFrostA/chrome-web-store-analytics-mcp.git && cd chrome-web-store-analytics-mcp && npm ci && npx wrangler login`
3. Create resources: `npx wrangler kv namespace create OAUTH_KV` and `npx wrangler d1 create cws_analytics_mcp`.
4. `cp wrangler.example.toml wrangler.toml`; set your Worker `name`, `account_id`, `MCP_RESOURCE` (`https://YOUR_WORKER_HOST/mcp`), and KV/D1 IDs; keep the rate-limit binding.
5. In Google Cloud, configure OAuth consent and a **Web application** OAuth client with redirect URI `https://YOUR_WORKER_HOST/callback`.
6. Initialize D1: `npx wrangler d1 execute MCP_DB --remote --file=schema.sql` then `npx wrangler d1 migrations apply MCP_DB --remote`.
7. Deploy: `npm run deploy`.
8. Set Worker secrets with `npx wrangler secret put` for `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and `SCHEDULE_TOKEN_KEY` (generate the last with `openssl rand -base64 32`).
9. Connect `https://YOUR_WORKER_HOST/mcp` in your MCP client. Never commit `wrangler.toml` or credentials.

[Privacy policy](https://cws-analytics-mcp.cws-analytics-mcp.workers.dev/privacy) · [Support / issues](https://github.com/OTLFrostA/chrome-web-store-analytics-mcp/issues)

Independent open-source project; not affiliated with Google, Chrome, Cloudflare, or OpenAI.
