-- Self-serve "Connect Instagram / Facebook".

ALTER TABLE shop_channels ADD COLUMN IF NOT EXISTS display_name TEXT;          -- @username or Page name
ALTER TABLE shop_channels ADD COLUMN IF NOT EXISTS connected_at TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE shop_channels ADD COLUMN IF NOT EXISTS refreshed_at TIMESTAMPTZ;

-- Facebook: the owner may manage several Pages; we keep the list for 15 minutes while they pick one.
CREATE TABLE IF NOT EXISTS oauth_pending (
  id          TEXT PRIMARY KEY,                     -- random, sent to the browser
  shop_id     BIGINT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  owner_id    BIGINT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  pages_enc   TEXT NOT NULL,                        -- encrypted JSON [{id,name,access_token}]
  expires_at  TIMESTAMPTZ NOT NULL
);
