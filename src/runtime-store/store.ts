import { Database, type SQLQueryBindings } from "bun:sqlite";
import type { SubagentDefinition } from "../agents/types.js";
import type { AppConfig } from "../config.js";
import type { JobCheckResult, JobRecord, JobReviewOutcome } from "../jobs/types.js";
import type { SessionPlan, PlanUpdateInput } from "../plans/manager.js";
import type { ScheduledTaskRecord } from "../scheduler/types.js";
import {
  ChatHistory,
  ChatTurn,
  DeliveryTarget,
  InboundMessage,
  SessionKey,
  SessionSummary,
  SessionSnapshot
} from "../store.js";
import type { PendingToolApproval } from "../tools/types.js";
import { openRuntimeDatabase } from "./db.js";

type SqlRecord = Record<string, SQLQueryBindings>;
type PlanChecklistKind =
  | "checklist"
  | "acceptance"
  | "manual_step"
  | "allowed_scope"
  | "out_of_scope"
  | "check_command";
export class RuntimeStore {
  private readonly db: Database;
  private readonly historyLimit: number;

  constructor(config: AppConfig["runtimeStore"], historyLimit: number) {
    this.db = openRuntimeDatabase(config.dbPath);
    this.historyLimit = historyLimit;
  }

  initialize(): void {
    // schema bootstrap happens on open
  }

  close(): void {
    this.db.close();
  }

  hasInboundMessage(adapter: string, externalMessageId: string): boolean {
    const row = this.db
      .prepare<{ adapter: string; externalMessageId: string }>(
        `select 1 as exists_flag
         from messages
         where adapter = $adapter and external_message_id = $externalMessageId
         limit 1`
      )
      .get<{ exists_flag: number }>({ adapter, externalMessageId });
    return Boolean(row);
  }

  appendInboundMessage(message: InboundMessage): void {
    this.inTransaction(() => {
      const sessionId = this.upsertSessionFromInbound(message);
      this.insertMessage({
        id: crypto.randomUUID(),
        sessionId,
        role: "user",
        adapter: message.adapter,
        externalMessageId: message.messageId,
        senderId: message.senderId,
        senderName: message.senderName ?? null,
        content: message.text.trim(),
        createdAt: toIso(message.timestampMs)
      });
    });
  }

  appendAssistantMessage(sessionKey: SessionKey, text: string): void {
    this.inTransaction(() => {
      const session = this.requireSession(sessionKey.toString());
      const now = new Date().toISOString();
      this.db
        .prepare<{ updatedAt: string; sessionId: string }>(
          `update sessions
           set updated_at = $updatedAt, last_message_at = $updatedAt
           where id = $sessionId`
        )
        .run({ updatedAt: now, sessionId: session.id });
      this.insertMessage({
        id: crypto.randomUUID(),
        sessionId: session.id,
        role: "assistant",
        adapter: null,
        externalMessageId: null,
        senderId: null,
        senderName: null,
        content: text,
        createdAt: now
      });
    });
  }

  historyForSession(sessionKey: SessionKey, limit = this.historyLimit): ChatHistory {
    const session = this.findSession(sessionKey.toString());
    if (!session) return { turns: [] };
    const rows = this.db
      .prepare<{ sessionId: string; limit: number }>(
        `select role, content
         from messages
         where session_id = $sessionId
         order by created_at desc
         limit $limit`
      )
      .all<{ role: ChatTurn["role"]; content: string }>({ sessionId: session.id, limit });
    return {
      turns: rows
        .slice()
        .reverse()
        .map((row) => ({ role: row.role, text: row.content }))
    };
  }

  historyForSessionKey(sessionKey: string, limit = this.historyLimit): ChatHistory {
    return this.historyForSession(new SessionKey(sessionKey), limit);
  }

  listSessions(limit = 50): SessionSummary[] {
    return this.db
      .prepare<{ limit: number }>(
        `select s.id, s.session_key, s.adapter, s.chat_kind, s.conversation_id, s.thread_id,
                s.conversation_label, s.sender_id, s.sender_name, s.status, s.created_at, s.updated_at,
                s.last_message_at, r.delivery_adapter, r.delivery_address, r.delivery_thread_id
         from sessions s
         left join session_routes r on r.session_id = s.id
         order by coalesce(s.last_message_at, s.updated_at, s.created_at) desc
         limit $limit`
      )
      .all<SessionRow>({ limit })
      .map((row) => this.rowToSessionSummary(row));
  }

  sessionFor(sessionKey: string): SessionSnapshot | null {
    const session = this.findSession(sessionKey);
    if (!session) return null;
    const turns = this.historyForSession(new SessionKey(session.session_key), this.historyLimit).turns;
    return {
      key: new SessionKey(session.session_key),
      origin: {
        adapter: session.adapter as SessionSnapshot["origin"]["adapter"],
        chatKind: session.chat_kind as SessionSnapshot["origin"]["chatKind"],
        conversationLabel: session.conversation_label ?? undefined,
        senderId: session.sender_id ?? "",
        senderName: session.sender_name ?? undefined,
        conversationId: session.conversation_id,
        threadId: session.thread_id ?? undefined
      },
      lastDelivery: this.sessionDeliveryTarget(session),
      history: { turns }
    };
  }

  saveAgent(def: SubagentDefinition): void {
    this.inTransaction(() => {
      const now = new Date().toISOString();
      this.db
        .prepare<SqlRecord>(
          `insert into agents (
             id, name, brain_mode, model, base_url, api_key, temperature,
             max_output_tokens, request_timeout_ms, system_prompt, created_at, updated_at
           ) values (
             $id, $name, $brainMode, $model, $baseUrl, $apiKey, $temperature,
             $maxOutputTokens, $requestTimeoutMs, $systemPrompt, $createdAt, $updatedAt
           )
           on conflict(id) do update set
             name = excluded.name,
             brain_mode = excluded.brain_mode,
             model = excluded.model,
             base_url = excluded.base_url,
             api_key = excluded.api_key,
             temperature = excluded.temperature,
             max_output_tokens = excluded.max_output_tokens,
             request_timeout_ms = excluded.request_timeout_ms,
             system_prompt = excluded.system_prompt,
             updated_at = excluded.updated_at`
        )
        .run({
          id: def.id,
          name: def.name,
          brainMode: def.brainMode,
          model: def.model,
          baseUrl: def.baseUrl ?? null,
          apiKey: def.apiKey ?? null,
          temperature: def.temperature,
          maxOutputTokens: def.maxOutputTokens,
          requestTimeoutMs: def.requestTimeoutMs,
          systemPrompt: def.systemPrompt ?? null,
          createdAt: def.createdAt,
          updatedAt: now
        });
      this.db.prepare(`delete from agent_allowed_tools where agent_id = ?`).run(def.id);
      this.db.prepare(`delete from agent_skills where agent_id = ?`).run(def.id);
      const toolStmt = this.db.prepare<{ agentId: string; toolName: string }>(
        `insert into agent_allowed_tools (agent_id, tool_name) values ($agentId, $toolName)`
      );
      for (const toolName of def.allowedTools) {
        toolStmt.run({ agentId: def.id, toolName });
      }
      const skillStmt = this.db.prepare<{ agentId: string; skillName: string }>(
        `insert into agent_skills (agent_id, skill_name) values ($agentId, $skillName)`
      );
      for (const skillName of def.skills) {
        skillStmt.run({ agentId: def.id, skillName });
      }
    });
  }

  listAgents(): SubagentDefinition[] {
    const rows = this.db
      .prepare(
        `select id, name, brain_mode, model, base_url, api_key, temperature,
                max_output_tokens, request_timeout_ms, system_prompt, created_at
         from agents
         order by created_at asc`
      )
      .all<{
        id: string;
        name: string;
        brain_mode: SubagentDefinition["brainMode"];
        model: string;
        base_url: string | null;
        api_key: string | null;
        temperature: number;
        max_output_tokens: number;
        request_timeout_ms: number;
        system_prompt: string | null;
        created_at: string;
      }>();
    return rows.map((row) => this.rowToAgent(row));
  }

  getAgent(id: string): SubagentDefinition | null {
    const row = this.db
      .prepare<{ id: string }>(
        `select id, name, brain_mode, model, base_url, api_key, temperature,
                max_output_tokens, request_timeout_ms, system_prompt, created_at
         from agents
         where id = $id`
      )
      .get<{
        id: string;
        name: string;
        brain_mode: SubagentDefinition["brainMode"];
        model: string;
        base_url: string | null;
        api_key: string | null;
        temperature: number;
        max_output_tokens: number;
        request_timeout_ms: number;
        system_prompt: string | null;
        created_at: string;
      }>({ id });
    return row ? this.rowToAgent(row) : null;
  }

  deleteAgent(id: string): void {
    this.db.prepare(`delete from agents where id = ?`).run(id);
  }

  getPlan(sessionKey: string): SessionPlan | null {
    const session = this.findSession(sessionKey);
    if (!session) return null;
    const row = this.db
      .prepare<{ sessionId: string }>(
        `select title, summary, blocked_on_user, blocked_reason, review_instructions,
                workspace_dir, provider, model, updated_at
         from plans where session_id = $sessionId`
      )
      .get<{
        title: string | null;
        summary: string | null;
        blocked_on_user: number;
        blocked_reason: string | null;
        review_instructions: string | null;
        workspace_dir: string | null;
        provider: string | null;
        model: string | null;
        updated_at: string;
      }>({ sessionId: session.id });
    if (!row) return null;
    const items = this.db
      .prepare<{ sessionId: string }>(
        `select kind, content
         from plan_checklist_items
         where session_id = $sessionId
         order by kind asc, position asc`
      )
      .all<{ kind: PlanChecklistKind; content: string }>({ sessionId: session.id });
    const byKind = groupPlanItems(items);
    return {
      title: row.title ?? undefined,
      summary: row.summary ?? undefined,
      checklist: byKind.checklist,
      acceptanceCriteria: byKind.acceptance,
      manualSteps: byKind.manual_step,
      blockedOnUser: row.blocked_on_user === 1,
      blockedReason: row.blocked_reason ?? undefined,
      allowedScope: byKind.allowed_scope,
      outOfScope: byKind.out_of_scope,
      checkCommands: byKind.check_command,
      reviewInstructions: row.review_instructions ?? undefined,
      workspaceDir: row.workspace_dir ?? undefined,
      provider: row.provider ?? undefined,
      model: row.model ?? undefined,
      updatedAt: row.updated_at
    };
  }

  updatePlan(sessionKey: string, input: PlanUpdateInput): SessionPlan {
    const sessionId = this.ensureEphemeralSession(sessionKey);
    const existing = this.getPlan(sessionKey) ?? createEmptyPlan();
    const mergeStrategy = input.mergeStrategy ?? "replace";
    const next: SessionPlan = {
      ...existing,
      updatedAt: new Date().toISOString()
    };

    if (input.title !== undefined) next.title = input.title;
    if (input.summary !== undefined) next.summary = input.summary;
    if (input.reviewInstructions !== undefined) next.reviewInstructions = input.reviewInstructions;
    if (input.workspaceDir !== undefined) next.workspaceDir = input.workspaceDir;
    if (input.provider !== undefined) next.provider = input.provider;
    if (input.model !== undefined) next.model = input.model;
    if (input.blockedOnUser !== undefined) next.blockedOnUser = input.blockedOnUser;
    if (input.blockedReason !== undefined) next.blockedReason = input.blockedReason;
    if (input.checklist !== undefined) next.checklist = mergeList(existing.checklist, input.checklist, mergeStrategy);
    if (input.acceptanceCriteria !== undefined) next.acceptanceCriteria = mergeList(existing.acceptanceCriteria, input.acceptanceCriteria, mergeStrategy);
    if (input.manualSteps !== undefined) next.manualSteps = mergeList(existing.manualSteps, input.manualSteps, mergeStrategy);
    if (input.allowedScope !== undefined) next.allowedScope = mergeList(existing.allowedScope, input.allowedScope, mergeStrategy);
    if (input.outOfScope !== undefined) next.outOfScope = mergeList(existing.outOfScope, input.outOfScope, mergeStrategy);
    if (input.checkCommands !== undefined) next.checkCommands = mergeList(existing.checkCommands, input.checkCommands, mergeStrategy);

    this.inTransaction(() => {
      this.db
        .prepare<SqlRecord>(
          `insert into plans (
             session_id, title, summary, blocked_on_user, blocked_reason, review_instructions,
             workspace_dir, provider, model, updated_at
           ) values (
             $sessionId, $title, $summary, $blockedOnUser, $blockedReason, $reviewInstructions,
             $workspaceDir, $provider, $model, $updatedAt
           )
           on conflict(session_id) do update set
             title = excluded.title,
             summary = excluded.summary,
             blocked_on_user = excluded.blocked_on_user,
             blocked_reason = excluded.blocked_reason,
             review_instructions = excluded.review_instructions,
             workspace_dir = excluded.workspace_dir,
             provider = excluded.provider,
             model = excluded.model,
             updated_at = excluded.updated_at`
        )
        .run({
          sessionId,
          title: next.title ?? null,
          summary: next.summary ?? null,
          blockedOnUser: next.blockedOnUser ? 1 : 0,
          blockedReason: next.blockedReason ?? null,
          reviewInstructions: next.reviewInstructions ?? null,
          workspaceDir: next.workspaceDir ?? null,
          provider: next.provider ?? null,
          model: next.model ?? null,
          updatedAt: next.updatedAt ?? new Date().toISOString()
        });
      this.db.prepare(`delete from plan_checklist_items where session_id = ?`).run(sessionId);
      const stmt = this.db.prepare<SqlRecord>(
        `insert into plan_checklist_items (id, session_id, kind, position, content)
         values ($id, $sessionId, $kind, $position, $content)`
      );
      insertPlanItems(stmt, sessionId, "checklist", next.checklist);
      insertPlanItems(stmt, sessionId, "acceptance", next.acceptanceCriteria);
      insertPlanItems(stmt, sessionId, "manual_step", next.manualSteps);
      insertPlanItems(stmt, sessionId, "allowed_scope", next.allowedScope);
      insertPlanItems(stmt, sessionId, "out_of_scope", next.outOfScope);
      insertPlanItems(stmt, sessionId, "check_command", next.checkCommands);
    });
    return next;
  }

  clearPlan(sessionKey: string): void {
    const session = this.findSession(sessionKey);
    if (!session) return;
    this.db.prepare(`delete from plans where session_id = ?`).run(session.id);
  }

  createApproval(params: {
    sessionKey: string;
    toolName: string;
    arguments: Record<string, unknown>;
  }): PendingToolApproval {
    const sessionId = this.ensureEphemeralSession(params.sessionKey);
    const existing = this.db
      .prepare<{ sessionId: string; toolName: string; argumentsJson: string }>(
        `select id, requested_at
         from approvals
         where session_id = $sessionId and tool_name = $toolName
           and arguments_json = $argumentsJson and status = 'pending'
         order by requested_at desc
         limit 1`
      )
      .get<{ id: string; requested_at: string }>({
        sessionId,
        toolName: params.toolName,
        argumentsJson: JSON.stringify(params.arguments)
      });
    if (existing) {
      return {
        id: existing.id,
        sessionKey: params.sessionKey,
        toolName: params.toolName,
        arguments: params.arguments,
        requestedAt: existing.requested_at
      };
    }
    const approval: PendingToolApproval = {
      id: crypto.randomUUID(),
      sessionKey: params.sessionKey,
      toolName: params.toolName,
      arguments: params.arguments,
      requestedAt: new Date().toISOString()
    };
    this.db
      .prepare<SqlRecord>(
        `insert into approvals (id, session_id, tool_name, arguments_json, status, requested_at)
         values ($id, $sessionId, $toolName, $argumentsJson, 'pending', $requestedAt)`
      )
      .run({
        id: approval.id,
        sessionId,
        toolName: approval.toolName,
        argumentsJson: JSON.stringify(approval.arguments),
        requestedAt: approval.requestedAt
      });
    return approval;
  }

  listPendingApprovals(sessionKey?: string): PendingToolApproval[] {
    const rows = sessionKey
      ? this.db
          .prepare<{ sessionKey: string }>(
            `select a.id, s.session_key, a.tool_name, a.arguments_json, a.requested_at
             from approvals a
             join sessions s on s.id = a.session_id
             where a.status = 'pending' and s.session_key = $sessionKey
             order by a.requested_at asc`
          )
          .all<ApprovalRow>({ sessionKey })
      : this.db
          .prepare(
            `select a.id, s.session_key, a.tool_name, a.arguments_json, a.requested_at
             from approvals a
             join sessions s on s.id = a.session_id
             where a.status = 'pending'
             order by a.requested_at asc`
          )
          .all<ApprovalRow>();
    return rows.map((row) => ({
      id: row.id,
      sessionKey: row.session_key,
      toolName: row.tool_name,
      arguments: parseJson(row.arguments_json),
      requestedAt: row.requested_at
    }));
  }

  getPendingApproval(id: string): PendingToolApproval | null {
    const row = this.db
      .prepare<{ id: string }>(
        `select a.id, s.session_key, a.tool_name, a.arguments_json, a.requested_at
         from approvals a
         join sessions s on s.id = a.session_id
         where a.id = $id and a.status = 'pending'`
      )
      .get<ApprovalRow>({ id });
    return row
      ? {
          id: row.id,
          sessionKey: row.session_key,
          toolName: row.tool_name,
          arguments: parseJson(row.arguments_json),
          requestedAt: row.requested_at
        }
      : null;
  }

  resolveApproval(id: string, status: "approved" | "denied" | "expired"): PendingToolApproval | null {
    const approval = this.getPendingApproval(id);
    if (!approval) return null;
    this.db
      .prepare<{ id: string; status: string; resolvedAt: string }>(
        `update approvals set status = $status, resolved_at = $resolvedAt where id = $id`
      )
      .run({ id, status, resolvedAt: new Date().toISOString() });
    return approval;
  }

  upsertJobRecord(record: JobRecord): void {
    this.inTransaction(() => {
      this.db
        .prepare<SqlRecord>(
          `insert into job_records (
             id, planner_session_id, agent_id, title, status, workspace_dir, worktree_dir,
             base_branch, job_branch, base_commit, provider, model, base_url,
             runtime_command, runtime_args_json, pid, result_summary, blocker_question,
             review_decision, review_summary, review_applied, review_iteration_count,
             created_at, updated_at, last_heartbeat_at
           ) values (
             $id, $plannerSessionId, $agentId, $title, $status, $workspaceDir, $worktreeDir,
             $baseBranch, $jobBranch, $baseCommit, $provider, $model, $baseUrl,
             $runtimeCommand, $runtimeArgsJson, $pid, $resultSummary, $blockerQuestion,
             $reviewDecision, $reviewSummary, $reviewApplied, $reviewIterationCount,
             $createdAt, $updatedAt, $lastHeartbeatAt
           )
           on conflict(id) do update set
             planner_session_id = excluded.planner_session_id,
             agent_id = excluded.agent_id,
             title = excluded.title,
             status = excluded.status,
             workspace_dir = excluded.workspace_dir,
             worktree_dir = excluded.worktree_dir,
             base_branch = excluded.base_branch,
             job_branch = excluded.job_branch,
             base_commit = excluded.base_commit,
             provider = excluded.provider,
             model = excluded.model,
             base_url = excluded.base_url,
             runtime_command = excluded.runtime_command,
             runtime_args_json = excluded.runtime_args_json,
             pid = excluded.pid,
             result_summary = excluded.result_summary,
             blocker_question = excluded.blocker_question,
             review_decision = excluded.review_decision,
             review_summary = excluded.review_summary,
             review_applied = excluded.review_applied,
             review_iteration_count = excluded.review_iteration_count,
             updated_at = excluded.updated_at,
             last_heartbeat_at = excluded.last_heartbeat_at`
        )
        .run({
          id: record.id,
          plannerSessionId: this.findSession(record.plannerSessionKey)?.id ?? null,
          agentId: record.agentId ?? null,
          title: record.title,
          status: record.status,
          workspaceDir: record.workspaceDir,
          worktreeDir: record.worktreeDir,
          baseBranch: record.baseBranch,
          jobBranch: record.jobBranch,
          baseCommit: record.baseCommit,
          provider: record.modelConfig.provider,
          model: record.modelConfig.model,
          baseUrl: record.modelConfig.baseUrl ?? null,
          runtimeCommand: record.modelConfig.runtimeCommand,
          runtimeArgsJson: JSON.stringify(record.modelConfig.runtimeArgs),
          pid: record.pid ?? null,
          resultSummary: record.resultSummary ?? null,
          blockerQuestion: record.blockerQuestion ?? null,
          reviewDecision: record.reviewOutcome?.decision ?? null,
          reviewSummary: record.reviewOutcome?.summary ?? null,
          reviewApplied: record.reviewOutcome ? (record.reviewOutcome.applied ? 1 : 0) : null,
          reviewIterationCount: record.reviewIterationCount ?? 0,
          createdAt: record.createdAt,
          updatedAt: record.updatedAt,
          lastHeartbeatAt: record.lastHeartbeatAt ?? null
        });
      this.db.prepare(`delete from job_check_results where job_id = ?`).run(record.id);
      const stmt = this.db.prepare<SqlRecord>(
        `insert into job_check_results (
           id, job_id, position, command, exit_code, ok, started_at, finished_at, output
         ) values (
           $id, $jobId, $position, $command, $exitCode, $ok, $startedAt, $finishedAt, $output
         )`
      );
      record.checkResults.forEach((result, index) => {
        stmt.run({
          id: crypto.randomUUID(),
          jobId: record.id,
          position: index,
          command: result.command,
          exitCode: result.exitCode,
          ok: result.ok ? 1 : 0,
          startedAt: result.startedAt,
          finishedAt: result.finishedAt,
          output: result.output
        });
      });
    });
  }

  removeJobRecord(id: string): void {
    this.db.prepare(`delete from job_records where id = ?`).run(id);
  }

  createScheduledTask(task: ScheduledTaskRecord): void {
    this.upsertScheduledTask(task);
  }

  upsertScheduledTask(task: ScheduledTaskRecord): void {
    this.db
      .prepare<SqlRecord>(
        `insert into scheduled_tasks (
           id, kind, agent_id, session_target, schedule_type, run_at, interval_ms, cron_expr, prompt,
           delivery_adapter, delivery_address, status, is_internal, created_at, updated_at, next_run_at
         ) values (
           $id, $kind, $agentId, $sessionTarget, $scheduleType, $runAt, $intervalMs, $cronExpr, $prompt,
           $deliveryAdapter, $deliveryAddress, $status, $isInternal, $createdAt, $updatedAt, $nextRunAt
         )
         on conflict(id) do update set
           kind = excluded.kind,
           agent_id = excluded.agent_id,
           session_target = excluded.session_target,
           schedule_type = excluded.schedule_type,
           run_at = excluded.run_at,
           interval_ms = excluded.interval_ms,
           cron_expr = excluded.cron_expr,
           prompt = excluded.prompt,
           delivery_adapter = excluded.delivery_adapter,
           delivery_address = excluded.delivery_address,
           status = excluded.status,
           is_internal = excluded.is_internal,
           updated_at = excluded.updated_at,
           next_run_at = excluded.next_run_at`
      )
      .run({
        id: task.id,
        kind: task.kind,
        agentId: task.agentId ?? null,
        sessionTarget: task.sessionTarget,
        scheduleType: task.scheduleType,
        runAt: task.runAt ?? null,
        intervalMs: task.intervalMs ?? null,
        cronExpr: task.cronExpr ?? null,
        prompt: task.prompt,
        deliveryAdapter: task.deliveryAdapter ?? null,
        deliveryAddress: task.deliveryAddress ?? null,
        status: task.status,
        isInternal: task.isInternal ? 1 : 0,
        createdAt: task.createdAt,
        updatedAt: task.updatedAt,
        nextRunAt: task.nextRunAt ?? null
      });
  }

  listDueTasks(now = new Date().toISOString()): ScheduledTaskRecord[] {
    return this.db
      .prepare<{ now: string }>(
        `select id, kind, agent_id, session_target, schedule_type, run_at, interval_ms, cron_expr, prompt,
                delivery_adapter, delivery_address, status, is_internal, created_at, updated_at, next_run_at
         from scheduled_tasks
         where status = 'active' and next_run_at is not null and next_run_at <= $now
         order by next_run_at asc`
      )
      .all<{
        id: string;
        kind: ScheduledTaskRecord["kind"];
        agent_id: string | null;
        session_target: string;
        schedule_type: ScheduledTaskRecord["scheduleType"];
        run_at: string | null;
        interval_ms: number | null;
        cron_expr: string | null;
        prompt: string;
        delivery_adapter: string | null;
        delivery_address: string | null;
        status: ScheduledTaskRecord["status"];
        is_internal: number;
        created_at: string;
        updated_at: string;
        next_run_at: string | null;
      }>({ now })
      .map((row) => ({
        id: row.id,
        kind: row.kind,
        agentId: row.agent_id ?? undefined,
        sessionTarget: row.session_target,
        scheduleType: row.schedule_type,
        runAt: row.run_at ?? undefined,
        intervalMs: row.interval_ms ?? undefined,
        cronExpr: row.cron_expr ?? undefined,
        prompt: row.prompt,
        deliveryAdapter: row.delivery_adapter ?? undefined,
        deliveryAddress: row.delivery_address ?? undefined,
        status: row.status,
        isInternal: row.is_internal === 1,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        nextRunAt: row.next_run_at ?? undefined
      }));
  }

  listScheduledTasks(): ScheduledTaskRecord[] {
    return this.db
      .prepare(
        `select id, kind, agent_id, session_target, schedule_type, run_at, interval_ms, cron_expr, prompt,
                delivery_adapter, delivery_address, status, is_internal, created_at, updated_at, next_run_at
         from scheduled_tasks
         order by created_at asc`
      )
      .all<{
        id: string;
        kind: ScheduledTaskRecord["kind"];
        agent_id: string | null;
        session_target: string;
        schedule_type: ScheduledTaskRecord["scheduleType"];
        run_at: string | null;
        interval_ms: number | null;
        cron_expr: string | null;
        prompt: string;
        delivery_adapter: string | null;
        delivery_address: string | null;
        status: ScheduledTaskRecord["status"];
        is_internal: number;
        created_at: string;
        updated_at: string;
        next_run_at: string | null;
      }>()
      .map((row) => ({
        id: row.id,
        kind: row.kind,
        agentId: row.agent_id ?? undefined,
        sessionTarget: row.session_target,
        scheduleType: row.schedule_type,
        runAt: row.run_at ?? undefined,
        intervalMs: row.interval_ms ?? undefined,
        cronExpr: row.cron_expr ?? undefined,
        prompt: row.prompt,
        deliveryAdapter: row.delivery_adapter ?? undefined,
        deliveryAddress: row.delivery_address ?? undefined,
        status: row.status,
        isInternal: row.is_internal === 1,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        nextRunAt: row.next_run_at ?? undefined
      }));
  }

  getScheduledTask(id: string): ScheduledTaskRecord | null {
    const row = this.db
      .prepare<{ id: string }>(
        `select id, kind, agent_id, session_target, schedule_type, run_at, interval_ms, cron_expr, prompt,
                delivery_adapter, delivery_address, status, is_internal, created_at, updated_at, next_run_at
         from scheduled_tasks
         where id = $id`
      )
      .get<{
        id: string;
        kind: ScheduledTaskRecord["kind"];
        agent_id: string | null;
        session_target: string;
        schedule_type: ScheduledTaskRecord["scheduleType"];
        run_at: string | null;
        interval_ms: number | null;
        cron_expr: string | null;
        prompt: string;
        delivery_adapter: string | null;
        delivery_address: string | null;
        status: ScheduledTaskRecord["status"];
        is_internal: number;
        created_at: string;
        updated_at: string;
        next_run_at: string | null;
      }>({ id });
    return row
      ? {
          id: row.id,
          kind: row.kind,
          agentId: row.agent_id ?? undefined,
          sessionTarget: row.session_target,
          scheduleType: row.schedule_type,
          runAt: row.run_at ?? undefined,
          intervalMs: row.interval_ms ?? undefined,
          cronExpr: row.cron_expr ?? undefined,
          prompt: row.prompt,
          deliveryAdapter: row.delivery_adapter ?? undefined,
          deliveryAddress: row.delivery_address ?? undefined,
          status: row.status,
          isInternal: row.is_internal === 1,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
          nextRunAt: row.next_run_at ?? undefined
        }
      : null;
  }

  deleteScheduledTask(id: string): void {
    this.db.prepare(`delete from scheduled_tasks where id = ?`).run(id);
  }

  recordTaskRun(params: {
    id: string;
    taskId: string;
    status: string;
    resultText?: string;
    startedAt?: string;
    finishedAt?: string;
  }): void {
    this.db
      .prepare<SqlRecord>(
        `insert into task_runs (id, task_id, status, result_text, started_at, finished_at)
         values ($id, $taskId, $status, $resultText, $startedAt, $finishedAt)`
      )
      .run({
        id: params.id,
        taskId: params.taskId,
        status: params.status,
        resultText: params.resultText ?? null,
        startedAt: params.startedAt ?? null,
        finishedAt: params.finishedAt ?? null
      });
  }

  private upsertSessionFromInbound(message: InboundMessage): string {
    const existing = this.findSession(message.sessionKey.toString());
    const now = toIso(message.timestampMs);
    const sessionId = existing?.id ?? crypto.randomUUID();
    this.db
      .prepare<SqlRecord>(
        `insert into sessions (
           id, session_key, agent_id, adapter, account_id, chat_kind, conversation_id, thread_id,
           conversation_label, sender_id, sender_name, status, created_at, updated_at, last_message_at
         ) values (
           $id, $sessionKey, $agentId, $adapter, $accountId, $chatKind, $conversationId, $threadId,
           $conversationLabel, $senderId, $senderName, 'active', $createdAt, $updatedAt, $lastMessageAt
         )
         on conflict(session_key) do update set
           agent_id = excluded.agent_id,
           adapter = excluded.adapter,
           account_id = excluded.account_id,
           chat_kind = excluded.chat_kind,
           conversation_id = excluded.conversation_id,
           thread_id = excluded.thread_id,
           conversation_label = excluded.conversation_label,
           sender_id = excluded.sender_id,
           sender_name = excluded.sender_name,
           updated_at = excluded.updated_at,
           last_message_at = excluded.last_message_at`
      )
      .run({
        id: sessionId,
        sessionKey: message.sessionKey.toString(),
        agentId: "main",
        adapter: message.adapter,
        accountId: message.accountId ?? null,
        chatKind: message.chatKind,
        conversationId: message.conversationId,
        threadId: message.threadId ?? null,
        conversationLabel: message.senderName ?? null,
        senderId: message.senderId,
        senderName: message.senderName ?? null,
        createdAt: existing?.created_at ?? now,
        updatedAt: now,
        lastMessageAt: now
      });
    this.db
      .prepare<SqlRecord>(
        `insert into session_routes (session_id, delivery_adapter, delivery_address, delivery_thread_id, updated_at)
         values ($sessionId, $deliveryAdapter, $deliveryAddress, $deliveryThreadId, $updatedAt)
         on conflict(session_id) do update set
           delivery_adapter = excluded.delivery_adapter,
           delivery_address = excluded.delivery_address,
           delivery_thread_id = excluded.delivery_thread_id,
           updated_at = excluded.updated_at`
      )
      .run({
        sessionId,
        deliveryAdapter: message.deliveryTarget.adapter,
        deliveryAddress: message.deliveryTarget.address,
        deliveryThreadId: message.deliveryTarget.threadId ?? null,
        updatedAt: now
      });
    return sessionId;
  }

  private ensureEphemeralSession(sessionKey: string): string {
    const existing = this.findSession(sessionKey);
    if (existing) return existing.id;
    const now = new Date().toISOString();
    const sessionId = crypto.randomUUID();
    this.db
      .prepare<SqlRecord>(
        `insert into sessions (
           id, session_key, agent_id, adapter, chat_kind, conversation_id, status,
           created_at, updated_at, last_message_at
         ) values (
           $id, $sessionKey, 'main', 'system', 'direct', $conversationId, 'active',
           $createdAt, $updatedAt, $lastMessageAt
         )`
      )
      .run({
        id: sessionId,
        sessionKey,
        conversationId: sessionKey,
        createdAt: now,
        updatedAt: now,
        lastMessageAt: now
      });
    this.db
      .prepare<SqlRecord>(
        `insert into session_routes (session_id, delivery_adapter, delivery_address, updated_at)
         values ($sessionId, 'system', $deliveryAddress, $updatedAt)`
      )
      .run({
        sessionId,
        deliveryAddress: `session:${sessionKey}`,
        updatedAt: now
      });
    return sessionId;
  }

  private findSession(sessionKey: string): SessionRow | null {
    return this.db
      .prepare<{ sessionKey: string }>(
        `select s.id, s.session_key, s.adapter, s.chat_kind, s.conversation_id, s.thread_id,
                s.conversation_label, s.sender_id, s.sender_name, s.status, s.created_at, s.updated_at,
                s.last_message_at, r.delivery_adapter, r.delivery_address, r.delivery_thread_id
         from sessions s
         left join session_routes r on r.session_id = s.id
         where s.session_key = $sessionKey`
      )
      .get<SessionRow>({ sessionKey });
  }

  private requireSession(sessionKey: string): SessionRow {
    const session = this.findSession(sessionKey);
    if (!session) {
      throw new Error(`Session not found for key ${sessionKey}`);
    }
    return session;
  }

  private rowToAgent(row: {
    id: string;
    name: string;
    brain_mode: SubagentDefinition["brainMode"];
    model: string;
    base_url: string | null;
    api_key: string | null;
    temperature: number;
    max_output_tokens: number;
    request_timeout_ms: number;
    system_prompt: string | null;
    created_at: string;
  }): SubagentDefinition {
    const allowedTools = this.db
      .prepare<{ agentId: string }>(
        `select tool_name from agent_allowed_tools where agent_id = $agentId order by tool_name asc`
      )
      .all<{ tool_name: string }>({ agentId: row.id })
      .map((entry) => entry.tool_name);
    const skills = this.db
      .prepare<{ agentId: string }>(
        `select skill_name from agent_skills where agent_id = $agentId order by skill_name asc`
      )
      .all<{ skill_name: string }>({ agentId: row.id })
      .map((entry) => entry.skill_name);
    return {
      id: row.id,
      name: row.name,
      brainMode: row.brain_mode,
      model: row.model,
      baseUrl: row.base_url ?? undefined,
      apiKey: row.api_key ?? undefined,
      temperature: row.temperature,
      maxOutputTokens: row.max_output_tokens,
      requestTimeoutMs: row.request_timeout_ms,
      systemPrompt: row.system_prompt ?? undefined,
      allowedTools,
      skills,
      createdAt: row.created_at
    };
  }

  private rowToSessionSummary(row: SessionRow): SessionSummary {
    return {
      key: new SessionKey(row.session_key),
      origin: {
        adapter: row.adapter as SessionSummary["origin"]["adapter"],
        chatKind: row.chat_kind as SessionSummary["origin"]["chatKind"],
        conversationLabel: row.conversation_label ?? undefined,
        senderId: row.sender_id ?? "",
        senderName: row.sender_name ?? undefined,
        conversationId: row.conversation_id,
        threadId: row.thread_id ?? undefined
      },
      lastDelivery: this.sessionDeliveryTarget(row),
      status: row.status,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      lastMessageAt: row.last_message_at ?? undefined
    };
  }

  private sessionDeliveryTarget(row: {
    adapter: string;
    delivery_adapter: string | null;
    delivery_address: string | null;
    delivery_thread_id: string | null;
  }): DeliveryTarget {
    return {
      adapter: (row.delivery_adapter ?? row.adapter) as DeliveryTarget["adapter"],
      address: row.delivery_address ?? "",
      threadId: row.delivery_thread_id ?? undefined
    };
  }

  private insertMessage(params: {
    id: string;
    sessionId: string;
    role: ChatTurn["role"];
    adapter: string | null;
    externalMessageId: string | null;
    senderId: string | null;
    senderName: string | null;
    content: string;
    createdAt: string;
  }): void {
    this.db
      .prepare<SqlRecord>(
        `insert into messages (
           id, session_id, role, adapter, external_message_id, sender_id, sender_name, content, created_at
         ) values (
           $id, $sessionId, $role, $adapter, $externalMessageId, $senderId, $senderName, $content, $createdAt
         )`
      )
      .run({
        id: params.id,
        sessionId: params.sessionId,
        role: params.role,
        adapter: params.adapter,
        externalMessageId: params.externalMessageId,
        senderId: params.senderId,
        senderName: params.senderName,
        content: params.content,
        createdAt: params.createdAt
      });
  }

  private inTransaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }
}

type SessionRow = {
  id: string;
  session_key: string;
  adapter: string;
  chat_kind: string;
  conversation_id: string;
  thread_id: string | null;
  conversation_label: string | null;
  sender_id: string | null;
  sender_name: string | null;
  status: string;
  created_at: string;
  updated_at: string;
  last_message_at: string | null;
  delivery_adapter: string | null;
  delivery_address: string | null;
  delivery_thread_id: string | null;
};

type ApprovalRow = {
  id: string;
  session_key: string;
  tool_name: string;
  arguments_json: string;
  requested_at: string;
};

function toIso(timestampMs?: number): string {
  return typeof timestampMs === "number" ? new Date(timestampMs).toISOString() : new Date().toISOString();
}

function parseJson(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function createEmptyPlan(): SessionPlan {
  return {
    checklist: [],
    acceptanceCriteria: [],
    manualSteps: [],
    blockedOnUser: false,
    allowedScope: [],
    outOfScope: [],
    checkCommands: []
  };
}

function mergeList(existing: string[], incoming: string[], strategy: "replace" | "append"): string[] {
  if (strategy === "replace") {
    return dedupe(incoming);
  }
  return dedupe([...existing, ...incoming]);
}

function dedupe(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const normalized = value.trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

function groupPlanItems(items: Array<{ kind: PlanChecklistKind; content: string }>): Record<PlanChecklistKind, string[]> {
  return {
    checklist: items.filter((item) => item.kind === "checklist").map((item) => item.content),
    acceptance: items.filter((item) => item.kind === "acceptance").map((item) => item.content),
    manual_step: items.filter((item) => item.kind === "manual_step").map((item) => item.content),
    allowed_scope: items.filter((item) => item.kind === "allowed_scope").map((item) => item.content),
    out_of_scope: items.filter((item) => item.kind === "out_of_scope").map((item) => item.content),
    check_command: items.filter((item) => item.kind === "check_command").map((item) => item.content)
  };
}

function insertPlanItems(
  stmt: { run(params: SqlRecord): unknown },
  sessionId: string,
  kind: PlanChecklistKind,
  values: string[]
): void {
  values.forEach((content, position) => {
    stmt.run({
      id: crypto.randomUUID(),
      sessionId,
      kind,
      position,
      content
    });
  });
}
