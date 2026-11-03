import { pathToFileURL } from "node:url";

export function maskCommands(config, extraValues = []) {
  const values = new Set(extraValues.filter(Boolean));
  // Mask every quoted config value, including IDs, database/Worker names and
  // endpoint components that Wrangler prints separately from the full TOML.
  for (const match of config.matchAll(/"([^"\r\n]+)"|'([^'\r\n]+)'/g)) {
    const value = match[1] ?? match[2];
    values.add(value);
    if (URL.canParse(value)) {
      const url = new URL(value);
      values.add(url.origin);
      values.add(url.hostname);
    }
  }
  return [...values].filter(Boolean).map(value => "::add-mask::" +
    value.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A"));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const config = process.env.WRANGLER_PRODUCTION_CONFIG;
  if (!config) throw new Error("Missing private production configuration");
  for (const command of maskCommands(config, [process.env.CLOUDFLARE_ACCOUNT_ID, process.env.CLOUDFLARE_API_TOKEN])) {
    console.log(command);
  }
}
