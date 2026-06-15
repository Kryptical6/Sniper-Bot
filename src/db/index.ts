// ─────────────────────────────────────────────────────────────────────────────
// DATABASE — connection pool & schema
// ─────────────────────────────────────────────────────────────────────────────
import { Pool, QueryResult } from 'pg';
import { config } from '../config';
import { log } from '../utils/logger';

export const pool = new Pool({
  connectionString: config.databaseUrl,
  ssl: { rejectUnauthorized: false },
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

pool.on('error', err => log.error('DB', `Pool error: ${err.message}`));

export async function query(text: string, params?: unknown[]): Promise<QueryResult> {
  const client = await pool.connect();
  try {
    return await client.query(text, params);
  } finally {
    client.release();
  }
}

export async function initDb(): Promise<void> {
  log.info('DB', 'Initialising schema...');

  // Single-row configuration table. id is pinned to 1.
  await query(`
    CREATE TABLE IF NOT EXISTS sniper_config (
      id                        INT PRIMARY KEY DEFAULT 1,
      enabled                   BOOLEAN     NOT NULL DEFAULT FALSE,
      paused                    BOOLEAN     NOT NULL DEFAULT FALSE,
      daily_cap_robux           INT         NOT NULL DEFAULT 1000,
      item_cap_robux            INT,
      threshold_percent         INT         NOT NULL DEFAULT 30,
      floor_robux               INT,
      confirm_timeout_seconds   INT,
      feed_channel_id           TEXT,
      feed_include_events       BOOLEAN     NOT NULL DEFAULT TRUE,
      feed_include_ugc          BOOLEAN     NOT NULL DEFAULT TRUE,
      poll_interval_seconds     INT         NOT NULL DEFAULT 15,
      recommend_alert_threshold INT         NOT NULL DEFAULT 70,
      updated_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT sniper_config_singleton CHECK (id = 1)
    )`);
  await query(`INSERT INTO sniper_config (id) VALUES (1) ON CONFLICT (id) DO NOTHING`);

  // One row per UTC day recording the owner's go/no-go decision.
  await query(`
    CREATE TABLE IF NOT EXISTS daily_approvals (
      approval_date DATE PRIMARY KEY,
      status        TEXT        NOT NULL DEFAULT 'pending', -- pending|approved|paused
      requested_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      decided_at    TIMESTAMPTZ,
      dm_message_id TEXT,
      spent_robux   INT         NOT NULL DEFAULT 0
    )`);

  // Priority watchlist of specific limited item ids.
  await query(`
    CREATE TABLE IF NOT EXISTS watchlist (
      item_id   BIGINT PRIMARY KEY,
      name      TEXT        NOT NULL DEFAULT '',
      active    BOOLEAN     NOT NULL DEFAULT TRUE,
      added_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);

  // Every snipe consideration, regardless of outcome.
  await query(`
    CREATE TABLE IF NOT EXISTS snipe_attempts (
      id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      item_id          BIGINT      NOT NULL,
      item_name        TEXT        NOT NULL DEFAULT '',
      user_asset_id    BIGINT,
      listed_price     INT         NOT NULL,
      rap_at_time      INT,
      projected_at_time INT,
      discount_percent NUMERIC(5,2),
      score            NUMERIC(6,2),
      outcome          TEXT        NOT NULL, -- detected|prompted|bought|skipped|missed|failed|capped
      reason           TEXT,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
  await query(`CREATE INDEX IF NOT EXISTS idx_snipe_attempts_item ON snipe_attempts(item_id, created_at DESC)`);
  await query(`CREATE INDEX IF NOT EXISTS idx_snipe_attempts_outcome ON snipe_attempts(outcome, created_at DESC)`);

  // Confirmed purchases (links back to the originating attempt).
  await query(`
    CREATE TABLE IF NOT EXISTS purchase_history (
      id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      attempt_id    UUID REFERENCES snipe_attempts(id),
      item_id       BIGINT      NOT NULL,
      item_name     TEXT        NOT NULL DEFAULT '',
      robux_spent   INT         NOT NULL,
      rap_at_time   INT,
      user_asset_id BIGINT,
      confirmed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
  await query(`CREATE INDEX IF NOT EXISTS idx_purchase_history_confirmed ON purchase_history(confirmed_at DESC)`);

  // Dedup guard for the new-limiteds feed.
  await query(`
    CREATE TABLE IF NOT EXISTS feed_posts (
      item_id            BIGINT PRIMARY KEY,
      name               TEXT        NOT NULL DEFAULT '',
      discord_message_id TEXT,
      posted_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);

  // Recommendation snapshots so we can throttle repeat alerts.
  await query(`
    CREATE TABLE IF NOT EXISTS recommendations (
      id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      item_id    BIGINT      NOT NULL,
      name       TEXT        NOT NULL DEFAULT '',
      score      NUMERIC(6,2) NOT NULL,
      reasons    JSONB       NOT NULL DEFAULT '{}',
      alerted    BOOLEAN     NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
  await query(`CREATE INDEX IF NOT EXISTS idx_recommendations_item ON recommendations(item_id, created_at DESC)`);

  log.info('DB', 'Schema ready.');
}
