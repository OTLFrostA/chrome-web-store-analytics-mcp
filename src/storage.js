import { parseItemId } from "./validation.js";

export async function listUserExtensions(db, googleSub) {
  const { results } = await db.prepare(
    "SELECT item_id AS itemId, publisher_id AS publisherId, store_url AS storeUrl FROM user_extensions WHERE google_sub = ? ORDER BY item_id"
  ).bind(googleSub).all();
  return results || [];
}

export async function saveUserExtension(db, googleSub, { itemId, publisherId, storeUrl }) {
  return db.prepare(
    "INSERT INTO user_extensions (google_sub, item_id, publisher_id, store_url) VALUES (?, ?, ?, ?) " +
    "ON CONFLICT(google_sub, item_id) DO UPDATE SET publisher_id = excluded.publisher_id, store_url = excluded.store_url"
  ).bind(googleSub, itemId, publisherId, storeUrl).run();
}

export async function removeUserExtension(db, googleSub, itemId) {
  const outcome = await db.prepare(
    "DELETE FROM user_extensions WHERE google_sub = ? AND item_id = ?"
  ).bind(googleSub, parseItemId(itemId)).run();
  return (outcome.meta?.changes ?? 0) > 0;
}

export function selectUserExtension(extensions, itemId) {
  if (!extensions.length) throw new Error("Connect an extension first using its store URL and Publisher ID.");
  const chosen = itemId
    ? extensions.find(extension => extension.itemId === parseItemId(itemId))
    : (extensions.length === 1 ? extensions[0] : null);
  if (!chosen) throw new Error("Choose one of the connected extension IDs: " +
    extensions.map(extension => extension.itemId).join(", "));
  return chosen;
}
