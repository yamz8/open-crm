-- Core identity -------------------------------------------------------------

CREATE TABLE users (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'admin', 'member', 'readonly')),
  avatar_color  TEXT NOT NULL DEFAULT '#6366f1',
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  disabled_at   TEXT
);

CREATE TABLE sessions (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  user_agent TEXT,
  ip         TEXT
);
CREATE INDEX idx_sessions_user ON sessions(user_id);

-- API tokens are how agents authenticate. They are first-class citizens, not an
-- afterthought bolted onto the user table: they carry their own scopes, their own
-- rate limit, and their own audit identity.
CREATE TABLE api_tokens (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  prefix       TEXT NOT NULL,
  token_hash   TEXT NOT NULL UNIQUE,
  scopes       TEXT NOT NULL DEFAULT '["*"]',
  created_by   TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at   TEXT NOT NULL,
  last_used_at TEXT,
  expires_at   TEXT,
  revoked_at   TEXT
);
CREATE INDEX idx_api_tokens_prefix ON api_tokens(prefix);

-- CRM records ---------------------------------------------------------------

CREATE TABLE companies (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  domain      TEXT,
  industry    TEXT,
  size        TEXT,
  website     TEXT,
  phone       TEXT,
  address     TEXT,
  description TEXT,
  owner_id    TEXT REFERENCES users(id) ON DELETE SET NULL,
  properties  TEXT NOT NULL DEFAULT '{}',
  version     INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  archived_at TEXT
);
CREATE INDEX idx_companies_name ON companies(name);
CREATE UNIQUE INDEX idx_companies_domain ON companies(domain) WHERE domain IS NOT NULL AND archived_at IS NULL;
CREATE INDEX idx_companies_owner ON companies(owner_id);

CREATE TABLE contacts (
  id              TEXT PRIMARY KEY,
  first_name      TEXT NOT NULL DEFAULT '',
  last_name       TEXT NOT NULL DEFAULT '',
  email           TEXT,
  phone           TEXT,
  title           TEXT,
  company_id      TEXT REFERENCES companies(id) ON DELETE SET NULL,
  owner_id        TEXT REFERENCES users(id) ON DELETE SET NULL,
  lifecycle_stage TEXT NOT NULL DEFAULT 'lead'
                  CHECK (lifecycle_stage IN ('subscriber','lead','qualified','opportunity','customer','evangelist','churned')),
  source          TEXT,
  linkedin_url    TEXT,
  description     TEXT,
  properties      TEXT NOT NULL DEFAULT '{}',
  version         INTEGER NOT NULL DEFAULT 1,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  archived_at     TEXT
);
CREATE UNIQUE INDEX idx_contacts_email ON contacts(email) WHERE email IS NOT NULL AND archived_at IS NULL;
CREATE INDEX idx_contacts_company ON contacts(company_id);
CREATE INDEX idx_contacts_owner ON contacts(owner_id);
CREATE INDEX idx_contacts_lifecycle ON contacts(lifecycle_stage);

CREATE TABLE pipelines (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  is_default INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE stages (
  id          TEXT PRIMARY KEY,
  pipeline_id TEXT NOT NULL REFERENCES pipelines(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  position    INTEGER NOT NULL,
  probability INTEGER NOT NULL DEFAULT 0 CHECK (probability BETWEEN 0 AND 100),
  outcome     TEXT NOT NULL DEFAULT 'open' CHECK (outcome IN ('open', 'won', 'lost')),
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE INDEX idx_stages_pipeline ON stages(pipeline_id, position);

CREATE TABLE deals (
  id          TEXT PRIMARY KEY,
  title       TEXT NOT NULL,
  company_id  TEXT REFERENCES companies(id) ON DELETE SET NULL,
  contact_id  TEXT REFERENCES contacts(id) ON DELETE SET NULL,
  pipeline_id TEXT NOT NULL REFERENCES pipelines(id) ON DELETE RESTRICT,
  stage_id    TEXT NOT NULL REFERENCES stages(id) ON DELETE RESTRICT,
  amount      INTEGER NOT NULL DEFAULT 0, -- minor units (cents)
  currency    TEXT NOT NULL DEFAULT 'USD',
  status      TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'won', 'lost')),
  close_date  TEXT,
  closed_at   TEXT,
  lost_reason TEXT,
  owner_id    TEXT REFERENCES users(id) ON DELETE SET NULL,
  description TEXT,
  properties  TEXT NOT NULL DEFAULT '{}',
  version     INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  archived_at TEXT
);
CREATE INDEX idx_deals_stage ON deals(stage_id);
CREATE INDEX idx_deals_pipeline ON deals(pipeline_id, status);
CREATE INDEX idx_deals_company ON deals(company_id);
CREATE INDEX idx_deals_contact ON deals(contact_id);
CREATE INDEX idx_deals_owner ON deals(owner_id);

-- Timeline ------------------------------------------------------------------

CREATE TABLE activities (
  id           TEXT PRIMARY KEY,
  type         TEXT NOT NULL CHECK (type IN ('note','call','email','meeting','stage_change','system')),
  subject      TEXT,
  body         TEXT,
  direction    TEXT CHECK (direction IN ('inbound', 'outbound')),
  duration_min INTEGER,
  occurred_at  TEXT NOT NULL,
  contact_id   TEXT REFERENCES contacts(id) ON DELETE CASCADE,
  company_id   TEXT REFERENCES companies(id) ON DELETE CASCADE,
  deal_id      TEXT REFERENCES deals(id) ON DELETE CASCADE,
  actor_type   TEXT NOT NULL DEFAULT 'system' CHECK (actor_type IN ('user', 'agent', 'system')),
  actor_id     TEXT,
  actor_label  TEXT NOT NULL DEFAULT 'system',
  properties   TEXT NOT NULL DEFAULT '{}',
  version      INTEGER NOT NULL DEFAULT 1,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  archived_at  TEXT
);
CREATE INDEX idx_activities_contact ON activities(contact_id, occurred_at DESC);
CREATE INDEX idx_activities_company ON activities(company_id, occurred_at DESC);
CREATE INDEX idx_activities_deal ON activities(deal_id, occurred_at DESC);
CREATE INDEX idx_activities_occurred ON activities(occurred_at DESC);

CREATE TABLE tasks (
  id           TEXT PRIMARY KEY,
  title        TEXT NOT NULL,
  description  TEXT,
  status       TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done', 'cancelled')),
  priority     TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
  due_at       TEXT,
  completed_at TEXT,
  assignee_id  TEXT REFERENCES users(id) ON DELETE SET NULL,
  contact_id   TEXT REFERENCES contacts(id) ON DELETE CASCADE,
  company_id   TEXT REFERENCES companies(id) ON DELETE CASCADE,
  deal_id      TEXT REFERENCES deals(id) ON DELETE CASCADE,
  properties   TEXT NOT NULL DEFAULT '{}',
  version      INTEGER NOT NULL DEFAULT 1,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  archived_at  TEXT
);
CREATE INDEX idx_tasks_status_due ON tasks(status, due_at);
CREATE INDEX idx_tasks_assignee ON tasks(assignee_id, status);

-- Tags ----------------------------------------------------------------------

CREATE TABLE tags (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL UNIQUE,
  color      TEXT NOT NULL DEFAULT '#64748b',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE taggings (
  tag_id      TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  entity_type TEXT NOT NULL,
  entity_id   TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  PRIMARY KEY (tag_id, entity_type, entity_id)
);
CREATE INDEX idx_taggings_entity ON taggings(entity_type, entity_id);

-- Governance ----------------------------------------------------------------

-- Every mutation lands here, with the full before/after document. This is what
-- makes handing write access to an autonomous agent a reversible decision.
CREATE TABLE audit_log (
  id              TEXT PRIMARY KEY,
  at              TEXT NOT NULL,
  actor_type      TEXT NOT NULL CHECK (actor_type IN ('user', 'agent', 'system')),
  actor_id        TEXT,
  actor_label     TEXT NOT NULL,
  action          TEXT NOT NULL CHECK (action IN ('create', 'update', 'archive', 'restore', 'delete')),
  entity_type     TEXT NOT NULL,
  entity_id       TEXT NOT NULL,
  before          TEXT,
  after           TEXT,
  source          TEXT NOT NULL DEFAULT 'api',
  request_id      TEXT,
  idempotency_key TEXT,
  reverted_by     TEXT,
  reverts         TEXT
);
CREATE INDEX idx_audit_entity ON audit_log(entity_type, entity_id, at DESC);
CREATE INDEX idx_audit_at ON audit_log(at DESC);
CREATE INDEX idx_audit_actor ON audit_log(actor_type, actor_id, at DESC);

CREATE TABLE idempotency_keys (
  key          TEXT NOT NULL,
  actor_key    TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  status_code  INTEGER NOT NULL,
  response     TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  PRIMARY KEY (key, actor_key)
);

CREATE TABLE webhooks (
  id          TEXT PRIMARY KEY,
  url         TEXT NOT NULL,
  secret      TEXT NOT NULL,
  events      TEXT NOT NULL DEFAULT '["*"]',
  active      INTEGER NOT NULL DEFAULT 1,
  description TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE webhook_deliveries (
  id           TEXT PRIMARY KEY,
  webhook_id   TEXT NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
  event        TEXT NOT NULL,
  payload      TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','delivered','failed')),
  attempts     INTEGER NOT NULL DEFAULT 0,
  status_code  INTEGER,
  last_error   TEXT,
  created_at   TEXT NOT NULL,
  delivered_at TEXT
);
CREATE INDEX idx_deliveries_webhook ON webhook_deliveries(webhook_id, created_at DESC);

CREATE TABLE saved_views (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  query       TEXT NOT NULL DEFAULT '{}',
  owner_id    TEXT REFERENCES users(id) ON DELETE CASCADE,
  shared      INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Full-text search ----------------------------------------------------------

CREATE VIRTUAL TABLE search_index USING fts5(
  entity_type UNINDEXED,
  entity_id   UNINDEXED,
  title,
  body,
  tokenize = 'unicode61 remove_diacritics 2'
);
