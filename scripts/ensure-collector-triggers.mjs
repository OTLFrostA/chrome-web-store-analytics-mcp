import { readFileSync, writeFileSync } from 'node:fs';
const path = 'wrangler.toml';
let config = readFileSync(path, 'utf8');
const triggers = ['0 * * * *'];
const match = /^\[triggers\]\s*$/m.exec(config);
if (match) {
  const remainder = config.slice(match.index + match[0].length);
  const nextSection = /^\s*\[/m.exec(remainder);
  const section = nextSection ? remainder.slice(0, nextSection.index) : remainder;
  if (!triggers.every(t => section.includes('"' + t + '"') || section.includes("'" + t + "'"))) {
    throw new Error('Existing [triggers] must include the hourly dispatcher cron expression.');
  }
} else {
  config += '\n[triggers]\ncrons = ["0 * * * *"]\n';
  writeFileSync(path, config, { mode: 0o600 });
}
