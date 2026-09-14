import { transaction, type Database } from './connection.js';

const schema = `
CREATE TABLE IF NOT EXISTS users (
  id integer PRIMARY KEY CHECK (id = 1),
  initial_milli integer NOT NULL CHECK (initial_milli >= 0),
  available_milli integer NOT NULL CHECK (available_milli >= 0),
  held_milli integer NOT NULL DEFAULT 0 CHECK (held_milli >= 0)
);
CREATE TABLE IF NOT EXISTS models (
  id text PRIMARY KEY,
  name text NOT NULL,
  rate_milli integer NOT NULL CHECK (rate_milli > 0)
);
CREATE TABLE IF NOT EXISTS jobs (
  id uuid PRIMARY KEY,
  user_id integer NOT NULL REFERENCES users(id),
  model_id text NOT NULL REFERENCES models(id),
  mode text NOT NULL CHECK (mode IN ('mock','apimart')),
  idempotency_key text NOT NULL,
  fingerprint text NOT NULL,
  prompt text NOT NULL,
  requested_duration integer NOT NULL CHECK (requested_duration IN (4,5)),
  resolution text NOT NULL CHECK (resolution = '480p'),
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','submitting','submission_unknown','pending','processing','downloading','completed','failed','timed_out')),
  financial_status text NOT NULL DEFAULT 'held' CHECK (financial_status IN ('held','settled','released')),
  rate_milli integer NOT NULL CHECK (rate_milli > 0),
  estimate_milli integer NOT NULL CHECK (estimate_milli > 0),
  hold_milli integer NOT NULL CHECK (hold_milli > 0),
  actual_duration_us bigint,
  actual_cost_milli integer,
  charged_milli integer NOT NULL DEFAULT 0 CHECK (charged_milli >= 0),
  released_milli integer NOT NULL DEFAULT 0 CHECK (released_milli >= 0),
  absorbed_milli integer NOT NULL DEFAULT 0 CHECK (absorbed_milli >= 0),
  provider_task_id text,
  provider_cost_usd numeric(24,10),
  provider_credits_cost numeric(24,10),
  progress integer CHECK (progress BETWEEN 0 AND 100),
  result_file text,
  error_code text,
  error_message text,
  poll_attempt integer NOT NULL DEFAULT 0,
  download_attempt integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  retry_not_before timestamptz,
  last_webhook_at timestamptz,
  lease_token uuid,
  lease_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  deadline_at timestamptz NOT NULL,
  UNIQUE(user_id, idempotency_key),
  UNIQUE(mode, provider_task_id),
  CHECK (
    (financial_status = 'held' AND charged_milli = 0 AND released_milli = 0 AND absorbed_milli = 0 AND actual_cost_milli IS NULL AND status NOT IN ('completed','failed','timed_out'))
    OR (financial_status = 'settled' AND status = 'completed' AND result_file IS NOT NULL AND actual_duration_us IS NOT NULL AND actual_duration_us > 0
      AND actual_cost_milli IS NOT NULL AND actual_cost_milli > 0 AND charged_milli = LEAST(actual_cost_milli,hold_milli)
      AND released_milli = hold_milli - charged_milli AND absorbed_milli = actual_cost_milli - charged_milli)
    OR (financial_status = 'released' AND status IN ('failed','timed_out') AND charged_milli = 0 AND released_milli = hold_milli AND absorbed_milli = 0)
  )
);
CREATE INDEX IF NOT EXISTS jobs_due ON jobs(next_attempt_at) WHERE financial_status = 'held';
CREATE TABLE IF NOT EXISTS ledger (
  id bigserial PRIMARY KEY,
  user_id integer NOT NULL REFERENCES users(id),
  job_id uuid NOT NULL REFERENCES jobs(id),
  kind text NOT NULL CHECK (kind IN ('hold','settle','release')),
  amount_milli integer NOT NULL CHECK (amount_milli > 0),
  available_delta_milli integer NOT NULL,
  held_delta_milli integer NOT NULL,
  available_after_milli integer NOT NULL CHECK (available_after_milli >= 0),
  held_after_milli integer NOT NULL CHECK (held_after_milli >= 0),
  note text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(job_id,kind),
  CHECK (
    (kind='hold' AND available_delta_milli=-amount_milli AND held_delta_milli=amount_milli)
    OR (kind='settle' AND available_delta_milli=0 AND held_delta_milli=-amount_milli)
    OR (kind='release' AND available_delta_milli=amount_milli AND held_delta_milli=-amount_milli)
  )
);
CREATE TABLE IF NOT EXISTS mock_provider_tasks (
  id text PRIMARY KEY, duration integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), ready_at timestamptz NOT NULL
);
`;

export async function migrate(
  pool: Database,
  initialMilli = 100000,
  rateMilli = 2850,
): Promise<void> {
  await transaction(pool, async (tx) => {
    await tx.query('SELECT pg_advisory_xact_lock(7240914)');
    await tx.query(schema);
    await tx.query(
      'INSERT INTO users(id,initial_milli,available_milli) VALUES(1,$1,$1) ON CONFLICT DO NOTHING',
      [initialMilli],
    );
    await tx.query(`CREATE TABLE IF NOT EXISTS schema_migrations (version integer PRIMARY KEY)`);
    if (!(await tx.query('SELECT 1 FROM schema_migrations WHERE version=2')).rowCount) {
      await tx.query(`
        ALTER TABLE jobs DROP CONSTRAINT jobs_requested_duration_check;
        ALTER TABLE jobs ADD CONSTRAINT jobs_requested_duration_check CHECK (requested_duration=-1 OR requested_duration BETWEEN 4 AND 30);
        ALTER TABLE jobs DROP CONSTRAINT jobs_resolution_check;
        ALTER TABLE jobs ADD CONSTRAINT jobs_resolution_check CHECK (resolution IN ('480p','720p','1080p'));
        ALTER TABLE jobs ADD COLUMN provider_input jsonb;
        ALTER TABLE jobs ADD COLUMN input_duration_us bigint NOT NULL DEFAULT 0 CHECK(input_duration_us BETWEEN 0 AND 30000000);
        ALTER TABLE models ADD COLUMN rate_720_milli integer;
        ALTER TABLE models ADD COLUMN rate_1080_milli integer;
        UPDATE models SET rate_720_milli=rate_milli*2,rate_1080_milli=rate_milli*4;
        ALTER TABLE models ALTER COLUMN rate_720_milli SET NOT NULL;
        ALTER TABLE models ALTER COLUMN rate_1080_milli SET NOT NULL;
        ALTER TABLE models ADD CHECK(rate_720_milli>0 AND rate_1080_milli>0);
        CREATE TABLE assets (
          id uuid PRIMARY KEY, scope text NOT NULL, hash text NOT NULL, name text NOT NULL,
          kind text NOT NULL CHECK(kind IN ('image','video','audio')), file_name text NOT NULL,
          mime text NOT NULL, bytes integer NOT NULL, width integer, height integer,
          duration_us bigint NOT NULL DEFAULT 0, source_url text,
          status text NOT NULL CHECK(status IN ('local','processing','ready','failed')),
          provider_url text, provider_task_id text, error_message text, moderation_started_at timestamptz,
          public_token text NOT NULL, public_until timestamptz, lease_until timestamptz,
          next_attempt_at timestamptz NOT NULL DEFAULT now(), created_at timestamptz NOT NULL DEFAULT now(),
          UNIQUE(scope,hash)
        );
        INSERT INTO schema_migrations VALUES(2);
      `);
    }
    if (!(await tx.query('SELECT 1 FROM schema_migrations WHERE version=3')).rowCount) {
      await tx.query(`
        ALTER TABLE jobs DROP CONSTRAINT jobs_mode_check;
        ALTER TABLE jobs ADD CONSTRAINT jobs_mode_check CHECK (mode ~ '^[a-z][a-z0-9_-]{0,63}$');
        INSERT INTO schema_migrations VALUES(3);
      `);
    }
    await tx.query(
      "INSERT INTO models(id,name,rate_milli,rate_720_milli,rate_1080_milli) VALUES('seedance-2.5','Seedance 2.5',$1,$2,$3) ON CONFLICT DO NOTHING",
      [rateMilli, rateMilli * 2, rateMilli * 4],
    );
  });
}
