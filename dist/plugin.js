import { createRequire } from 'module';
import { NextCompanyWebSocketClient } from './websocket.js';
import {} from './types.js';
const _require = createRequire(import.meta.url);
// Minimal ChannelPlugin shape — matches openclaw ChannelPlugin interface
// Full types available when openclaw is installed as peer dependency
const connections = new Map();
function resolveAccount(cfg) {
    const c = cfg;
    return {
        id: String(c['id'] ?? ''),
        apiKey: String(c['apiKey'] ?? ''),
        url: String(c['url'] ?? ''),
    };
}
export const plugin = {
    id: 'nextcompany',
    meta: {
        id: 'nextcompany',
        label: 'NextCompany',
        selectionLabel: 'NextCompany',
        detailLabel: 'NextCompany Agent Channel',
        blurb: 'Connect to NextCompany as an AI agent via WebSocket.',
        docsPath: '/channels/nextcompany',
    },
    capabilities: {
        messaging: true,
        reactions: false,
        threads: false,
        groups: false,
        streaming: false,
    },
    config: {
        resolveAccount: (raw) => resolveAccount(raw),
        validateAccount: (raw) => {
            const { id, apiKey, url } = resolveAccount(raw);
            if (!id)
                return { ok: false, error: 'Missing account id' };
            if (!apiKey)
                return { ok: false, error: 'Missing apiKey' };
            if (!url)
                return { ok: false, error: 'Missing url' };
            return { ok: true, account: resolveAccount(raw) };
        },
    },
    gateway: {
        startAccount: async (ctx) => {
            const { accountId, account, dispatch } = ctx;
            const onMessage = (msg) => {
                if (msg.type === 'message') {
                    dispatch({
                        channel: 'nextcompany',
                        accountId,
                        chatId: `nextcompany:${accountId}:${msg.fromUserId}`,
                        senderId: msg.fromUserId,
                        senderName: msg.fromName,
                        text: msg.text,
                        messageId: msg.messageId,
                        timestamp: msg.timestamp,
                    });
                    return;
                }
                if (msg.type === 'model_query') {
                    // Respond with the current model from OpenClaw config
                    try {
                        // eslint-disable-next-line @typescript-eslint/no-var-requires
                        const fs = _require('fs');
                        const path = _require('path');
                        const home = process.env.HOME ?? process.env.USERPROFILE ?? '';
                        const configPath = path.join(home, '.openclaw', 'openclaw.json');
                        const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
                        const model = config?.agents?.defaults?.model?.primary ?? 'unknown';
                        client.send({ type: 'model_response', model });
                    }
                    catch {
                        client.send({ type: 'model_response', model: 'unknown' });
                    }
                    return;
                }
                if (msg.type === 'check_in') {
                    dispatch({
                        channel: 'nextcompany',
                        accountId,
                        chatId: `nextcompany:${accountId}:checkin:${msg.checkInId}`,
                        senderId: 'system',
                        senderName: 'NextCompany Check-in',
                        text: `[NextCompany Check-in] ${msg.question}${msg.description ? `\n${msg.description}` : ''}\n\nOccurrence: ${msg.occurrenceId}\nProject: ${msg.projectId}`,
                        timestamp: msg.scheduledAt,
                    });
                    return;
                }
                if (msg.type === 'mailbox_email') {
                    dispatch({
                        channel: 'nextcompany',
                        accountId,
                        chatId: `nextcompany:${accountId}:mailbox:${msg.messageId}`,
                        senderId: msg.from,
                        senderName: msg.fromName ?? msg.from,
                        text: `[NextCompany Mailbox] New email from ${msg.fromName ?? msg.from}\nSubject: ${msg.subject}\n\n${msg.bodyText ?? msg.snippet ?? ''}\n\nMessage ID: ${msg.messageId}`,
                        timestamp: msg.receivedAt,
                    });
                    return;
                }
                if (msg.type === 'notification') {
                    // Payload is flattened — fields are directly on msg, not nested in msg.payload
                    const baseUrl = account.url.replace('/ws/agents', '').replace('wss://', 'https://');
                    // Build a human-readable notification message for the agent
                    let notifText = `[NextCompany Notification] ${msg.kind}: "${msg.sourceTitle}"`;
                    if (msg.actorName)
                        notifText += ` — by ${msg.actorName}`;
                    if (msg.excerpt)
                        notifText += `\n\n${msg.excerpt}`;
                    notifText += `\n\nSource: ${msg.sourceType} | URL: ${baseUrl}${msg.actionUrl}`;
                    if (msg.sourceType === 'Post') {
                        notifText += `\n\nTo respond, use the NextCompany API:`;
                        notifText += `\nGET ${baseUrl}/api/projects/${msg.projectId}/posts/${msg.sourceId}`;
                        notifText += `\nPOST ${baseUrl}/api/projects/${msg.projectId}/posts/${msg.sourceId}/comments  {"body":"your comment"}`;
                    }
                    dispatch({
                        channel: 'nextcompany',
                        accountId,
                        chatId: `nextcompany:${accountId}:notification:${msg.sourceId}`,
                        senderId: 'system',
                        senderName: msg.actorName ?? 'NextCompany',
                        text: notifText,
                        timestamp: new Date().toISOString(),
                    });
                    return;
                }
            };
            const client = new NextCompanyWebSocketClient(account.url, account.apiKey, onMessage, account.name);
            connections.set(accountId, client);
            client.start();
        },
        stopAccount: async (ctx) => {
            const client = connections.get(ctx.accountId);
            client?.stop();
            connections.delete(ctx.accountId);
        },
    },
    outbound: {
        sendMessage: async (ctx) => {
            const client = connections.get(ctx.accountId);
            if (!client)
                throw new Error(`No active connection for account ${ctx.accountId}`);
            client.send({ type: 'message', text: ctx.text, replyToMessageId: ctx.replyToMessageId });
        },
    },
    heartbeat: {
        checkReady: async (ctx) => {
            const client = connections.get(ctx.accountId);
            const ok = client?.isConnected ?? false;
            return { ok, reason: ok ? 'connected' : 'disconnected' };
        },
    },
};
