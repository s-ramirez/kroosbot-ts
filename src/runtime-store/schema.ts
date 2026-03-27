export const RUNTIME_STORE_SCHEMA = `
create table if not exists agents (
  id text primary key,
  name text not null,
  brain_mode text not null,
  model text not null,
  base_url text,
  api_key text,
  temperature real not null,
  max_output_tokens integer not null,
  request_timeout_ms integer not null,
  system_prompt text,
  created_at text not null,
  updated_at text not null
);

create table if not exists agent_allowed_tools (
  agent_id text not null,
  tool_name text not null,
  primary key (agent_id, tool_name),
  foreign key (agent_id) references agents(id) on delete cascade
);

create table if not exists agent_skills (
  agent_id text not null,
  skill_name text not null,
  primary key (agent_id, skill_name),
  foreign key (agent_id) references agents(id) on delete cascade
);

create table if not exists agent_bindings (
  id text primary key,
  agent_id text not null,
  adapter text not null,
  channel_id text,
  sender_id text,
  priority integer not null default 0,
  created_at text not null,
  foreign key (agent_id) references agents(id) on delete cascade
);

create table if not exists sessions (
  id text primary key,
  session_key text not null unique,
  agent_id text not null,
  adapter text not null,
  account_id text,
  chat_kind text not null,
  conversation_id text not null,
  thread_id text,
  conversation_label text,
  sender_id text,
  sender_name text,
  status text not null,
  created_at text not null,
  updated_at text not null,
  last_message_at text
);

create table if not exists session_routes (
  session_id text primary key,
  delivery_adapter text not null,
  delivery_address text not null,
  delivery_thread_id text,
  updated_at text not null,
  foreign key (session_id) references sessions(id) on delete cascade
);

create table if not exists messages (
  id text primary key,
  session_id text not null,
  role text not null,
  adapter text,
  external_message_id text,
  sender_id text,
  sender_name text,
  content text not null,
  created_at text not null,
  foreign key (session_id) references sessions(id) on delete cascade
);

create table if not exists approvals (
  id text primary key,
  session_id text not null,
  tool_name text not null,
  arguments_json text not null,
  status text not null,
  requested_at text not null,
  resolved_at text,
  foreign key (session_id) references sessions(id) on delete cascade
);

create table if not exists plans (
  session_id text primary key,
  title text,
  summary text,
  blocked_on_user integer not null default 0,
  blocked_reason text,
  review_instructions text,
  workspace_dir text,
  provider text,
  model text,
  updated_at text not null,
  foreign key (session_id) references sessions(id) on delete cascade
);

create table if not exists plan_checklist_items (
  id text primary key,
  session_id text not null,
  kind text not null,
  position integer not null,
  content text not null,
  foreign key (session_id) references plans(session_id) on delete cascade
);

create table if not exists scheduled_tasks (
  id text primary key,
  kind text not null,
  agent_id text,
  session_target text not null,
  schedule_type text not null,
  run_at text,
  interval_ms integer,
  cron_expr text,
  prompt text not null,
  delivery_adapter text,
  delivery_address text,
  status text not null,
  is_internal integer not null default 0,
  created_at text not null,
  updated_at text not null,
  next_run_at text
);

create table if not exists task_runs (
  id text primary key,
  task_id text not null,
  status text not null,
  result_text text,
  started_at text,
  finished_at text,
  foreign key (task_id) references scheduled_tasks(id) on delete cascade
);

create table if not exists job_records (
  id text primary key,
  planner_session_id text,
  agent_id text,
  title text not null,
  status text not null,
  workspace_dir text not null,
  worktree_dir text not null,
  base_branch text not null,
  job_branch text not null,
  base_commit text not null,
  provider text not null,
  model text not null,
  base_url text,
  runtime_command text not null,
  runtime_args_json text not null,
  pid integer,
  result_summary text,
  blocker_question text,
  review_decision text,
  review_summary text,
  review_applied integer,
  review_iteration_count integer not null default 0,
  created_at text not null,
  updated_at text not null,
  last_heartbeat_at text
);

create table if not exists job_check_results (
  id text primary key,
  job_id text not null,
  position integer not null,
  command text not null,
  exit_code integer not null,
  ok integer not null,
  started_at text not null,
  finished_at text not null,
  output text not null,
  foreign key (job_id) references job_records(id) on delete cascade
);

create index if not exists sessions_session_key_idx on sessions(session_key);
create index if not exists sessions_agent_updated_idx on sessions(agent_id, updated_at);
create index if not exists messages_session_created_idx on messages(session_id, created_at);
create index if not exists messages_external_message_id_idx on messages(external_message_id);
create index if not exists approvals_session_status_idx on approvals(session_id, status);
create index if not exists scheduled_tasks_status_next_run_idx on scheduled_tasks(status, next_run_at);
create index if not exists job_records_status_updated_idx on job_records(status, updated_at);
`;
