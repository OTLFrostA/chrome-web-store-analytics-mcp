# GA4 property collector

GA4 is an independently authorized **data source** owned by an application user;
it is not a permission added to the MCP login or Chrome Web Store OAuth token.

## Google Cloud prerequisites

1. In the Google Cloud project holding `GOOGLE_CLIENT_ID`, enable **Google Analytics Data API**.
2. Register the exact OAuth web redirect URI:
   `https://cws-analytics-mcp.cws-analytics-mcp.workers.dev/source-oauth/callback`.
3. Configure the consent screen and test users/verification as required by Google
   for `https://www.googleapis.com/auth/analytics.readonly`.
4. The account authorized for the GA4 data source must have read access to that
   GA4 property's reports. OAuth consent alone does not grant access to a property.

## MCP setup

1. `register_data_source` with `sourceType='ga4'`, numeric
   `externalResourceId='<your GA4 property ID>'`, and a display name.
   Save the returned `sourceId`; property IDs must not be hardcoded.
2. `begin_data_source_oauth({sourceId})` and open its Google authorization URL.
   The provider callback binds the refresh token only to that source.
3. Verify `list_data_sources` shows `authStatus='connected'`.
4. `query_ga4({sourceId,dateFrom:'2026-10-29',dateTo:'2026-11-06'})`
   fetches daily totals, install event counts and session source/medium.
   Successful reads replace the corresponding **reported days** in D1.
   Dates not returned by Google remain absent rather than becoming zero.
5. Use `get_ga4_history` for source-bound history without contacting Google.
6. `set_ga4_daily_collection({sourceId,enabled:true})` opts into 9 AM
   America/Los_Angeles collection of the past seven full dates. Turning it
   off keeps historical data and the source's authorization.

## Data semantics

- `activeUsers`, `sessions`, `screenPageViews`: daily GA4 property figures.
- `installEvents`: `eventCount` where `eventName='install'`; **not** CWS
  official installs or distinct installers.
- `sessionSourceMedium`: source/medium breakdown; these totals need not match
  separate overall queries in all cases, so never force reconciliation.
- **Null** `installEvents` = Google did not return a matching event for that
  day; do not coerce to zero.
- The date dimension follows the property's configured reporting timezone;
  it is not Chrome Web Store's UTC metric day.
- GA4 may revise recent data. Scheduled collection backfills seven days, and
  manual queries can request 90 days at a time.
- Source-level authorization can be locally disconnected without affecting other
  sources, but local disconnect does not revoke all grants in Google Account.

## Release verification

- Apply `migrations/0009_ga4.sql` to production `MCP_DB` before deploying.
- Run `npm test`, `npm run check`, release CI and smoke tests.
- After Google OAuth is completed, compare at least one known period against
  the existing Windsor.ai GA4 source before removing Windsor. For property
  `551943445`, prior Windsor report for 2026-11-06 was activeUsers=7,
  sessions=10, views=13, install events=4. This is only a reference, not
  proof that this connector has authenticated or queried the property.
