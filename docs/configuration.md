# Configuration

Config is loaded from `config.json` (or the path in `KROOSBOT_CONFIG` env var) and validated with Zod in `src/config.ts`.

## Setup

```bash
cp config.example.json config.json
# Edit config.json with your settings
```

## Full Schema

### `app`

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `listenPort` | number | `3000` | HTTP server port (for iMessage webhooks) |
| `historyLimit` | number | `50` | Max conversation turns kept per session |
| `workspaceDir` | string | `"."` | Root directory for file tools |

### `brain`

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `mode` | string | — | `"agent-sdk"`, `"openai-compatible"`, or `"echo"` |
| `systemPrompt` | string | — | Base system prompt override |
| `historyWindow` | number | `20` | Turns sent to the brain per request |
| `echoPrefix` | string | `"[echo]"` | Prefix for echo brain |
| `tools.enabled` | boolean | `true` | Enable tool usage |
| `tools.maxSteps` | number | `10` | Max tool loop iterations |

#### `brain.openAiCompatible`

| Field | Type | Description |
|-------|------|-------------|
| `baseUrl` | string | Endpoint URL |
| `model` | string | Model identifier |
| `apiKey` | string | API key (optional for local) |
| `temperature` | number | Sampling temperature |
| `maxOutputTokens` | number | Max response tokens |
| `requestTimeoutMs` | number | Request timeout |

#### `brain.agentSdk`

| Field | Type | Description |
|-------|------|-------------|
| `model` | string | Claude model to use |

### `memory`

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `enabled` | boolean | `true` | Enable memory system |
| `rootDir` | string | — | Directory for memory files |
| `indexFile` | string | `"MEMORY.md"` | Top-level index file |
| `maxResults` | number | `5` | Max search results |
| `maxSnippetChars` | number | `300` | Max chars per snippet |
| `autoRemember.enabled` | boolean | — | Auto-detect preferences/decisions |

### `agents`

| Field | Type | Description |
|-------|------|-------------|
| `enabled` | boolean | Enable subagent system |
| `rootDir` | string | Agent storage directory |
| `seed` | array | Agent definitions to create on startup |

### `initiative`

| Field | Type | Description |
|-------|------|-------------|
| `enabled` | boolean | Enable heartbeat loop |
| `heartbeatIntervalMs` | number | Heartbeat interval |
| `autoReviewReadyJobs` | boolean | Auto-review completed jobs |
| `notifyBlockedJobs` | boolean | Notify on blocked jobs |

### `jobs`

| Field | Type | Description |
|-------|------|-------------|
| `enabled` | boolean | Enable job system |
| `rootDir` | string | Job storage directory |
| `defaultRuntime` | string | Runtime (`"pi"`) |
| `defaultProvider` | string | LLM provider |
| `defaultModel` | string | Model for job workers |
| `timeouts.runMs` | number | Max job runtime |
| `timeouts.heartbeatMs` | number | Heartbeat interval |
| `concurrency.maxRunning` | number | Max concurrent jobs |
| `runtimeCommand` | string | CLI command to run |
| `runtimeArgs` | string[] | Extra CLI arguments |
| `runtimeUsePty` | boolean | Launch the job runtime under a PTY |
| `checks.commands` | string[] | Post-completion check commands |

### `adapters.discord`

| Field | Type | Description |
|-------|------|-------------|
| `enabled` | boolean | Enable Discord adapter |
| `token` | string | Bot token |
| `requireMention` | boolean | Only respond to @mentions |
| `allowedChannelIds` | string[] | Channel whitelist |
| `mentionRoleIds` | string[] | Role IDs treated as mentions |

### `adapters.imessage`

| Field | Type | Description |
|-------|------|-------------|
| `enabled` | boolean | Enable iMessage adapter |
| `serverUrl` | string | BlueBubbles server URL |
| `password` | string | Server password |
| `webhookPath` | string | Webhook endpoint path |
| `requestTimeoutMs` | number | Request timeout |
| `markAsRead` | boolean | Mark messages as read |
| `sendTyping` | boolean | Send typing indicators |
| `allowedSenders` | string[] | Sender whitelist |
