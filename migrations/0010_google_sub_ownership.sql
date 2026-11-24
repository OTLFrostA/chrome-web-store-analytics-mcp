-- One-time ownership migration. Apply atomically before deploying the new Worker.
-- The old mapping is used only here, never to authorize a live request.
-- Source IDs and all source-keyed history/collector configuration remain unchanged.
-- Legacy credentials use the UUID as AES-GCM AAD: reconnect the source rather
-- than copying or accepting a credential bound to the wrong ownership namespace.
CREATE TABLE _google_sub_migration_guard (ok INTEGER NOT NULL CHECK(ok=1));
INSERT INTO _google_sub_migration_guard(ok)
SELECT CASE WHEN
  NOT EXISTS (
    SELECT 1 FROM data_sources d
    WHERE (SELECT COUNT(*) FROM app_user_identities i WHERE i.user_id=d.owner_user_id)<>1
      OR NOT EXISTS (
        SELECT 1 FROM app_user_identities i
        WHERE i.user_id=d.owner_user_id AND i.identity_provider='mcp'
          AND substr(i.identity_subject,1,7)='google-'
          AND length(i.identity_subject) BETWEEN 8 AND 187
          AND substr(i.identity_subject,8) NOT GLOB '*[^a-zA-Z0-9._@-]*'
          AND NOT EXISTS (
            SELECT 1 FROM data_sources other
            WHERE other.owner_user_id=substr(i.identity_subject,8)
          )
      )
  )
  AND NOT EXISTS (
    SELECT 1 FROM data_source_authorizations a LEFT JOIN data_sources d
      ON a.source_id=d.source_id
    WHERE d.source_id IS NULL OR a.owner_user_id<>d.owner_user_id
      OR a.provider<>d.provider
  )
  AND NOT EXISTS (
    SELECT 1 FROM source_oauth_states WHERE consumed=0 AND expires_at>unixepoch()
  )
  THEN 1 ELSE 0 END;

-- Keep the Google-wide OAuth grant untouched. Only old local source metadata
-- and expired/consumed transactions are removed; a fresh consent is required.
DELETE FROM data_source_authorizations;
DELETE FROM source_oauth_states;
UPDATE data_sources
SET owner_user_id=(
  SELECT substr(i.identity_subject,8) FROM app_user_identities i
  WHERE i.user_id=data_sources.owner_user_id AND i.identity_provider='mcp'
),
auth_status=CASE WHEN auth_status IN ('connected','pending')
  THEN 'reauthorization_required' ELSE auth_status END,
updated_at=CURRENT_TIMESTAMP;

ALTER TABLE data_sources RENAME COLUMN owner_user_id TO google_sub;
ALTER TABLE data_source_authorizations RENAME COLUMN owner_user_id TO google_sub;
ALTER TABLE source_oauth_states RENAME COLUMN owner_user_id TO google_sub;

DROP TABLE app_user_identities;
DROP TABLE app_users;
DROP TABLE _google_sub_migration_guard;
