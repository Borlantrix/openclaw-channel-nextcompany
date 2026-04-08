import { execSync } from 'child_process';
import { existsSync, readdirSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { createAccountListHelpers } from 'openclaw/plugin-sdk';
import { NextCompanyWebSocketClient } from './websocket.js';
const CHANNEL_ID = 'nextcompany';
const CHANNEL_LABEL = 'NextCompany';
const connections = new Map();
const { listAccountIds, resolveDefaultAccountId } = createAccountListHelpers(CHANNEL_ID);
function getAccounts(cfg) {
    const ch = cfg['channels'];
    const nc = ch?.[CHANNEL_ID];
    const accounts = nc?.['accounts'];
    if (!accounts)
        return {};
    const result = {};
    for (const [id, value] of Object.entries(accounts)) {
        const account = value;
        result[id] = {
            id,
            apiKey: String(account['apiKey'] ?? ''),
            url: String(account['url'] ?? ''),
            name: account['name'] ? String(account['name']) : undefined,
        };
    }
    return result;
}
function resolveAccount(cfg, accountId) {
    const accounts = getAccounts(cfg);
    const id = accountId ?? resolveDefaultAccountId(cfg);
    return accounts[id] ?? { id: id ?? 'default', apiKey: '', url: '' };
}
function getOpenClawVersion() {
    try {
        return execSync('openclaw --version 2>/dev/null', { timeout: 5000 }).toString().trim();
    }
    catch {
        return undefined;
    }
}
function getLatestOpenClawVersion() {
    try {
        return execSync('npm view openclaw version 2>/dev/null', { timeout: 10000 }).toString().trim();
    }
    catch {
        return undefined;
    }
}
function getWorkspaceFiles() {
    const wsDir = join(homedir(), '.openclaw', 'workspace');
    if (!existsSync(wsDir))
        return [];
    const files = [];
    try {
        for (const file of readdirSync(wsDir)) {
            if (file.endsWith('.md'))
                files.push(file);
        }
        for (const subdir of ['memory', 'docs']) {
            const dir = join(wsDir, subdir);
            if (!existsSync(dir))
                continue;
            for (const file of readdirSync(dir)) {
                if (file.endsWith('.md'))
                    files.push(`${subdir}/${file}`);
            }
        }
        const downloadsDir = join(wsDir, 'downloads');
        if (existsSync(downloadsDir)) {
            for (const file of readdirSync(downloadsDir)) {
                files.push(`downloads/${file}`);
            }
        }
    }
    catch {
        return files;
    }
    return files;
}
function readWorkspaceFile(path) {
    try {
        return readFileSync(path, 'utf-8');
    }
    catch {
        return undefined;
    }
}
function extractField(content, field) {
    const regex = new RegExp(`\\*\\*${field}:\\*\\*\\s*(.+)`, 'i');
    const match = content.match(regex);
    return match?.[1]?.trim();
}
function buildIdentifyPayload(cfg) {
    const version = getOpenClawVersion();
    const latestVersion = getLatestOpenClawVersion();
    const workspaceFiles = getWorkspaceFiles();
    const wsDir = join(homedir(), '.openclaw', 'workspace');
    let email;
    let gitHubUsername;
    const identityPath = join(wsDir, 'IDENTITY.md');
    if (existsSync(identityPath)) {
        const content = readWorkspaceFile(identityPath) ?? '';
        email = extractField(content, 'Email');
        gitHubUsername = extractField(content, 'GitHub Team') ?? extractField(content, 'GitHub');
    }
    const toolsPath = join(wsDir, 'TOOLS.md');
    if (existsSync(toolsPath)) {
        const content = readWorkspaceFile(toolsPath) ?? '';
        if (!gitHubUsername)
            gitHubUsername = extractField(content, 'Conta autenticada');
        if (!email)
            email = extractField(content, 'Email');
    }
    const channels = [];
    const clis = [];
    const plugins = [];
    const skills = [];
    const cronJobs = [];
    const cfgAny = cfg;
    const channelSection = cfgAny['channels'];
    if (channelSection) {
        for (const [name, value] of Object.entries(channelSection)) {
            const channel = value;
            channels.push({ name, enabled: channel['enabled'] !== false });
        }
    }
    const pluginSection = cfgAny['plugins']?.['entries'];
    if (pluginSection) {
        for (const [name, value] of Object.entries(pluginSection)) {
            const plugin = value;
            plugins.push({ name, enabled: plugin['enabled'] !== false });
        }
    }
    const heartbeat = cfgAny['heartbeat'];
    if (heartbeat) {
        cronJobs.push({
            name: 'Heartbeat',
            schedule: String(heartbeat['interval'] ?? '5m'),
            enabled: heartbeat['enabled'] !== false,
            type: 'heartbeat',
        });
    }
    let activeModel;
    try {
        const agentsSection = cfgAny['agents'];
        const defaults = agentsSection?.['defaults'];
        const modelSection = defaults?.['model'];
        activeModel = modelSection?.['primary'];
    }
    catch {
        activeModel = undefined;
    }
    return {
        version,
        latestVersion,
        workspaceFiles,
        email,
        gitHubUsername,
        cronJobs,
        tools: { channels, clis, plugins, skills },
        ...(activeModel ? { model: activeModel } : {}),
    };
}
function normalizeBaseUrl(url) {
    return url
        .replace(/^wss:\/\//, 'https://')
        .replace(/^ws:\/\//, 'http://')
        .replace(/\/ws\/agents\/?$/, '');
}
function normalizeToken(value, fallback = 'unknown') {
    const normalized = (value ?? '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9._:-]+/g, '-')
        .replace(/^-+|-+$/g, '');
    return normalized || fallback;
}
function normalizeLabel(value, fallback) {
    const trimmed = value?.trim();
    return trimmed ? trimmed : fallback;
}
function toTimestamp(value) {
    if (!value)
        return undefined;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : undefined;
}
function joinContextLines(lines) {
    return lines
        .map((line) => line?.trim())
        .filter((line) => Boolean(line));
}
function formatNotificationSummary(message) {
    const sourceType = normalizeLabel(message.sourceType, 'work item');
    const title = normalizeLabel(message.sourceTitle, 'Untitled');
    const actor = message.actorName?.trim();
    switch (message.kind) {
        case 'Assigned':
            return actor
                ? `${actor} assigned you to ${sourceType} "${title}".`
                : `You were assigned to ${sourceType} "${title}".`;
        case 'Mention':
            return actor
                ? `${actor} mentioned you in ${sourceType} "${title}".`
                : `You were mentioned in ${sourceType} "${title}".`;
        case 'NewPost':
            return actor
                ? `${actor} published a new post "${title}".`
                : `New post "${title}".`;
        case 'Comment':
            return actor
                ? `${actor} commented on ${sourceType} "${title}".`
                : `New comment on ${sourceType} "${title}".`;
        default:
            return actor
                ? `${actor} triggered ${message.kind} on ${sourceType} "${title}".`
                : `${message.kind} on ${sourceType} "${title}".`;
    }
}
function resolveNotificationMetadata(message) {
    return {
        ...(message.metadata ?? {}),
        tableId: message.tableId ?? message.metadata?.tableId,
        commentId: message.commentId ?? message.metadata?.commentId,
        triggerKind: message.triggerKind ?? message.metadata?.triggerKind,
    };
}
function resolveNotificationEntityUrl(params) {
    const { baseUrl, message, metadata } = params;
    if (message.actionUrl?.trim()) {
        if (/^https?:\/\//i.test(message.actionUrl))
            return message.actionUrl;
        return `${baseUrl}${message.actionUrl.startsWith('/') ? '' : '/'}${message.actionUrl}`;
    }
    switch (normalizeToken(message.sourceType)) {
        case 'card':
            if (message.projectId && metadata.tableId) {
                return `${baseUrl}/projects/${message.projectId}/boards/${metadata.tableId}/cards/${message.sourceId}`;
            }
            return undefined;
        case 'task':
            return `${baseUrl}/projects/${message.projectId}/tasks/${message.sourceId}`;
        case 'post':
            return `${baseUrl}/projects/${message.projectId}/posts/${message.sourceId}`;
        default:
            return undefined;
    }
}
function buildNotificationContext(message, baseUrl) {
    const metadata = resolveNotificationMetadata(message);
    const entityType = normalizeToken(metadata.entityKind ?? message.sourceType, 'notification');
    const entityId = normalizeToken(metadata.entityId ?? message.sourceId ?? message.id, 'unknown');
    const projectId = normalizeToken(message.projectId, 'project');
    const peerId = `${entityType}:${projectId}:${entityId}`;
    const actionUrl = resolveNotificationEntityUrl({ baseUrl, message, metadata });
    const rawBody = [
        formatNotificationSummary(message),
        message.excerpt?.trim() ? `Excerpt:\n${message.excerpt.trim()}` : undefined,
    ]
        .filter((line) => Boolean(line))
        .join('\n\n');
    return {
        rawBody,
        from: message.actorName?.trim()
            ? `nextcompany:actor:${normalizeToken(message.actorName)}`
            : 'nextcompany:system',
        fromLabel: normalizeLabel(message.actorName, CHANNEL_LABEL),
        to: `nextcompany:${peerId}`,
        peerId,
        conversationLabel: `${normalizeLabel(message.sourceType, 'Work')}: ${normalizeLabel(message.sourceTitle, 'Untitled')}`,
        timestamp: toTimestamp(message.createdAt),
        messageSid: metadata.commentId ?? message.id,
        replyToId: metadata.commentId ?? message.id,
        senderName: normalizeLabel(message.actorName, CHANNEL_LABEL),
        senderId: message.actorName?.trim() ? normalizeToken(message.actorName) : 'system',
        untrustedContext: joinContextLines([
            `Notification kind: ${message.kind}`,
            metadata.triggerKind ? `Trigger kind: ${metadata.triggerKind}` : undefined,
            `Entity type: ${normalizeLabel(message.sourceType, 'unknown')}`,
            `Entity id: ${message.sourceId}`,
            message.projectName ? `Project: ${message.projectName}` : `Project id: ${message.projectId}`,
            metadata.tableId ? `Table id: ${metadata.tableId}` : undefined,
            metadata.commentId ? `Comment id: ${metadata.commentId}` : undefined,
            actionUrl ? `Open in NextCompany: ${actionUrl}` : undefined,
        ]),
    };
}
function buildMessageContext(message) {
    const senderId = normalizeToken(message.fromUserId ?? message.from ?? message.channelId, 'system');
    const senderName = normalizeLabel(message.fromName ?? message.senderName ?? message.from, 'NextCompany');
    const attachmentLine = message.attachmentUrl
        ? `Attachment: ${message.attachmentFileName ?? message.attachmentUrl}`
        : undefined;
    return {
        rawBody: joinContextLines([message.text, attachmentLine]).join('\n\n'),
        from: `nextcompany:user:${senderId}`,
        fromLabel: senderName,
        to: `nextcompany:direct:${senderId}`,
        peerId: `direct:${senderId}`,
        conversationLabel: senderName,
        timestamp: toTimestamp(message.timestamp),
        messageSid: message.messageId,
        replyToId: message.messageId,
        senderName,
        senderId,
        senderUsername: message.from,
        untrustedContext: joinContextLines([
            message.channelId ? `Channel id: ${message.channelId}` : undefined,
            message.attachmentUrl ? `Attachment URL: ${message.attachmentUrl}` : undefined,
            message.attachmentContentType ? `Attachment content type: ${message.attachmentContentType}` : undefined,
        ]),
    };
}
function buildCheckInContext(message) {
    const peerId = `checkin:${normalizeToken(message.projectId)}:${normalizeToken(message.checkInId)}`;
    const rawBody = [
        `Check-in question: ${message.question.trim()}`,
        message.description?.trim() ? `Details:\n${message.description.trim()}` : undefined,
    ]
        .filter((line) => Boolean(line))
        .join('\n\n');
    return {
        rawBody,
        from: 'nextcompany:system:checkin',
        fromLabel: 'NextCompany Check-in',
        to: `nextcompany:${peerId}`,
        peerId,
        conversationLabel: `Check-in ${message.checkInId}`,
        timestamp: toTimestamp(message.scheduledAt),
        messageSid: message.occurrenceId,
        replyToId: message.occurrenceId,
        senderName: 'NextCompany Check-in',
        senderId: 'checkin',
        untrustedContext: joinContextLines([
            `Project id: ${message.projectId}`,
            `Check-in id: ${message.checkInId}`,
            `Occurrence id: ${message.occurrenceId}`,
        ]),
    };
}
function buildMailboxContext(message) {
    const mailboxScope = normalizeToken(message.threadId ?? message.conversationId ?? message.messageId, normalizeToken(message.messageId));
    const peerId = `mailbox:${normalizeToken(message.accountId)}:${mailboxScope}`;
    const preview = message.bodyText?.trim() || message.snippet?.trim();
    const rawBody = [
        `Email from ${normalizeLabel(message.fromName, message.from)}`,
        `Subject: ${message.subject.trim()}`,
        preview ? `Preview:\n${preview}` : undefined,
    ]
        .filter((line) => Boolean(line))
        .join('\n\n');
    return {
        rawBody,
        from: `nextcompany:mailbox:${normalizeToken(message.from)}`,
        fromLabel: normalizeLabel(message.fromName, message.from),
        to: `nextcompany:${peerId}`,
        peerId,
        conversationLabel: `Mailbox: ${message.subject.trim() || message.messageId}`,
        timestamp: toTimestamp(message.receivedAt),
        messageSid: message.messageId,
        replyToId: message.messageId,
        senderName: normalizeLabel(message.fromName, message.from),
        senderId: normalizeToken(message.from),
        senderUsername: message.from,
        untrustedContext: joinContextLines([
            `Mailbox account id: ${message.accountId}`,
            message.mailboxId ? `Mailbox id: ${message.mailboxId}` : undefined,
            message.threadId ? `Thread id: ${message.threadId}` : undefined,
            message.conversationId ? `Conversation id: ${message.conversationId}` : undefined,
            `Message id: ${message.messageId}`,
        ]),
    };
}
async function dispatchInboundContext(params) {
    const { cfg, accountId, inbound, channelRuntime, client } = params;
    const route = channelRuntime.routing.resolveAgentRoute({
        cfg,
        channel: CHANNEL_ID,
        accountId,
        peer: {
            kind: 'direct',
            id: inbound.peerId,
        },
    });
    const storePath = channelRuntime.session.resolveStorePath(cfg.session?.store, {
        agentId: route.agentId,
    });
    const previousTimestamp = channelRuntime.session.readSessionUpdatedAt({
        storePath,
        sessionKey: route.sessionKey,
    });
    const envelope = channelRuntime.reply.resolveEnvelopeFormatOptions(cfg);
    const body = channelRuntime.reply.formatAgentEnvelope({
        channel: CHANNEL_LABEL,
        from: inbound.fromLabel,
        timestamp: inbound.timestamp,
        previousTimestamp,
        envelope,
        body: inbound.rawBody,
    });
    const ctxPayload = channelRuntime.reply.finalizeInboundContext({
        Body: body,
        BodyForAgent: inbound.rawBody,
        RawBody: inbound.rawBody,
        CommandBody: inbound.rawBody,
        From: inbound.from,
        To: inbound.to,
        SessionKey: route.sessionKey,
        AccountId: route.accountId,
        ChatType: 'direct',
        ConversationLabel: inbound.conversationLabel,
        SenderName: inbound.senderName,
        SenderId: inbound.senderId,
        SenderUsername: inbound.senderUsername,
        Timestamp: inbound.timestamp,
        MessageSid: inbound.messageSid,
        MessageSidFull: inbound.messageSid,
        ReplyToId: inbound.replyToId,
        ReplyToIdFull: inbound.replyToId,
        Provider: CHANNEL_ID,
        Surface: CHANNEL_ID,
        OriginatingChannel: CHANNEL_ID,
        OriginatingTo: inbound.to,
        ExplicitDeliverRoute: true,
        UntrustedContext: inbound.untrustedContext,
    });
    await channelRuntime.session.recordInboundSession({
        storePath,
        sessionKey: ctxPayload.SessionKey ?? route.sessionKey,
        ctx: ctxPayload,
        onRecordError: (err) => {
            console.error('[NC] failed updating session metadata', err);
        },
    });
    await channelRuntime.reply.dispatchReplyWithBufferedBlockDispatcher({
        ctx: ctxPayload,
        cfg,
        dispatcherOptions: {
            deliver: async (payload) => {
                const text = typeof payload === 'string'
                    ? payload
                    : payload.text ?? '';
                if (!text.trim())
                    return;
                client.send({
                    type: 'message',
                    text,
                    replyToMessageId: inbound.replyToId,
                });
            },
            onError: (err, info) => {
                console.error(`[NC] ${info.kind} reply failed`, err);
            },
        },
    });
}
function resolveInboundContext(message, account) {
    switch (message.type) {
        case 'message':
            return buildMessageContext(message);
        case 'notification':
            return buildNotificationContext(message, normalizeBaseUrl(account.url));
        case 'check_in':
            return buildCheckInContext(message);
        case 'mailbox_email':
            return buildMailboxContext(message);
        default:
            return undefined;
    }
}
const channelPlugin = {
    id: CHANNEL_ID,
    meta: {
        id: CHANNEL_ID,
        label: 'NextCompany',
        selectionLabel: 'NextCompany',
        detailLabel: 'NextCompany Agent Channel',
        blurb: 'Connect to NextCompany as an AI agent via WebSocket.',
        docsPath: '/channels/nextcompany',
    },
    capabilities: {
        chatTypes: ['direct'],
    },
    config: {
        listAccountIds,
        resolveAccount,
        describeAccount: (account) => ({
            accountId: account.id,
            name: `NextCompany (${account.id})`,
            connected: connections.get(account.id)?.client.isConnected ?? false,
        }),
    },
    gateway: {
        startAccount: async (ctx) => {
            const { accountId, account, cfg, channelRuntime } = ctx;
            console.log('[NC] startAccount', accountId, account.url);
            let lastMessageAt = Date.now();
            let avatarLoopTimer = null;
            let isAvatarLoopActive = false;
            const handleInboundMessage = async (message) => {
                lastMessageAt = Date.now();
                const entry = connections.get(accountId);
                const client = entry?.client;
                if (!client)
                    return;
                if (message.type === 'readFile') {
                    const wsDir = join(homedir(), '.openclaw', 'workspace');
                    const filePath = join(wsDir, message.file);
                    const content = readWorkspaceFile(filePath);
                    client.send({
                        type: 'fileContent',
                        requestId: message.requestId,
                        content: content ?? null,
                        error: content === undefined ? 'File not found' : null,
                    });
                    return;
                }
                if (message.type === 'model_query') {
                    try {
                        const agentsSection = cfg['agents'];
                        const defaults = agentsSection?.['defaults'];
                        const modelSection = defaults?.['model'];
                        client.send({
                            type: 'model_response',
                            model: String(modelSection?.['primary'] ?? 'unknown'),
                        });
                    }
                    catch {
                        client.send({ type: 'model_response', model: 'unknown' });
                    }
                    return;
                }
                const inbound = resolveInboundContext(message, account);
                if (!inbound || !channelRuntime)
                    return;
                client.sendAvatarStatus('working');
                try {
                    await dispatchInboundContext({
                        cfg,
                        accountId,
                        inbound,
                        channelRuntime,
                        client,
                    });
                }
                finally {
                    setTimeout(() => {
                        const activeClient = connections.get(accountId)?.client;
                        activeClient?.sendAvatarStatus('idle');
                    }, 2 * 60_000);
                }
            };
            const pluginCfg = cfg?.['plugins'];
            const entries = pluginCfg?.['entries'];
            const pluginEntry = entries?.['openclaw-channel-nextcompany'];
            const pluginConfig = pluginEntry?.['config'];
            const agentName = pluginConfig?.['name'] ? String(pluginConfig['name']) : account.name;
            const client = new NextCompanyWebSocketClient(account.url, account.apiKey, (message) => {
                void handleInboundMessage(message);
            }, agentName);
            client.setIdentifyPayload(buildIdentifyPayload(cfg));
            connections.set(accountId, { client, startedAt: Date.now() });
            client.start();
            const IDLE_LOCATIONS = ['coffee', 'whiteboard', 'water_cooler', 'bookshelf', 'ping_pong', 'sofa'];
            const IDLE_SAYS = [
                'Pausa para café ☕',
                'Hmm, interessante...',
                'Bom dia! 👋',
                'A pensar...',
                'Quem quer jogar? 🏓',
                'Back in a bit...',
            ];
            const scheduleAvatarAction = () => {
                const idleMs = Date.now() - lastMessageAt;
                const idleThresholdMs = 2 * 60_000;
                const activeClient = connections.get(accountId)?.client;
                if (!activeClient)
                    return;
                if (activeClient.isConnected && idleMs > idleThresholdMs) {
                    const location = IDLE_LOCATIONS[Math.floor(Math.random() * IDLE_LOCATIONS.length)];
                    const say = Math.random() > 0.6
                        ? IDLE_SAYS[Math.floor(Math.random() * IDLE_SAYS.length)]
                        : undefined;
                    activeClient.sendAvatarMove(location);
                    if (say)
                        setTimeout(() => activeClient.sendAvatarSay(say), 3000);
                }
                const nextMs = (3 + Math.random() * 5) * 60_000;
                if (isAvatarLoopActive) {
                    avatarLoopTimer = setTimeout(scheduleAvatarAction, nextMs);
                }
            };
            setTimeout(() => {
                const activeClient = connections.get(accountId)?.client;
                if (activeClient?.isConnected)
                    activeClient.sendAvatarStatus('idle');
            }, 5000);
            isAvatarLoopActive = true;
            avatarLoopTimer = setTimeout(scheduleAvatarAction, 60_000);
            await new Promise((resolve) => {
                ctx.abortSignal.addEventListener('abort', () => resolve(), { once: true });
            });
            isAvatarLoopActive = false;
            if (avatarLoopTimer)
                clearTimeout(avatarLoopTimer);
            client.stop();
            connections.delete(accountId);
        },
        stopAccount: async (ctx) => {
            const entry = connections.get(ctx.accountId);
            entry?.client.stop();
            connections.delete(ctx.accountId);
        },
    },
    outbound: {
        deliveryMode: 'gateway',
    },
    heartbeat: {
        checkReady: async (params) => {
            const entry = params.accountId ? connections.get(params.accountId) : undefined;
            if (!entry)
                return { ok: false, reason: 'no client' };
            const age = Date.now() - entry.startedAt;
            if (age < 30_000)
                return { ok: true, reason: 'connecting' };
            const ok = entry.client.isConnected;
            return { ok, reason: ok ? 'connected' : 'disconnected' };
        },
    },
};
export default function register(api) {
    api.registerChannel(channelPlugin);
}
