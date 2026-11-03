export const MAX_DAYS = 90;
export const MAX_OUTPUT_ROWS = 500;
const EXTENSION_ID = /^[a-p]{32}$/;
const PUBLISHER_ID = /^[A-Za-z0-9_-]{4,128}$/;

export function parseStoreUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error("Enter a valid Chrome Web Store URL."); }
  if (url.protocol !== "https:" || url.username || url.password || url.port) {
    throw new Error("The store URL must be HTTPS and must not contain credentials or a port.");
  }
  if (url.hostname !== "chromewebstore.google.com" && url.hostname !== "chrome.google.com") {
    throw new Error("The URL must point to the official Chrome Web Store.");
  }
  const parts = url.pathname.split("/").filter(Boolean);
  const detailIndex = parts.indexOf("detail");
  if (detailIndex < 0 || detailIndex > 1 || (detailIndex === 1 && parts[0] !== "webstore")) {
    throw new Error("Provide an extension detail page, not a search or developer dashboard URL.");
  }
  const suffix = parts.slice(detailIndex + 1);
  const itemId = suffix.at(-1);
  if ((suffix.length !== 1 && suffix.length !== 2) || !EXTENSION_ID.test(itemId || "")) {
    throw new Error("Could not find a valid 32-character extension ID in that URL.");
  }
  return { itemId, storeUrl: "https://chromewebstore.google.com/detail/" + itemId };
}

export function parsePublisherId(value) {
  const input = typeof value === "string" ? value.trim() : "";
  if (PUBLISHER_ID.test(input)) return input;

  // Accept a publisher-specific Developer Dashboard URL, never the generic homepage.
  let url;
  try { url = new URL(input); } catch {
    throw new Error("Enter a Publisher ID or a publisher-specific Developer Dashboard URL.");
  }
  if (input.length > 2048 || url.protocol !== "https:" || url.hostname !== "chrome.google.com" ||
      url.username || url.password || url.port) {
    throw new Error("Use a Publisher ID or an official HTTPS Chrome Web Store Developer Dashboard URL.");
  }
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts[0] !== "webstore" || parts[1] !== "devconsole" || parts.length < 3 ||
      parts[2] === "settings" || parts[2] === "items" || parts[2] === "dashboard" ||
      !PUBLISHER_ID.test(parts[2])) {
    throw new Error("The Developer Dashboard homepage does not contain a Publisher ID. Open your publisher, go to Publisher > Settings, and copy that page URL or the Publisher ID.");
  }
  return parts[2];
}

export function parseItemId(value) {
  if (typeof value !== "string" || !EXTENSION_ID.test(value)) {
    throw new Error("Invalid extension ID. Use the 32-character ID from the store URL.");
  }
  return value;
}

export function dateRange(days, now = new Date()) {
  if (!Number.isInteger(days) || days < 1 || days > MAX_DAYS) {
    throw new Error("days must be between 1 and " + MAX_DAYS + ".");
  }
  const midnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const last = new Date(midnight - 86400000);
  const first = new Date(midnight - days * 86400000);
  return { from: first.toISOString().slice(0, 10), to: last.toISOString().slice(0, 10) };
}

export function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, char => "&#" + char.charCodeAt(0) + ";");
}
