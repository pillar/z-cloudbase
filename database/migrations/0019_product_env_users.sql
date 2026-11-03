-- identity: users per product environment (PRD §21.5.3, §21.6). Product membership is per product; this
-- records the first authorization of a user in each environment of it. A new row is the `user.joined`
-- webhook event; the rows also scope the per-environment user export and the fan-out of user events.
-- Rows go with the user's data when they leave the product or delete their account.

CREATE TABLE product_env_users (
  product_env_id TEXT NOT NULL REFERENCES product_environments(id),
  user_id        TEXT NOT NULL,
  first_seen_at  INTEGER NOT NULL,
  PRIMARY KEY (product_env_id, user_id)
);
CREATE INDEX product_env_users_user ON product_env_users (user_id);

-- Backfill from existing product refresh tokens (best effort: environments a user only used without
-- offline_access are not known). Engine dates are ISO text; anything else falls back to joined_at.
INSERT OR IGNORE INTO product_env_users (product_env_id, user_id, first_seen_at)
SELECT r."clientId", r."userId",
       CASE WHEN typeof(MIN(r."createdAt")) = 'text' AND unixepoch(MIN(r."createdAt")) IS NOT NULL
            THEN unixepoch(MIN(r."createdAt")) * 1000 ELSE MIN(m.joined_at) END
FROM "oauthRefreshToken" r
JOIN product_environments pe ON pe.id = r."clientId"
JOIN product_memberships m ON m.user_id = r."userId" AND m.product_id = pe.product_id
GROUP BY r."clientId", r."userId";
