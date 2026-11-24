# Data source ownership and authorization

The **verified Google OAuth subject (`google_sub`) is the sole tenant identity**.
There is no internal user UUID or login-to-user mapping in the live authorization
path. CWS, Bright Data and independent data sources use the same login subject.

## Boundaries

- Login: the OAuth provider binds its grant to the Google subject and verifies
  the subject against the grant's user ID on every MCP request. Tool inputs never
  specify the owner. The server passes the authenticated `googleSub` directly.
- Source: a UUID identifies an external property, not an account. A source belongs
  to a verified Google subject. All source operations look up `google_sub + source_id`
  before using history, credentials or collector configuration.
- Authorization: a downstream provider identity can differ from the login identity.
  An independently authorized source has its own grant, encrypted in KV with
  `googleSub + provider + sourceId` as the credential namespace and AES-GCM AAD.
- Collector: scheduled execution obtains the subject from the persisted source row,
  checks ownership, authorization and scopes, and does not reuse another source's grant.
- CWS and Bright Data retain their existing account-bound storage and collectors.
  They already use `google_sub`; their histories, credentials and collection
  subscriptions do not need migration.

## One-time migration from the UUID model

Migration `0010_google_sub_ownership.sql` must be applied atomically before
deploying this Worker to an existing database. Capture a D1 Time Travel bookmark
or backup and check the old identity belongs to the intended account. The migration
fails closed for missing/ambiguous identities, overlapping owner namespaces,
mismatched authorization metadata and in-flight source OAuth transactions.

It preserves source UUIDs, data, history, enabled flags and collector settings.
It removes the old mapping tables and changes the source ownership columns to
`google_sub`. It clears old authorization metadata and requires fresh source OAuth
consent: old encrypted KV grants were bound to a UUID, not the Google subject.
Do not copy ciphertext into the new namespace or globally revoke the Google
client. Remove only the old source-grant KV keys after the migration and reconnect
the affected sources. Unexpired authorization transactions must finish or expire
before the migration. No CWS login reconnection is required.

The old Worker fails closed for source operations after the column rename;
the new Worker must not be deployed against the old schema. Coordinate the
schema cutover and production release, then verify the original source IDs,
historical rows, new authorization and scheduled collector configuration.
