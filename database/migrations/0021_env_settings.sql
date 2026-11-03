-- api module: per-environment extension allowlist and daily upload quota (PRD §19.11).
ALTER TABLE product_environments ADD COLUMN allowed_extensions TEXT NOT NULL DEFAULT '[]';           -- JSON array, lowercase, no dot; empty = any
ALTER TABLE product_environments ADD COLUMN daily_upload_quota_bytes INTEGER NOT NULL DEFAULT 1073741824; -- DEFAULT_DAILY_UPLOAD_BYTES

-- Daily quota sums uploads created since UTC midnight.
CREATE INDEX storage_objects_env_created ON storage_objects (product_env_id, created_at);
