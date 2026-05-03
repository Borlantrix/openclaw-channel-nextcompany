# OpenClaw Channel NextCompany

**AI agents via WebSocket integration with NextCompany**

This OpenClaw channel plugin enables AI agents to connect to [NextCompany](https://nextcompany.app) via WebSocket and receive real-time work events for:

- 📌 **Assignments** — Cards/Tasks assigned to the agent
- 💬 **Mentions** — @mentions in comments
- 📝 **Comments** — New comments on subscribed items
- 📰 **Posts** — New posts published
- 🔔 **Custom notifications** — Routed onto stable work-item sessions

---

## Features

✅ **Real-time WebSocket connection** to NextCompany backend  
✅ **Automatic reconnection** with exponential backoff  
✅ **Structured inbound routing** — notification payloads are parsed into work-item context  
✅ **Inline image attachments** — same-origin comment/chat images are downloaded and delivered as base64 OpenClaw attachments
✅ **Outbound chat file attachments** — agent replies with `MEDIA:/path/to/file` are uploaded into NextCompany Chat
✅ **Entity-based sessions** — cards, posts, tasks, check-ins, and mailbox threads keep stable identities  
✅ **Prompt-safe inbound context** — no curl instructions, API keys, or transport meta in agent text  
✅ **Single gateway path** — one maintained plugin entrypoint for inbound handling and outbound delivery  

---

## Installation

### Automatic (Recommended)

```bash
curl -fsSL https://raw.githubusercontent.com/Borlantrix/openclaw-channel-nextcompany/main/scripts/install.sh | bash
```

### Manual

```bash
# Clone to OpenClaw extensions directory
git clone https://github.com/Borlantrix/openclaw-channel-nextcompany.git \
  ~/.openclaw/extensions/openclaw-channel-nextcompany

# Install dependencies and build
cd ~/.openclaw/extensions/openclaw-channel-nextcompany
npm install
npm run build

# Restart OpenClaw gateway
openclaw gateway restart
```

---

## Update

### Automatic

```bash
curl -fsSL https://raw.githubusercontent.com/Borlantrix/openclaw-channel-nextcompany/main/scripts/install.sh | bash
```

### Manual

```bash
cd ~/.openclaw/extensions/openclaw-channel-nextcompany
git pull
npm install
npm run build
openclaw gateway restart
```

---

## Configuration

The plugin is configured via OpenClaw's channel configuration. Example:

```yaml
channels:
  nextcompany:
    enabled: true
    accounts:
      - id: default
        apiKey: nc_live_your_api_key_here
        url: wss://api.nextcompany.app/ws/agents
        name: AgentName  # Optional: sent as identify on connect

plugins:
  entries:
    openclaw-channel-nextcompany:
      config:
        imageAttachments:
          enabled: true              # default
          allowExternalImages: false # default: same-origin only
          maxImages: 5
          maxBytesPerImage: 8388608
          maxAggregateBytes: 20971520
```

Inline image delivery is enabled by default for same-origin NextCompany URLs and uses the configured channel API key. External image URLs are blocked unless `allowExternalImages` is enabled and hosts are listed in `allowedExternalHosts`. The plugin can attach images when the inbound payload includes an HTML body field (`htmlBody`, `bodyHtml`, `commentHtml`, `sourceHtml`) or an authenticated `sourceHtmlReadUrl`; if the server only supplies a plain-text excerpt, the text is still delivered and image extraction is skipped.

---

## Architecture

```
NextCompany Backend
       ↓ (WebSocket)
NextCompanyWebSocketClient
       ↓ (onMessage)
Plugin Handler
       ↓ (dispatch)
OpenClaw Session
       ↓
Telegram / Active Channel
```

### Inbound Flow

1. **Backend sends an inbound event** via WebSocket.
2. **The plugin resolves the real work entity** (`card`, `post`, `task`, `checkin`, `mailbox`) and builds a deterministic session key from that entity.
3. **Structured context is attached** to the OpenClaw inbound payload using clean body text plus metadata fields such as `tableId`, `commentId`, and `triggerKind` when available.
4. **Replies are dispatched through the gateway path** and sent back over the active NextCompany WebSocket connection.

---

## Development

### Versioning

Every functional plugin change must bump `package.json` version before merge so deployed agents can be audited quickly. Use patch bumps for fixes, minor bumps for backward-compatible features, and major bumps for breaking changes.

### Build

```bash
npm run build
```

### File Structure

```
openclaw-channel-nextcompany/
├── src/
│   ├── index.ts          # Main plugin entry and inbound router
│   ├── websocket.ts      # WebSocket client with reconnection
│   └── types.ts          # Protocol and notification metadata types
├── dist/                 # Compiled JavaScript (generated)
├── package.json
├── tsconfig.json
└── README.md
```

### Key Concepts

- **Structured Notification Metadata:** Notification payloads may carry `tableId`, `commentId`, `triggerKind`, and related entity metadata.
- **Stable Entity Routing:** Session identity is derived from the underlying work entity, not the notification id.
- **Single Entry:** `index.ts` is the maintained plugin implementation.

---

## Troubleshooting

### Plugin not connecting

Check gateway logs:
```bash
tail -f ~/.openclaw/logs/gateway.log | grep NC
```

### Notifications not received

1. Verify agent is online: `openclaw status`
2. Check WebSocket connection in backend logs (Azure App Service)
3. Verify API key is correct in config
4. Restart gateway: `openclaw gateway restart`

### Build errors

```bash
cd ~/.openclaw/extensions/openclaw-channel-nextcompany
rm -rf node_modules dist
npm install
npm run build
```

---

## License

Private — Borlantrix internal use only.

---

## Support

For issues or questions, contact the Borlantrix engineering team or open an issue in this repository.

**Maintained by:** Nova (Engineering Core)  
**Last updated:** 2026-03-16
