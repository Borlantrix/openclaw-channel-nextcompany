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
function buildNextCompanyApiUrl(account, path) {
    const baseUrl = normalizeBaseUrl(account.url).replace(/\/+$/, '');
    return `${baseUrl}${path.startsWith('/') ? path : `/${path}`}`;
}
function serializeTransitionBody(body) {
    const payload = Object.fromEntries(Object.entries({
        metadataJson: body.metadataJson,
        sessionKey: body.sessionKey,
        error: body.error,
        occurredAt: body.occurredAt,
    }).filter(([, value]) => value !== undefined));
    return Object.keys(payload).length > 0 ? JSON.stringify(payload) : undefined;
}
async function nextCompanyApiRequest(params) {
    const response = await fetch(buildNextCompanyApiUrl(params.account, params.path), {
        method: params.method ?? 'GET',
        headers: {
            Authorization: `Bearer ${params.account.apiKey}`,
            Accept: 'application/json',
            ...(params.body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: params.body,
    });
    if (!response.ok) {
        const responseText = await response.text().catch(() => '');
        throw new Error(`NextCompany API ${params.method ?? 'GET'} ${params.path} failed: ${response.status}${responseText ? ` ${responseText}` : ''}`);
    }
    if (response.status === 204)
        return undefined;
    return await response.json();
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
function workItemPayloadField(payload, key) {
    return payload?.[key];
}
function notificationField(message, camel, pascal) {
    return message[camel]
        ?? (pascal ? message[pascal] : undefined);
}
function wakeField(message, camel, pascal) {
    return message[camel]
        ?? (pascal ? message[pascal] : undefined);
}
function resolveReferencedWorkItemId(message) {
    if (message.type === 'agent_wake') {
        return wakeField(message, 'workItemId', 'WorkItemId')?.trim();
    }
    return notificationField(message, 'workItemId', 'WorkItemId')?.trim();
}
function formatNotificationSummary(message) {
    const sourceType = normalizeLabel(notificationField(message, 'sourceType', 'SourceType'), 'work item');
    const title = normalizeLabel(notificationField(message, 'sourceTitle', 'SourceTitle'), 'Untitled');
    const actor = notificationField(message, 'actorName', 'ActorName')?.trim();
    const kind = notificationField(message, 'kind', 'Kind') ?? 'Notification';
    switch (kind) {
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
                ? `${actor} triggered ${kind} on ${sourceType} "${title}".`
                : `${kind} on ${sourceType} "${title}".`;
    }
}
function resolveNotificationMetadata(message) {
    const metadata = message.metadata ?? message.Metadata ?? {};
    return {
        ...metadata,
        tableId: notificationField(message, 'tableId', 'TableId') ?? metadata.tableId,
        commentId: notificationField(message, 'commentId', 'CommentId') ?? metadata.commentId,
        triggerKind: notificationField(message, 'triggerKind', 'TriggerKind') ?? metadata.triggerKind,
        entityKind: notificationField(message, 'entityKind', 'EntityKind') ?? metadata.entityKind,
        entityId: notificationField(message, 'entityId', 'EntityId') ?? metadata.entityId,
        threadId: notificationField(message, 'threadId', 'ThreadId') ?? metadata.threadId,
        conversationId: notificationField(message, 'conversationId', 'ConversationId') ?? metadata.conversationId,
        mailboxId: notificationField(message, 'mailboxId', 'MailboxId') ?? metadata.mailboxId,
        occurrenceId: notificationField(message, 'occurrenceId', 'OccurrenceId') ?? metadata.occurrenceId,
        checkInId: notificationField(message, 'checkInId', 'CheckInId') ?? metadata.checkInId,
    };
}
function resolveNotificationEntityUrl(params) {
    const { baseUrl, message, metadata } = params;
    const actionUrl = notificationField(message, 'actionUrl', 'ActionUrl');
    const projectId = notificationField(message, 'projectId', 'ProjectId');
    const sourceType = notificationField(message, 'sourceType', 'SourceType');
    const sourceId = notificationField(message, 'sourceId', 'SourceId');
    if (actionUrl?.trim()) {
        if (/^https?:\/\//i.test(actionUrl))
            return actionUrl;
        return `${baseUrl}${actionUrl.startsWith('/') ? '' : '/'}${actionUrl}`;
    }
    switch (normalizeToken(sourceType)) {
        case 'card':
            if (projectId && metadata.tableId) {
                return `${baseUrl}/projects/${projectId}/boards/${metadata.tableId}/cards/${sourceId}`;
            }
            return undefined;
        case 'task':
            return projectId && sourceId ? `${baseUrl}/projects/${projectId}/tasks/${sourceId}` : undefined;
        case 'post':
            return projectId && sourceId ? `${baseUrl}/projects/${projectId}/posts/${sourceId}` : undefined;
        default:
            return undefined;
    }
}
function resolveWorkItemEntityUrl(params) {
    const { baseUrl, workItem } = params;
    const actionUrl = workItemPayloadField(workItem.payload, 'actionUrl');
    const tableId = workItemPayloadField(workItem.payload, 'tableId');
    if (actionUrl?.trim()) {
        if (/^https?:\/\//i.test(actionUrl))
            return actionUrl;
        return `${baseUrl}${actionUrl.startsWith('/') ? '' : '/'}${actionUrl}`;
    }
    switch (normalizeToken(workItem.sourceType)) {
        case 'card':
            return workItem.projectId && tableId
                ? `${baseUrl}/projects/${workItem.projectId}/boards/${tableId}/cards/${workItem.sourceId}`
                : undefined;
        case 'task':
            return workItem.projectId && workItem.sourceId
                ? `${baseUrl}/projects/${workItem.projectId}/tasks/${workItem.sourceId}`
                : undefined;
        case 'post':
            return workItem.projectId && workItem.sourceId
                ? `${baseUrl}/projects/${workItem.projectId}/posts/${workItem.sourceId}`
                : undefined;
        default:
            return undefined;
    }
}
function buildWorkItemSummary(workItem) {
    const title = normalizeLabel(workItemPayloadField(workItem.payload, 'sourceTitle'), 'Untitled');
    const sourceType = normalizeLabel(workItem.sourceType, 'work item');
    const actor = workItemPayloadField(workItem.payload, 'actorName')?.trim();
    const triggerKind = normalizeLabel(workItem.triggerKind, 'Notification');
    switch (triggerKind) {
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
                ? `${actor} triggered ${triggerKind} on ${sourceType} "${title}".`
                : `${triggerKind} on ${sourceType} "${title}".`;
    }
}
function buildWorkItemContext(workItem, account) {
    const payload = workItem.payload;
    const sourceTitle = workItemPayloadField(payload, 'sourceTitle');
    const actorName = workItemPayloadField(payload, 'actorName');
    const excerpt = workItemPayloadField(payload, 'excerpt');
    const entityType = normalizeToken(workItemPayloadField(payload, 'entityKind') ?? workItem.sourceType, 'notification');
    const entityId = normalizeToken(workItemPayloadField(payload, 'entityId') ?? workItem.sourceId ?? workItem.id, 'unknown');
    const projectId = normalizeToken(workItem.projectId, 'project');
    const actionUrl = resolveWorkItemEntityUrl({ baseUrl: normalizeBaseUrl(account.url), workItem });
    const peerId = `${entityType}:${projectId}:${entityId}`;
    const rawBody = [
        buildWorkItemSummary(workItem),
        excerpt?.trim() ? `Excerpt:\n${excerpt.trim()}` : undefined,
    ]
        .filter((line) => Boolean(line))
        .join('\n\n');
    return {
        rawBody,
        from: actorName?.trim()
            ? `nextcompany:actor:${normalizeToken(actorName)}`
            : 'nextcompany:system',
        fromLabel: normalizeLabel(actorName, CHANNEL_LABEL),
        to: `nextcompany:${peerId}`,
        peerId,
        conversationLabel: `${normalizeLabel(workItem.sourceType, 'Work')}: ${normalizeLabel(sourceTitle, 'Untitled')}`,
        timestamp: toTimestamp(workItem.createdAt),
        messageSid: workItem.commentId ?? workItem.notificationId ?? workItem.id,
        replyToId: workItem.commentId ?? workItem.notificationId ?? workItem.id,
        senderName: normalizeLabel(actorName, CHANNEL_LABEL),
        senderId: actorName?.trim() ? normalizeToken(actorName) : 'system',
        untrustedContext: joinContextLines([
            `Work item id: ${workItem.id}`,
            `Status: ${workItem.status}`,
            `Trigger kind: ${workItem.triggerKind}`,
            `Entity type: ${normalizeLabel(workItem.sourceType, 'unknown')}`,
            `Entity id: ${workItem.sourceId}`,
            `Project id: ${workItem.projectId}`,
            workItem.commentId ? `Comment id: ${workItem.commentId}` : undefined,
            workItem.notificationId ? `Notification id: ${workItem.notificationId}` : undefined,
            workItem.correlationKey ? `Correlation key: ${workItem.correlationKey}` : undefined,
            workItem.sessionKey ? `Existing session key: ${workItem.sessionKey}` : undefined,
            workItemPayloadField(payload, 'tableId') ? `Table id: ${workItemPayloadField(payload, 'tableId')}` : undefined,
            workItemPayloadField(payload, 'threadId') ? `Thread id: ${workItemPayloadField(payload, 'threadId')}` : undefined,
            workItemPayloadField(payload, 'conversationId') ? `Conversation id: ${workItemPayloadField(payload, 'conversationId')}` : undefined,
            workItemPayloadField(payload, 'mailboxId') ? `Mailbox id: ${workItemPayloadField(payload, 'mailboxId')}` : undefined,
            workItemPayloadField(payload, 'occurrenceId') ? `Occurrence id: ${workItemPayloadField(payload, 'occurrenceId')}` : undefined,
            workItemPayloadField(payload, 'checkInId') ? `Check-in id: ${workItemPayloadField(payload, 'checkInId')}` : undefined,
            actionUrl ? `Open in NextCompany: ${actionUrl}` : undefined,
        ]),
        workItemId: workItem.id,
        sessionKey: workItem.sessionKey ?? undefined,
    };
}
function buildNotificationContext(message, baseUrl) {
    const metadata = resolveNotificationMetadata(message);
    const sourceType = notificationField(message, 'sourceType', 'SourceType');
    const sourceId = notificationField(message, 'sourceId', 'SourceId');
    const sourceTitle = notificationField(message, 'sourceTitle', 'SourceTitle');
    const projectIdRaw = notificationField(message, 'projectId', 'ProjectId');
    const messageId = notificationField(message, 'id', 'Id');
    const kind = notificationField(message, 'kind', 'Kind');
    const actorName = notificationField(message, 'actorName', 'ActorName');
    const projectName = notificationField(message, 'projectName', 'ProjectName');
    const excerpt = notificationField(message, 'excerpt', 'Excerpt');
    const createdAt = notificationField(message, 'createdAt', 'CreatedAt');
    const entityType = normalizeToken(metadata.entityKind ?? sourceType, 'notification');
    const entityId = normalizeToken(metadata.entityId ?? sourceId ?? messageId, 'unknown');
    const projectId = normalizeToken(projectIdRaw, 'project');
    const peerId = `${entityType}:${projectId}:${entityId}`;
    const actionUrl = resolveNotificationEntityUrl({ baseUrl, message, metadata });
    const rawBody = [
        formatNotificationSummary(message),
        excerpt?.trim() ? `Excerpt:\n${excerpt.trim()}` : undefined,
    ]
        .filter((line) => Boolean(line))
        .join('\n\n');
    return {
        rawBody,
        from: actorName?.trim()
            ? `nextcompany:actor:${normalizeToken(actorName)}`
            : 'nextcompany:system',
        fromLabel: normalizeLabel(actorName, CHANNEL_LABEL),
        to: `nextcompany:${peerId}`,
        peerId,
        conversationLabel: `${normalizeLabel(sourceType, 'Work')}: ${normalizeLabel(sourceTitle, 'Untitled')}`,
        timestamp: toTimestamp(createdAt),
        messageSid: metadata.commentId ?? messageId,
        replyToId: metadata.commentId ?? messageId,
        senderName: normalizeLabel(actorName, CHANNEL_LABEL),
        senderId: actorName?.trim() ? normalizeToken(actorName) : 'system',
        untrustedContext: joinContextLines([
            `Notification kind: ${kind}`,
            metadata.triggerKind ? `Trigger kind: ${metadata.triggerKind}` : undefined,
            `Entity type: ${normalizeLabel(sourceType, 'unknown')}`,
            sourceId ? `Entity id: ${sourceId}` : undefined,
            projectName ? `Project: ${projectName}` : `Project id: ${projectIdRaw}`,
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
async function fetchAgentWorkItem(account, workItemId) {
    return await nextCompanyApiRequest({
        account,
        path: `/api/agents/me/inbox/${workItemId}`,
    });
}
async function transitionAgentWorkItem(params) {
    return await nextCompanyApiRequest({
        account: params.account,
        path: `/api/agent-work-items/${params.workItemId}/${params.action}`,
        method: 'POST',
        body: serializeTransitionBody(params.body ?? {}),
    });
}
async function resolveInboundContext(message, account) {
    const referencedWorkItemId = (message.type === 'agent_wake' || message.type === 'notification') ? resolveReferencedWorkItemId(message) : undefined;
    if (referencedWorkItemId) {
        if (message.type === 'agent_wake') {
            await transitionAgentWorkItem({
                account,
                workItemId: referencedWorkItemId,
                action: 'delivered',
                body: {
                    metadataJson: JSON.stringify({
                        transport: 'websocket',
                        state: 'received-by-plugin',
                        messageType: message.type,
                        wakeReason: wakeField(message, 'wakeReason', 'WakeReason'),
                    }),
                },
            });
        }
        const workItem = await fetchAgentWorkItem(account, referencedWorkItemId);
        return buildWorkItemContext(workItem, account);
    }
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
async function dispatchInboundContext(params) {
    const { cfg, accountId, account, inbound, channelRuntime, client } = params;
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
    const resolvedSessionKey = route.sessionKey ?? inbound.sessionKey;
    if (inbound.workItemId) {
        await transitionAgentWorkItem({
            account,
            workItemId: inbound.workItemId,
            action: 'ack',
            body: {
                sessionKey: resolvedSessionKey,
                metadataJson: JSON.stringify({
                    transport: 'openclaw-plugin',
                    state: 'accepted-for-routing',
                    accountId,
                }),
            },
        });
        await transitionAgentWorkItem({
            account,
            workItemId: inbound.workItemId,
            action: 'claim',
            body: {
                sessionKey: resolvedSessionKey,
                metadataJson: JSON.stringify({
                    transport: 'openclaw-plugin',
                    state: 'dispatching-to-runtime',
                    accountId,
                    agentId: route.agentId,
                }),
            },
        });
    }
    const ctxPayload = channelRuntime.reply.finalizeInboundContext({
        Body: body,
        BodyForAgent: inbound.rawBody,
        RawBody: inbound.rawBody,
        CommandBody: inbound.rawBody,
        From: inbound.from,
        To: inbound.to,
        SessionKey: resolvedSessionKey,
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
        sessionKey: ctxPayload.SessionKey ?? resolvedSessionKey,
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
                try {
                    const inbound = await resolveInboundContext(message, account);
                    if (!inbound || !channelRuntime)
                        return;
                    client.sendAvatarStatus('working');
                    await dispatchInboundContext({
                        cfg,
                        accountId,
                        account,
                        inbound,
                        channelRuntime,
                        client,
                    });
                }
                catch (err) {
                    console.error('[NC] inbound handling failed', {
                        accountId,
                        messageType: message.type,
                        err,
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
