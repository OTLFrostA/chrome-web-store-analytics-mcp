import { readFileSync } from "node:fs";

const config = readFileSync(new URL("../wrangler.toml", import.meta.url), "utf8");
const endpoint = config.match(/^MCP_RESOURCE\s*=\s*"([^"]+)"\s*$/m)?.[1];
if (!endpoint) throw new Error("MCP_RESOURCE is not configured.");
const base = new URL(endpoint).origin;

for (const [path, expected] of [
  ["/", "Chrome Web Store Analytics"],
  ["/privacy", "Privacy Policy"],
  ["/terms", "Terms of Service"],
]) {
  let failure;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const response = await fetch(base + path, { signal: AbortSignal.timeout(12000) });
      const html = await response.text();
      if (!response.ok || !html.includes(expected)) {
        throw new Error(path + " returned HTTP " + response.status + " or unexpected content");
      }
      failure = undefined;
      console.log("OK " + path);
      break;
    } catch (error) {
      failure = error;
      if (attempt < 4) await new Promise(resolve => setTimeout(resolve, (attempt + 1) * 1000));
    }
  }
  if (failure) throw failure;
}
