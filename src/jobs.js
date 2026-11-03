import { METRICS } from "./metrics.js";

const supported = {
  "install-source": ["installs", "installs-7d", "uninstalls"],
  "install-type": ["installs"],
  "os": ["installs"],
  "utm-source": ["impressions", "page-views"],
  "country": ["installs", "installs-7d", "uninstalls", "users", "users-7d"],
  "app-version": ["installs", "installs-7d", "uninstalls", "users", "users-7d"]
};

export const JOBS = [{ dimension: null, metrics: METRICS }];
for (const [dimension, metrics] of Object.entries(supported)) {
  for (const metric of metrics) JOBS.push({ dimension, metrics: [metric] });
}
