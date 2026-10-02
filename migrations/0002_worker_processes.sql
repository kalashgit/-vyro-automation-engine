CREATE TABLE worker_processes (
  process_instance_id uuid PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('worker', 'watchdog')),
  worker_id text NOT NULL CHECK (worker_id = btrim(worker_id) AND length(worker_id) BETWEEN 1 AND 200),
  hostname text NOT NULL CHECK (hostname = btrim(hostname) AND length(hostname) BETWEEN 1 AND 255),
  process_id integer NOT NULL CHECK (process_id > 0),
  started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  heartbeat_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  stopped_at timestamptz,
  CHECK (stopped_at IS NULL OR stopped_at >= started_at)
);
CREATE INDEX worker_processes_liveness ON worker_processes(kind, heartbeat_at DESC) WHERE stopped_at IS NULL;