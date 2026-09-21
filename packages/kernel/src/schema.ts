export const CURRENT_SCHEMA_VERSION = 8;

export const schemaSql = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS principals (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('human', 'agent', 'runtime')),
  display_name TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS channels (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  name TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  principal_id TEXT NOT NULL UNIQUE REFERENCES principals(id),
  project_id TEXT NOT NULL REFERENCES projects(id),
  name TEXT NOT NULL,
  current_config_revision INTEGER NOT NULL CHECK (current_config_revision > 0)
) STRICT;

CREATE INDEX IF NOT EXISTS agents_project_name_idx
  ON agents(project_id, name, id);

CREATE TABLE IF NOT EXISTS agent_config_revisions (
  agent_id TEXT NOT NULL REFERENCES agents(id),
  revision INTEGER NOT NULL CHECK (revision > 0),
  config_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (agent_id, revision)
) STRICT;

CREATE TABLE IF NOT EXISTS threads (
  root_message_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  channel_id TEXT NOT NULL REFERENCES channels(id),
  created_event_sequence INTEGER REFERENCES public_events(sequence),
  cursor INTEGER NOT NULL DEFAULT 0 CHECK (cursor >= 0)
) STRICT;

CREATE INDEX IF NOT EXISTS threads_project_page_idx
  ON threads(project_id, created_event_sequence, root_message_id)
  WHERE created_event_sequence IS NOT NULL;

CREATE INDEX IF NOT EXISTS threads_project_channel_page_idx
  ON threads(project_id, channel_id, created_event_sequence, root_message_id)
  WHERE created_event_sequence IS NOT NULL;

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  channel_id TEXT NOT NULL REFERENCES channels(id),
  thread_root_id TEXT NOT NULL,
  reply_to_message_id TEXT,
  author_principal_id TEXT NOT NULL REFERENCES principals(id),
  author_agent_id TEXT REFERENCES agents(id),
  caused_by_attention_id TEXT REFERENCES attentions(id),
  caused_by_run_id TEXT REFERENCES runs(id),
  thread_sequence INTEGER NOT NULL CHECK (thread_sequence > 0),
  latest_revision INTEGER NOT NULL CHECK (latest_revision > 0),
  created_event_sequence INTEGER REFERENCES public_events(sequence),
  created_at TEXT NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS messages_thread_idx
  ON messages(thread_root_id, thread_sequence);

CREATE INDEX IF NOT EXISTS messages_thread_snapshot_idx
  ON messages(thread_root_id, created_event_sequence, thread_sequence);

CREATE TABLE IF NOT EXISTS message_revisions (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL REFERENCES messages(id),
  revision INTEGER NOT NULL CHECK (revision > 0),
  body TEXT NOT NULL,
  tombstone INTEGER NOT NULL DEFAULT 0 CHECK (tombstone IN (0, 1)),
  created_event_sequence INTEGER REFERENCES public_events(sequence),
  created_at TEXT NOT NULL,
  UNIQUE (message_id, revision)
) STRICT;

CREATE TABLE IF NOT EXISTS mentions (
  id TEXT PRIMARY KEY,
  message_revision_id TEXT NOT NULL REFERENCES message_revisions(id),
  target_agent_id TEXT NOT NULL REFERENCES agents(id),
  created_event_sequence INTEGER REFERENCES public_events(sequence),
  created_at TEXT NOT NULL,
  UNIQUE (message_revision_id, target_agent_id)
) STRICT;

CREATE TABLE IF NOT EXISTS attentions (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  project_id TEXT NOT NULL REFERENCES projects(id),
  channel_id TEXT NOT NULL REFERENCES channels(id),
  thread_root_id TEXT NOT NULL,
  message_revision_id TEXT NOT NULL REFERENCES message_revisions(id),
  target_agent_id TEXT NOT NULL REFERENCES agents(id),
  trigger_kind TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('Open', 'Resolved', 'Ignored')),
  revision INTEGER NOT NULL CHECK (revision > 0),
  handler_lease_holder_principal_id TEXT REFERENCES principals(id),
  handler_lease_token TEXT,
  handler_lease_expires_at TEXT,
  resolution_outcome TEXT,
  resolved_by_principal_id TEXT REFERENCES principals(id),
  resolved_activation_id TEXT REFERENCES activation_attempts(id),
  resolved_run_id TEXT REFERENCES runs(id),
  created_event_sequence INTEGER REFERENCES public_events(sequence),
  created_at TEXT NOT NULL,
  resolved_at TEXT,
  UNIQUE (message_revision_id, target_agent_id, trigger_kind)
) STRICT;

CREATE INDEX IF NOT EXISTS attentions_open_idx
  ON attentions(status, target_agent_id, created_at);

CREATE INDEX IF NOT EXISTS attentions_project_agent_status_idx
  ON attentions(project_id, target_agent_id, status, id);

CREATE INDEX IF NOT EXISTS attentions_thread_snapshot_idx
  ON attentions(thread_root_id, created_event_sequence, sequence);

CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  home_channel_id TEXT NOT NULL REFERENCES channels(id),
  thread_root_id TEXT NOT NULL,
  owner_agent_id TEXT NOT NULL REFERENCES agents(id),
  agent_config_revision INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('Active', 'Waiting', 'Completed', 'Failed', 'Cancelled')),
  revision INTEGER NOT NULL CHECK (revision > 0),
  activation_generation INTEGER NOT NULL DEFAULT 0 CHECK (activation_generation >= 0),
  next_input_sequence INTEGER NOT NULL DEFAULT 1 CHECK (next_input_sequence > 0),
  next_activity_sequence INTEGER NOT NULL DEFAULT 1 CHECK (next_activity_sequence > 0),
  created_event_sequence INTEGER REFERENCES public_events(sequence),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  terminal_reason TEXT,
  FOREIGN KEY (owner_agent_id, agent_config_revision)
    REFERENCES agent_config_revisions(agent_id, revision)
) STRICT;

CREATE INDEX IF NOT EXISTS runs_thread_idx ON runs(thread_root_id, created_at);

CREATE INDEX IF NOT EXISTS runs_project_page_idx
  ON runs(project_id, created_event_sequence, id)
  WHERE created_event_sequence IS NOT NULL;

CREATE INDEX IF NOT EXISTS runs_project_channel_page_idx
  ON runs(project_id, home_channel_id, created_event_sequence, id)
  WHERE created_event_sequence IS NOT NULL;

CREATE INDEX IF NOT EXISTS runs_project_agent_state_idx
  ON runs(project_id, owner_agent_id, state);

CREATE INDEX IF NOT EXISTS runs_project_state_agent_idx
  ON runs(project_id, state, owner_agent_id);

CREATE TABLE IF NOT EXISTS run_inputs (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id),
  message_revision_id TEXT NOT NULL REFERENCES message_revisions(id),
  run_input_sequence INTEGER NOT NULL CHECK (run_input_sequence > 0),
  assigned_by_principal_id TEXT NOT NULL REFERENCES principals(id),
  assigned_by_activation_id TEXT REFERENCES activation_attempts(id),
  source_attention_id TEXT REFERENCES attentions(id),
  created_event_sequence INTEGER REFERENCES public_events(sequence),
  created_at TEXT NOT NULL,
  disposition TEXT NOT NULL CHECK (disposition IN ('Pending', 'Incorporated', 'Declined', 'Superseded', 'Withdrawn', 'Abandoned')),
  disposition_revision INTEGER NOT NULL CHECK (disposition_revision > 0),
  disposition_reason TEXT,
  superseded_by_run_input_id TEXT REFERENCES run_inputs(id),
  UNIQUE (run_id, message_revision_id),
  UNIQUE (run_id, run_input_sequence)
) STRICT;

CREATE INDEX IF NOT EXISTS run_inputs_snapshot_idx
  ON run_inputs(run_id, created_event_sequence, run_input_sequence);

CREATE INDEX IF NOT EXISTS run_inputs_unmarked_idx
  ON run_inputs(run_id, id)
  WHERE created_event_sequence IS NULL;

CREATE TABLE IF NOT EXISTS activation_attempts (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id),
  run_id TEXT REFERENCES runs(id),
  attention_id TEXT REFERENCES attentions(id),
  attention_lease_token TEXT,
  run_activation_generation INTEGER,
  cause TEXT NOT NULL CHECK (cause IN ('Run', 'Attention')),
  config_revision INTEGER NOT NULL,
  created_event_sequence INTEGER REFERENCES public_events(sequence),
  started_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  revocation_reason TEXT,
  finished_at TEXT,
  outcome TEXT CHECK (outcome IS NULL OR outcome IN ('Completed', 'Failed', 'Cancelled', 'Expired')),
  detail TEXT,
  CHECK ((run_id IS NOT NULL) != (attention_id IS NOT NULL)),
  CHECK (
    (run_id IS NOT NULL AND run_activation_generation IS NOT NULL AND attention_lease_token IS NULL)
    OR
    (attention_id IS NOT NULL AND run_activation_generation IS NULL AND attention_lease_token IS NOT NULL)
  ),
  UNIQUE (attention_id, attention_lease_token),
  FOREIGN KEY (agent_id, config_revision)
    REFERENCES agent_config_revisions(agent_id, revision)
) STRICT;

CREATE INDEX IF NOT EXISTS activation_run_snapshot_idx
  ON activation_attempts(run_id, created_event_sequence, started_at, id);

CREATE TABLE IF NOT EXISTS activation_run_inputs (
  activation_id TEXT NOT NULL REFERENCES activation_attempts(id),
  run_input_id TEXT NOT NULL REFERENCES run_inputs(id),
  run_input_sequence INTEGER NOT NULL CHECK (run_input_sequence > 0),
  PRIMARY KEY (activation_id, run_input_id),
  UNIQUE (activation_id, run_input_sequence)
) STRICT;

CREATE TABLE IF NOT EXISTS provider_attempts (
  id TEXT PRIMARY KEY,
  activation_id TEXT NOT NULL REFERENCES activation_attempts(id),
  run_id TEXT REFERENCES runs(id),
  adapter TEXT NOT NULL,
  adapter_version TEXT NOT NULL,
  capability_snapshot_json TEXT NOT NULL,
  run_input_ids_json TEXT NOT NULL,
  request_idempotency_key TEXT NOT NULL,
  diagnostic_session_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('Started', 'Acknowledged', 'Completed', 'Failed', 'Unknown')),
  detail TEXT,
  created_event_sequence INTEGER REFERENCES public_events(sequence),
  started_at TEXT NOT NULL,
  finished_at TEXT,
  UNIQUE (activation_id, request_idempotency_key)
) STRICT;

CREATE INDEX IF NOT EXISTS provider_attempts_activation_status_idx
  ON provider_attempts(activation_id, status);

CREATE INDEX IF NOT EXISTS provider_attempts_run_snapshot_idx
  ON provider_attempts(run_id, created_event_sequence, started_at, id);

CREATE INDEX IF NOT EXISTS provider_attempts_unsettled_activation_idx
  ON provider_attempts(status, activation_id)
  WHERE status IN ('Started', 'Acknowledged');

CREATE INDEX IF NOT EXISTS activation_attention_expired_idx
  ON activation_attempts(expires_at, started_at, id)
  WHERE cause = 'Attention' AND finished_at IS NULL;

CREATE INDEX IF NOT EXISTS activation_live_run_expiry_idx
  ON activation_attempts(expires_at, run_id, agent_id, run_activation_generation)
  WHERE cause = 'Run' AND finished_at IS NULL AND revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS activation_live_run_agent_expiry_idx
  ON activation_attempts(agent_id, expires_at, run_id, run_activation_generation)
  WHERE cause = 'Run' AND finished_at IS NULL AND revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS activation_live_attention_expiry_idx
  ON activation_attempts(expires_at, attention_id, agent_id)
  WHERE cause = 'Attention' AND finished_at IS NULL AND revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS activation_live_attention_agent_expiry_idx
  ON activation_attempts(agent_id, expires_at, attention_id)
  WHERE cause = 'Attention' AND finished_at IS NULL AND revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS run_activity_events (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id),
  activation_id TEXT REFERENCES activation_attempts(id),
  provider_attempt_id TEXT REFERENCES provider_attempts(id),
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  kind TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  retention_class TEXT NOT NULL CHECK (retention_class IN ('durable', 'transient')),
  created_event_sequence INTEGER REFERENCES public_events(sequence),
  created_at TEXT NOT NULL,
  UNIQUE (run_id, sequence),
  CHECK (activation_id IS NOT NULL OR provider_attempt_id IS NOT NULL)
) STRICT;

CREATE INDEX IF NOT EXISTS run_activity_unmarked_idx
  ON run_activity_events(run_id, id)
  WHERE created_event_sequence IS NULL;

CREATE TABLE IF NOT EXISTS artifacts (
  id TEXT PRIMARY KEY,
  content_digest TEXT NOT NULL,
  producer_run_id TEXT NOT NULL REFERENCES runs(id),
  producer_activation_id TEXT NOT NULL REFERENCES activation_attempts(id),
  base_revision TEXT NOT NULL,
  media_type TEXT NOT NULL,
  storage_location TEXT NOT NULL,
  visibility_channel_id TEXT NOT NULL REFERENCES channels(id),
  metadata_json TEXT,
  created_event_sequence INTEGER REFERENCES public_events(sequence),
  created_at TEXT NOT NULL,
  UNIQUE (producer_run_id, content_digest)
) STRICT;

CREATE TABLE IF NOT EXISTS idempotency_records (
  principal_id TEXT NOT NULL REFERENCES principals(id),
  command_name TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  result_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (principal_id, command_name, idempotency_key)
) STRICT;

CREATE TABLE IF NOT EXISTS outbox_events (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  topic TEXT NOT NULL,
  aggregate_type TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  delivery_attempts INTEGER NOT NULL DEFAULT 0 CHECK (delivery_attempts >= 0),
  lease_holder_principal_id TEXT REFERENCES principals(id),
  lease_token TEXT,
  lease_expires_at TEXT,
  created_at TEXT NOT NULL,
  acknowledged_at TEXT,
  acknowledged_by_principal_id TEXT REFERENCES principals(id)
) STRICT;

CREATE INDEX IF NOT EXISTS outbox_pending_idx
  ON outbox_events(acknowledged_at, lease_expires_at, sequence);

CREATE TABLE IF NOT EXISTS public_events (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(id),
  channel_id TEXT REFERENCES channels(id),
  thread_root_id TEXT,
  thread_cursor INTEGER,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  actor_principal_id TEXT NOT NULL REFERENCES principals(id),
  activation_id TEXT REFERENCES activation_attempts(id),
  causation_id TEXT,
  correlation_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  occurred_at TEXT NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS public_events_thread_idx
  ON public_events(thread_root_id, thread_cursor);

CREATE INDEX IF NOT EXISTS public_events_project_sequence_idx
  ON public_events(project_id, sequence);

CREATE INDEX IF NOT EXISTS public_events_correlation_sequence_idx
  ON public_events(correlation_id, sequence);

CREATE INDEX IF NOT EXISTS public_events_project_correlation_sequence_idx
  ON public_events(project_id, correlation_id, sequence);

CREATE INDEX IF NOT EXISTS public_events_thread_sequence_idx
  ON public_events(thread_root_id, sequence, thread_cursor);

CREATE TABLE IF NOT EXISTS run_history (
  run_id TEXT NOT NULL REFERENCES runs(id),
  event_sequence INTEGER NOT NULL REFERENCES public_events(sequence),
  state TEXT NOT NULL CHECK (state IN ('Active', 'Waiting', 'Completed', 'Failed', 'Cancelled')),
  revision INTEGER NOT NULL CHECK (revision > 0),
  activation_generation INTEGER NOT NULL CHECK (activation_generation >= 0),
  updated_at TEXT NOT NULL,
  terminal_reason TEXT,
  PRIMARY KEY (run_id, event_sequence)
) STRICT;

CREATE INDEX IF NOT EXISTS run_history_snapshot_idx
  ON run_history(run_id, event_sequence DESC);

CREATE TABLE IF NOT EXISTS run_input_history (
  run_input_id TEXT NOT NULL REFERENCES run_inputs(id),
  event_sequence INTEGER NOT NULL REFERENCES public_events(sequence),
  disposition TEXT NOT NULL CHECK (disposition IN ('Pending', 'Incorporated', 'Declined', 'Superseded', 'Withdrawn', 'Abandoned')),
  disposition_revision INTEGER NOT NULL CHECK (disposition_revision > 0),
  disposition_reason TEXT,
  superseded_by_run_input_id TEXT REFERENCES run_inputs(id),
  PRIMARY KEY (run_input_id, event_sequence)
) STRICT;

CREATE INDEX IF NOT EXISTS run_input_history_snapshot_idx
  ON run_input_history(run_input_id, event_sequence DESC);

CREATE TABLE IF NOT EXISTS activation_history (
  activation_id TEXT NOT NULL REFERENCES activation_attempts(id),
  event_sequence INTEGER NOT NULL REFERENCES public_events(sequence),
  revoked_at TEXT,
  revocation_reason TEXT,
  finished_at TEXT,
  outcome TEXT CHECK (outcome IS NULL OR outcome IN ('Completed', 'Failed', 'Cancelled', 'Expired')),
  detail TEXT,
  PRIMARY KEY (activation_id, event_sequence)
) STRICT;

CREATE INDEX IF NOT EXISTS activation_history_snapshot_idx
  ON activation_history(activation_id, event_sequence DESC);

CREATE TABLE IF NOT EXISTS provider_attempt_history (
  provider_attempt_id TEXT NOT NULL REFERENCES provider_attempts(id),
  event_sequence INTEGER NOT NULL REFERENCES public_events(sequence),
  status TEXT NOT NULL CHECK (status IN ('Started', 'Acknowledged', 'Completed', 'Failed', 'Unknown')),
  detail TEXT,
  finished_at TEXT,
  PRIMARY KEY (provider_attempt_id, event_sequence)
) STRICT;

CREATE INDEX IF NOT EXISTS provider_attempt_history_snapshot_idx
  ON provider_attempt_history(provider_attempt_id, event_sequence DESC);

CREATE TABLE IF NOT EXISTS attention_history (
  attention_id TEXT NOT NULL REFERENCES attentions(id),
  event_sequence INTEGER NOT NULL REFERENCES public_events(sequence),
  status TEXT NOT NULL CHECK (status IN ('Open', 'Resolved', 'Ignored')),
  revision INTEGER NOT NULL CHECK (revision > 0),
  handler_lease_holder_principal_id TEXT REFERENCES principals(id),
  handler_lease_expires_at TEXT,
  resolution_outcome TEXT,
  resolved_run_id TEXT REFERENCES runs(id),
  resolved_at TEXT,
  PRIMARY KEY (attention_id, event_sequence)
) STRICT;

CREATE INDEX IF NOT EXISTS attention_history_snapshot_idx
  ON attention_history(attention_id, event_sequence);
`;
