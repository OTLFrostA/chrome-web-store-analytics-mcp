import { readFileSync } from "node:fs";

const config = readFileSync(new URL("../wrangler.toml", import.meta.url), "utf8");
const field = (name) => config.match(new RegExp("^\\s*" + name + "\\s*=\\s*\"([^\"]+)\"\\s*$", "m"))?.[1];
const account = field("account_id");
const name = field("name");
const resource = field("MCP_RESOURCE");
const kv = config.match(/^\[\[kv_namespaces\]\]\s*\nbinding\s*=\s*"OAUTH_KV"\s*\nid\s*=\s*"([^"]+)"/m)?.[1];
const d1 = config.match(/^\[\[d1_databases\]\]\s*\nbinding\s*=\s*"MCP_DB"\s*\ndatabase_name\s*=\s*"[^"]+"\s*\ndatabase_id\s*=\s*"([^"]+)"/m)?.[1];

const rateLimiter = /\[\[ratelimits\]\]\s*\nname\s*=\s*"GOOGLE_API_RATE_LIMITER"\s*\nnamespace_id\s*=\s*"[1-9][0-9]*"/m.test(config);
const errors = [];
if (!rateLimiter) errors.push("Configure the GOOGLE_API_RATE_LIMITER binding.");
if (!/^[a-f0-9]{32}$/.test(account || "") || /^0+$/.test(account || "")) {
  errors.push("Set a valid Cloudflare account_id.");
}
if (!/^[a-z0-9][a-z0-9-_]*$/.test(name || "")) errors.push("Set a valid Worker name.");
if (!/^[a-f0-9]{32}$/.test(kv || "") || /^0+$/.test(kv || "")) errors.push("Configure an OAUTH_KV namespace ID.");
if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(d1 || "") || /^0{8}-0{4}-0{4}-0{4}-0{12}$/.test(d1 || "")) {
  errors.push("Configure the MCP_DB database ID.");
}
try {
  const url = new URL(resource);
  if (url.protocol !== "https:" || url.pathname !== "/mcp" || url.search || url.hash ||
      url.username || url.password || url.hostname.endsWith(".invalid")) {
    throw new Error("invalid URL");
  }
} catch {
  errors.push("Set MCP_RESOURCE to your exact public HTTPS /mcp endpoint.");
}
if (process.env.CLOUDFLARE_ACCOUNT_ID && account !== process.env.CLOUDFLARE_ACCOUNT_ID) {
  errors.push("CLOUDFLARE_ACCOUNT_ID and account_id do not match.");
}
if (errors.length) {
  for (const error of errors) console.error("Invalid deployment configuration: " + error);
  process.exitCode = 1;
}
