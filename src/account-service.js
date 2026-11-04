import { googleOAuthUserId, revokeGoogleRefreshToken } from "./google.js";
import { deleteAccountHistory } from './collection/history.js';
import { deleteCollectorCredential } from './collection/credentials.js';

// Keep self-service deletion within the Workers Free subrequest budget.
// Accounts with unusually many OAuth grants require resumable cleanup.
const MAX_GRANTS_PER_DISCONNECT = 8;

export async function disconnectGoogleAccount({
  googleSub, googleRefreshToken, db, oauth, collectionEnv, revokeGoogleToken = revokeGoogleRefreshToken,
}) {
  const userId = googleOAuthUserId(googleSub);
  const grants = await oauth.listUserGrants(userId, { limit: MAX_GRANTS_PER_DISCONNECT });
  if (!Array.isArray(grants.items) ||
      grants.items.some(grant => grant.userId !== userId || typeof grant.id !== "string")) {
    throw new Error("Could not verify account authorization records. No authorization was revoked.");
  }
  if (grants.items.length === 0) {
    throw new Error("No active MCP grant was found. Try again later or revoke access directly in your Google Account.");
  }
  if (grants.cursor) {
    throw new Error("This account has too many active sessions for self-service deletion. Revoke access in your Google Account and contact support for server-side cleanup.");
  }
  // Revoke upstream first; failures here must not delete local configuration
  // while live Google authorization remains usable.
  await revokeGoogleToken(googleRefreshToken);
  let deleted;
  let databaseDeletionFailed = false;
  try {
    deleted = await db.prepare("DELETE FROM user_extensions WHERE google_sub = ?").bind(googleSub).run();
  } catch {
    // D1 outages must never prevent attempts to revoke the remaining sessions.
    databaseDeletionFailed = true;
  }
  let collectorCleanupFailed = false;
  if (collectionEnv) {
    try {
      await deleteAccountHistory(db, googleSub);
      await deleteCollectorCredential(collectionEnv, googleSub);
    } catch {
      collectorCleanupFailed = true;
    }
  }
  let failedGrantRevocations = 0;
  for (const grant of grants.items) {
    try {
      await oauth.revokeGrant(grant.id, userId);
    } catch {
      failedGrantRevocations++;
    }
  }
  if (databaseDeletionFailed || failedGrantRevocations || collectorCleanupFailed) {
    const failures = [
      ...(databaseDeletionFailed ? ["saved extension data could not be deleted"] : []),
      ...(collectorCleanupFailed ? ["saved collection history or its credential could not be deleted"] : []),
      ...(failedGrantRevocations ? ["some MCP sessions could not be deleted"] : []),
    ];
    throw new Error("Google authorization was revoked, but " + failures.join(" and ") + ". Contact support for cleanup.");
  }
  return {
    disconnected: true,
    removedExtensions: deleted.meta?.changes ?? 0,
    revokedSessions: grants.items.length,
    nextStep: "Disconnect this MCP app in your client. Reconnect with Google to use it again.",
  };
}
