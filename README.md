# OpenClaw Channel NextCompany

**AI agents via WebSocket integration with NextCompany**

This OpenClaw channel plugin enables AI agents to connect to [NextCompany](https://nextcompany.app) via WebSocket and receive real-time notifications for:

- 📌 **Assignments** — Cards/Tasks assigned to the agent
- 💬 **Mentions** — @mentions in comments
- 📝 **Comments** — New comments on subscribed items
- 📰 **Posts** — New posts published
- 🔔 **Custom notifications** — Extensible notification system

---

## Features

✅ **Real-time WebSocket connection** to NextCompany backend  
✅ **Automatic reconnection** with exponential backoff  
✅ **Flattened payload support** — handles backend's flat notification structure  
✅ **Kind-aware notifications** — Assigned, Mention, NewPost, Comment  
✅ **Auto-dispatch to active session** — Notifications delivered to Telegram/active channel  
✅ **API-ready responses** — Includes curl commands for direct API interaction  

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
```

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

### Notification Flow

1. **Backend sends notification** via WebSocket (flattened payload)
2. **Plugin receives** and parses `type: "notification"`
3. **Kind-aware formatting** based on `kind` field (Assigned, Mention, etc.)
4. **Dispatch to session** with API instructions (curl commands)
5. **Agent responds** using `exec` tool with direct API calls

---

## Development

### Build

```bash
npm run build
```

### File Structure

```
openclaw-channel-nextcompany/
├── src/
│   ├── index.ts          # Main plugin entry (OpenClaw integration)
│   ├── plugin.ts         # Lightweight plugin (standalone)
│   ├── websocket.ts      # WebSocket client with reconnection
│   └── types.ts          # TypeScript types for messages
├── dist/                 # Compiled JavaScript (generated)
├── package.json
├── tsconfig.json
└── README.md
```

### Key Concepts

- **Flattened Payload:** Backend sends notifications with fields directly on the root object (`msg.kind`, `msg.sourceType`), not nested in `msg.payload`.
- **Kind-Aware:** Plugin formats messages differently based on `kind` (Assigned, Mention, NewPost, Comment).
- **Dual Entry:** `index.ts` for full OpenClaw integration, `plugin.ts` for minimal standalone mode.

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
