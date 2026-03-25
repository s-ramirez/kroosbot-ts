# Adapters

Adapters normalize platform-specific messaging into Kroosbot's `InboundMessage` / `OutboundMessage` types. Each adapter is enabled independently in config.

## Discord (`src/adapters/discord.ts`)

Uses `discord.js`. Listens for messages and converts them to `InboundMessage`.

**Features:**
- `requireMention` — only respond when the bot is @mentioned
- `allowedChannelIds` — whitelist specific channels
- `mentionRoleIds` — treat role mentions as bot mentions
- Auto-splits replies longer than 2000 characters (Discord limit)
- Thread support — replies in the same thread if the message came from one

**Session keys:**
- Direct messages: `discord:direct:<userId>`
- Channels: `discord:channel:<channelId>` (with optional thread suffix)

**Config:**
```json
{
  "adapters": {
    "discord": {
      "enabled": true,
      "token": "your-bot-token",
      "requireMention": true,
      "allowedChannelIds": ["123456789"],
      "mentionRoleIds": []
    }
  }
}
```

## iMessage (`src/adapters/imessage.ts`)

Webhook receiver for a BlueBubbles-compatible server. Receives inbound messages via HTTP POST and sends replies via the BlueBubbles REST API.

**Features:**
- Password-based webhook authentication
- Supports `chat_guid`, `chat_identifier`, or `handle` as delivery targets
- Can query chat participants, set typing indicators, mark as read
- `allowedSenders` — whitelist specific phone numbers / Apple IDs

**Session keys:**
- Direct messages: `imessage:direct:<sender>`
- Group chats: `imessage:group:<chatGuid or chatIdentifier>`

**Config:**
```json
{
  "adapters": {
    "imessage": {
      "enabled": true,
      "serverUrl": "http://localhost:1234",
      "password": "your-bluebubbles-password",
      "webhookPath": "/webhooks/imessage",
      "requestTimeoutMs": 30000,
      "markAsRead": true,
      "sendTyping": true,
      "allowedSenders": ["+15551234567"]
    }
  }
}
```
