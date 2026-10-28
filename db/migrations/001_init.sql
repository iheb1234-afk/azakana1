-- Azakana: initial schema (Technical Plan v2, section 4)
-- Every table carries shop_id (directly or through its parent) so one backend serves many shops.

CREATE TABLE IF NOT EXISTS shops (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name            TEXT NOT NULL,
  languages       TEXT[] NOT NULL DEFAULT '{fr,tn}',
  system_prompt   TEXT NOT NULL DEFAULT '',          -- shop-specific tone, FAQ, policies
  delivery_rules  JSONB NOT NULL DEFAULT '{"fee": 0}', -- e.g. {"fee": 7, "zones": "...", "delay": "24-48h"}
  plan            TEXT NOT NULL DEFAULT 'trial',
  trial_end       DATE,
  daily_ai_cap    INT NOT NULL DEFAULT 500,          -- max Gemini calls per day (cost guard)
  active          BOOLEAN NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS shop_channels (
  id                   BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  shop_id              BIGINT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  channel              TEXT NOT NULL CHECK (channel IN ('instagram','facebook','whatsapp','telegram','test')),
  external_account_id  TEXT NOT NULL,                -- IG account ID / Page ID / WA phone number ID
  access_token_enc     TEXT NOT NULL,                -- AES-256-GCM, never logged
  token_expiry         TIMESTAMPTZ,
  status               TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled','token_expired')),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (channel, external_account_id)              -- tenant lookup key
);

CREATE TABLE IF NOT EXISTS owners (
  id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  shop_id           BIGINT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  login             TEXT NOT NULL UNIQUE,            -- email
  telegram_chat_id  TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS products (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  shop_id      BIGINT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  description  TEXT NOT NULL DEFAULT '',
  image_url    TEXT,
  price        NUMERIC(10,3) NOT NULL CHECK (price >= 0),  -- TND has 3 decimals (millimes)
  active       BOOLEAN NOT NULL DEFAULT TRUE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS products_shop_idx ON products(shop_id) WHERE active;

CREATE TABLE IF NOT EXISTS variants (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  product_id      BIGINT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  label           TEXT NOT NULL,                     -- "50ml", "M", "Bleu"
  price_override  NUMERIC(10,3) CHECK (price_override >= 0), -- NULL = use product price
  stock_qty       INT NOT NULL DEFAULT 0 CHECK (stock_qty >= 0),
  active          BOOLEAN NOT NULL DEFAULT TRUE
);
CREATE INDEX IF NOT EXISTS variants_product_idx ON variants(product_id);

CREATE TABLE IF NOT EXISTS conversations (
  id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  shop_id          BIGINT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  channel          TEXT NOT NULL,
  customer_id      TEXT NOT NULL,                    -- channel-specific (IGSID, PSID...)
  bot_paused       BOOLEAN NOT NULL DEFAULT FALSE,   -- owner take-over flag
  needs_attention  BOOLEAN NOT NULL DEFAULT FALSE,   -- photo / failure / handoff flag
  state            TEXT NOT NULL DEFAULT 'idle'
                   CHECK (state IN ('idle','collecting_order','awaiting_confirmation','handed_to_owner')),
  last_message_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (shop_id, channel, customer_id)
);

CREATE TABLE IF NOT EXISTS messages (
  id                   BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  conversation_id      BIGINT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  channel              TEXT NOT NULL,
  direction            TEXT NOT NULL CHECK (direction IN ('in','out')),
  text                 TEXT,
  media_url            TEXT,
  external_message_id  TEXT,                         -- NULL allowed for outgoing if the API returns none
  status               TEXT NOT NULL DEFAULT 'received'
                       CHECK (status IN ('received','processing','done','failed','skipped')),
  attempts             INT NOT NULL DEFAULT 0,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (channel, external_message_id)              -- THE dedupe
);
CREATE INDEX IF NOT EXISTS messages_conv_idx ON messages(conversation_id, created_at);
CREATE INDEX IF NOT EXISTS messages_pending_idx ON messages(status, updated_at)
  WHERE direction = 'in' AND status IN ('received','processing','failed');

CREATE TABLE IF NOT EXISTS media (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  message_id  BIGINT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  mime        TEXT,
  data        BYTEA,                                 -- MVP: platform URLs expire, so keep a copy
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS orders (
  id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  shop_id          BIGINT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  conversation_id  BIGINT NOT NULL REFERENCES conversations(id),
  customer_name    TEXT NOT NULL,
  phone            TEXT NOT NULL,
  address          TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'draft'
                   CHECK (status IN ('draft','awaiting_confirmation','confirmed','shipped','delivered','cancelled','returned')),
  delivery_fee     NUMERIC(10,3) NOT NULL DEFAULT 0,
  total            NUMERIC(10,3) NOT NULL DEFAULT 0,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  confirmed_at     TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS orders_shop_idx ON orders(shop_id, created_at DESC);
CREATE INDEX IF NOT EXISTS orders_conv_idx ON orders(conversation_id, status);

CREATE TABLE IF NOT EXISTS order_items (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_id    BIGINT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  variant_id  BIGINT NOT NULL REFERENCES variants(id),
  qty         INT NOT NULL CHECK (qty > 0),
  unit_price  NUMERIC(10,3) NOT NULL                 -- copied at order time
);

CREATE TABLE IF NOT EXISTS error_log (
  id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  shop_id          BIGINT,
  conversation_id  BIGINT,
  step             TEXT NOT NULL,
  error            TEXT NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Per-shop AI usage: feeds the daily cap AND the unit-economics numbers.
CREATE TABLE IF NOT EXISTS ai_usage (
  shop_id        BIGINT NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  day            DATE NOT NULL DEFAULT CURRENT_DATE,
  calls          INT NOT NULL DEFAULT 0,
  input_tokens   BIGINT NOT NULL DEFAULT 0,
  output_tokens  BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (shop_id, day)
);

CREATE TABLE IF NOT EXISTS schema_migrations (
  name        TEXT PRIMARY KEY,
  applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
