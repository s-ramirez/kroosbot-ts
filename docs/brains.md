# Brain Implementations

All brains implement the `Brain` interface defined in `src/brain/types.ts`:

```typescript
interface Brain {
  reply(message: InboundMessage, history: ChatHistory): Promise<OutboundMessage | null>;
}
```

Set the active brain via `brain.mode` in `config.json`.

## AgentSdkBrain (`agent-sdk`)

**File:** `src/brain/agentSdk.ts`

Uses `@anthropic-ai/claude-agent-sdk` with Claude Code OAuth authentication (`claude login` — no API key needed).

- Creates a fresh in-process MCP server per query via `createSdkMcpServer` + `tool()`
- Tools are exposed natively through MCP (not described in the system prompt)
- Uses a mutable `currentSessionKey` field set before each query so MCP tool handlers can access the correct session
- Supports `maxTurns` for controlling tool loop depth

**Config:**
```json
{
  "brain": {
    "mode": "agent-sdk",
    "agentSdk": {
      "model": "claude-sonnet-4-20250514"
    }
  }
}
```

## OpenAiCompatibleBrain (`openai-compatible`)

**File:** `src/brain/openaiCompatible.ts`

Raw HTTP to any OpenAI-compatible endpoint (llama.cpp, LM Studio, Ollama, etc.).

- Tool descriptions are injected as text into the system prompt
- The model emits `{"type":"tool_call","name":"...","arguments":{...}}` JSON
- The brain parses tool calls and executes them in a manual loop
- Configurable base URL, model, API key, temperature, timeout

**Config:**
```json
{
  "brain": {
    "mode": "openai-compatible",
    "openAiCompatible": {
      "baseUrl": "http://localhost:8080/v1",
      "model": "local-model",
      "apiKey": "not-needed",
      "temperature": 0.7,
      "maxOutputTokens": 2048,
      "requestTimeoutMs": 120000
    }
  }
}
```

## EchoBrain (`echo`)

**File:** `src/brain/echo.ts`

Testing-only brain that mirrors input back with a configurable prefix. Supports two special commands:

- `/ping` → responds with "pong"
- `/history` → dumps conversation history

**Config:**
```json
{
  "brain": {
    "mode": "echo",
    "echoPrefix": "[echo]"
  }
}
```
