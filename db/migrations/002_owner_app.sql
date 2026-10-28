-- Owner app: phone + password login, sessions, owner replies, notification channels.

ALTER TABLE owners ADD COLUMN IF NOT EXISTS name TEXT NOT NULL DEFAULT '';
ALTER TABLE owners ADD COLUMN IF NOT EXISTS phone TEXT;                 -- 8 digits, login id
ALTER TABLE owners ADD COLUMN IF NOT EXISTS password_hash TEXT;         -- scrypt
ALTER TABLE owners ADD COLUMN IF NOT EXISTS lang TEXT NOT NULL DEFAULT 'fr' CHECK (lang IN ('fr','ar'));
ALTER TABLE owners ADD COLUMN IF NOT EXISTS notify_whatsapp BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE owners ALTER COLUMN login DROP NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS owners_phone_uq ON owners(phone) WHERE phone IS NOT NULL;

CREATE TABLE IF NOT EXISTS sessions (
  token_hash  TEXT PRIMARY KEY,                       -- sha256 of the cookie value, never the raw token
  owner_id    BIGINT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  expires_at  TIMESTAMPTZ NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sessions_owner_idx ON sessions(owner_id);

-- Who wrote an outgoing message: the bot or the owner (owner app reply).
ALTER TABLE messages ADD COLUMN IF NOT EXISTS sent_by TEXT NOT NULL DEFAULT 'bot' CHECK (sent_by IN ('bot','owner','customer'));
UPDATE messages SET sent_by = 'customer' WHERE direction = 'in' AND sent_by = 'bot';

-- Order status history (who changed what, when).
CREATE TABLE IF NOT EXISTS order_events (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_id    BIGINT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  status      TEXT NOT NULL,
  owner_id    BIGINT REFERENCES owners(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Brute-force guard on login.
CREATE TABLE IF NOT EXISTS login_attempts (
  phone       TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS login_attempts_idx ON login_attempts(phone, created_at);
