# Data source and authorization architecture (incremental migration)

This document describes the new source-bound model introduced in PR #18.
**The existing CWS flow is a compatibility implementation and has not been migrated.**

## Domain entities

- **Application user** (`app_users.user_id`): internal UUID, independent of login provider.
  `app_user_identities` maps authenticated MCP identities to the app user.
- **Data source** (`data_sources.source_id`): a user-owned external property or resource,
  such as GA4 property `551943445` or a CWS extension. It stores a source type,
  provider, external resource ID, and authorization status, never secrets.
- **Authorization** (`data_source_authorizations.source_id`): metadata for the
  permission grant attached to exactly one data source. Its secret is stored in
  encrypted KV using `owner user ID + provider + source ID`.
  OAuth permissions are provider scopes, not MCP client scopes.
- **Collector**: executable logic for a family of source types. A collector
  declares supported source types; configuration connects an instance to a source
  through `data_source_collectors`. It does not own an OAuth grant.
- **Collection result**: metric/history records, which should be keyed by source
  and date/dimensions when the new collectors are migrated.

```text
MCP login -> app_user_identity -> application user
                                      |
                                      +-- data source (GA4 property A)
                                      |     +-- source authorization -> encrypted KV grant
                                      |     +-- collectors: sessions, events, channels
                                      |
                                      +-- data source (CWS extension B)
                                            +-- source authorization -> encrypted KV grant
                                            +-- collectors: metrics, ratings, reviews
```

## Authorization lifecycle

1. Authenticated MCP session resolves an internal user. User registers a source.
2. `begin_data_source_oauth(sourceId)` verifies ownership and source type.
   It creates a 10-minute PKCE transaction and a one-time, source-bound state.
3. Google redirects to `/source-oauth/callback`. The callback atomically claims
   state, exchanges the authorization code using PKCE, checks granted scopes and
   verified upstream identity, then calls the internal authorization manager.
4. The manager persists the refresh token encrypted with account/source-bound AAD,
   and saves only nonsecret metadata in D1. Tokens are never returned over MCP.
5. Each future source-bound collection resolves its source and verifies owner,
   enabled state, source type, authorization status and required scopes.
6. Disconnecting a source deletes only that local source grant; it leaves history
   and other source connections intact. Provider-wide revocation is deliberately
   not attempted because shared Google OAuth client grants may be affected.
   Account-wide deletion and independent provider revocation must be addressed
   before migrating production users to this path.

The Google OAuth client must have `https://<MCP_WORKER_HOST>/source-oauth/callback`
registered as a redirect URI. This is separate from the MCP login `/callback`.
GA4 requests `analytics.readonly`; CWS requests `chromewebstore.readonly`.
All privileges are optional, least-privilege and source-specific.

## Migration contract

- Preserve `user_extensions`, existing CWS OAuth props, the scheduled CWS KV
  credential and existing Bright Data keys until fully migrated and tested.
- No collector may silently reuse an authorization from another source.
- Migration should create source records for existing extensions, move existing
  credentials to source-scoped KV, verify successful refresh/access, then switch
  jobs and history to source IDs. Do not remove legacy grants before verification.
- New `data_source_collectors` is a source-collector relation; the legacy scheduler
  is not yet using it. `executeSourceCollector` is a new execution boundary for
  future source-bound collector implementations.
- GA4 query/persist, source-bound Cron scheduling, provider-token refresh/revocation,
  account-wide deletion, and production migration are **not implemented** by this PR.
- Do not merge or deploy PR #18 as a complete auth migration. Run test + Worker
  dry-run + OAuth integration checks before enabling the new path.
