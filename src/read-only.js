const BASE = "https://chromewebstore.googleapis.com/v2/publishers/";

async function readItem(token, publisherId, itemId, suffix, request = fetch) {
  const resource = "publishers/" + publisherId + "/items/" + itemId;
  const url = BASE + encodeURIComponent(publisherId) + "/items/" +
    encodeURIComponent(itemId) + suffix;
  const response = await request(url, {
    method: "GET",
    redirect: "manual",
    headers: { Authorization: "Bearer " + token, Accept: "application/json" },
  });
  if (response.status === 401) {
    throw new Error("Google authorization was rejected (HTTP 401). Reconnect your Google account.");
  }
  if (response.status === 403 || response.status === 404) {
    throw new Error("Chrome Web Store item is not accessible (HTTP " + response.status +
      "). Check the linked Publisher ID, extension and Google account.");
  }
  if (!response.ok) {
    throw new Error("Chrome Web Store read-only request failed (HTTP " + response.status + ").");
  }
  let data;
  try { data = await response.json(); }
  catch { throw new Error("Google returned invalid Chrome Web Store JSON."); }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("Google returned an invalid Chrome Web Store response.");
  }
  const expectedName = resource + (suffix === ":fetchStatus" ? "" : "/ratingSummary");
  if ((data.name !== undefined && data.name !== expectedName) ||
      (data.itemId !== undefined && data.itemId !== itemId)) {
    throw new Error("Google returned a resource that does not match the linked extension.");
  }
  return { publisherId, itemId, ...data };
}

// The official v2 status response includes published/submitted revisions, rollout
// percentages, upload state, takedown and warning flags.
export function fetchExtensionStatus(token, publisherId, itemId, request = fetch) {
  return readItem(token, publisherId, itemId, ":fetchStatus", request);
}

// Google returns rating counts as int64 strings. Preserve those strings rather
// than converting them to potentially imprecise JavaScript numbers.
export function getRatingSummary(token, publisherId, itemId, request = fetch) {
  return readItem(token, publisherId, itemId, "/ratingSummary", request);
}
