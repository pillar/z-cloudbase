-- api module: storage quota/listing lookups and de-duplication of in-flight self-service requests.

CREATE INDEX storage_objects_env_status ON storage_objects (product_env_id, status);

-- At most one open account deletion and one open export per user (POST is idempotent, races collapse).
CREATE UNIQUE INDEX deletion_requests_open_delete ON deletion_requests (user_id)
  WHERE kind = 'delete' AND scope = 'account' AND status IN ('pending','processing');
CREATE UNIQUE INDEX deletion_requests_open_export ON deletion_requests (user_id)
  WHERE kind = 'export' AND status IN ('pending','processing');
