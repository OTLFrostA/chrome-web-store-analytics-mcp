const SOURCE = "https://github.com/OTLFrostA/chrome-web-store-analytics";
const ISSUES = SOURCE + "/issues";

function htmlPage(name, body) {
  const html = [
    "<!doctype html><html lang=en><head><meta charset=utf-8>",
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    "<title>" + name + " | Chrome Web Store Analytics</title>",
    "<style>body{font:16px/1.6 system-ui,sans-serif;max-width:780px;margin:5vh auto;padding:0 20px 50px}",
    "nav{display:flex;flex-wrap:wrap;gap:16px}h1{line-height:1.2}h2{margin-top:2rem;font-size:1.15rem}",
    "a{color:inherit;text-underline-offset:3px}small{opacity:.75}</style>",
    "</head><body>",
    '<nav><a href="/">Home</a><a href="/privacy">Privacy</a>',
    '<a href="/terms">Terms</a><a href="/support">Support</a></nav>',
    "<main>" + body + "</main><hr><small>Independent open-source project. Not affiliated with Google or OpenAI. ",
    '<a href="' + SOURCE + '">Source code</a></small></body></html>'
  ].join("");
  return new Response(html, {headers: {
    "Content-Type": "text/html; charset=utf-8",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
    "Cache-Control": "public, max-age=300"
  }});
}

export function publicPage(pathname) {
  if (pathname === "/") return htmlPage("Home",
    "<h1>Chrome Web Store Analytics</h1>" +
    "<p>Explore your Chrome extension statistics in ChatGPT with a read-only Google connection.</p>" +
    "<p>Connect your Google account through ChatGPT, add your public Chrome Web Store extension URL and Publisher ID, " +
    "then ask ChatGPT about installs, uninstalls, active users, impressions, page views, and available breakdowns.</p>" +
    "<p>We query Google on demand and do not store your analytics results in an analytics warehouse. " +
    "Your ChatGPT conversation may include returned statistics.</p>" +
    '<p><a href="/privacy">Privacy details</a> · <a href="' + SOURCE + '">Open-source repository</a></p>');
  if (pathname === "/privacy") return htmlPage("Privacy Policy",
    "<h1>Privacy Policy</h1><p><small>Effective November 1, 2026</small></p>" +
    "<h2>Data we process</h2>" +
    "<p>Chrome Web Store Analytics obtains your Google account stable ID, verified email, and OAuth authorization " +
    "with read-only Chrome Web Store analytics scope. The Google ID, selected Publisher ID, extension ID, and public " +
    "extension URL are saved in a Cloudflare D1 database. OAuth grants and refresh tokens are held in protected " +
    "Cloudflare KV through the OAuth provider. Our service does not request permission to publish or edit extensions.</p>" +
    "<h2>Use of analytics</h2>" +
    "<p>We request Chrome Web Store metrics from Google only in response to an authorized query, and return the " +
    "results to your ChatGPT or MCP client. We do not persist these metric results in our MCP database. " +
    "The connected client may save them in chat history under its own policies.</p>" +
    "<h2>Service providers and logs</h2>" +
    "<p>Google supplies analytics and OAuth identity information. Cloudflare hosts the Worker, database, OAuth " +
    "storage, and operational logs. These logs may contain request metadata, timestamps, error categories, and " +
    "HTTP statuses. We do not intentionally log OAuth credentials or full analytics responses. " +
    "We do not sell your data or use it for ads.</p>" +
    "<h2>Controls</h2>" +
    "<p>You can remove individual extensions in the settings panel. The Disconnect Google account action " +
    "revokes upstream authorization, deletes all your linked extensions, and revokes your MCP sessions. " +
    "Google revocation may invalidate other authorizations associated with the same Google Cloud project. " +
    "You can also revoke access through your Google Account, or disconnect the plugin in ChatGPT. " +
    "Cloudflare operational logs may remain subject to platform retention. " +
    "To request help regarding account data, use our Support page; do not publish sensitive data in an issue.</p>" +
    '<p><a href="/support">Contact and support</a></p>');
  if (pathname === "/terms") return htmlPage("Terms of Service",
    "<h1>Terms of Service</h1><p><small>Effective November 1, 2026</small></p>" +
    "<h2>Use</h2><p>This free, early-stage tool is for developers with authorized Google access to their own " +
    "Chrome Web Store extension analytics. Do not attempt to access data you are not authorized to view.</p>" +
    "<h2>Service limitations</h2><p>Metrics come from Google's API and may be delayed, incomplete, or unavailable. " +
    "We cannot guarantee accuracy or uptime, and may update, suspend, or discontinue the MVP. " +
    "No publishing or extension editing functionality is provided.</p>" +
    "<h2>Disclaimer</h2><p>This independent project is not endorsed by Google or OpenAI. " +
    "It is provided as-is without warranties to the extent permitted by applicable law. " +
    "You can disconnect and revoke authorization at any time.</p>" +
    '<p><a href="/support">Support</a></p>');
  if (pathname === "/support") return htmlPage("Support",
    '<h1>Support</h1><p>Report non-sensitive bugs and request improvements at ' +
    '<a href="' + ISSUES + '">our public GitHub issue tracker</a>.</p>' +
    "<p>Do not publish passwords, access tokens, OAuth codes, or private account analytics in public issues. " +
    "For privacy or deletion inquiries, ask for a private follow-up without including personal information.</p>");
  return null;
}
