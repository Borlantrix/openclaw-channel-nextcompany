import { existsSync, readdirSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { createAccountListHelpers } from 'openclaw/plugin-sdk/account-helpers';
import { buildDirectImageSource, extractHtmlImageSources, resolveImageAttachmentConfig, resolveImageAttachments, } from './media.js';
import { parseOutboundMediaMessage, uploadChatAttachment } from './outbound.js';
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
function getPluginConfig(cfg) {
    const plugins = cfg['plugins'];
    const entries = plugins?.['entries'];
    const pluginEntry = entries?.['openclaw-channel-nextcompany'];
    return pluginEntry?.['config'] ?? {};
}
function resolveAccount(cfg, accountId) {
    const accounts = getAccounts(cfg);
    const id = accountId ?? resolveDefaultAccountId(cfg);
    return accounts[id] ?? { id: id ?? 'default', apiKey: '', url: '' };
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
            'X-Api-Key': params.account.apiKey,
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
async function nextCompanyApiRawRequest(params) {
    let url;
    try {
        url = new URL(params.urlOrPath, params.baseUrl);
        const base = new URL(params.baseUrl);
        if (url.origin !== base.origin)
            return undefined;
    }
    catch {
        return undefined;
    }
    return await fetch(url.toString(), {
        method: 'GET',
        headers: {
            'X-Api-Key': params.account.apiKey,
            Authorization: `Bearer ${params.account.apiKey}`,
            Accept: 'application/json, text/html',
        },
    });
}
function extractHtmlFromUnknown(value, preferredId) {
    if (typeof value === 'string')
        return value.trim() ? value : undefined;
    if (!value || typeof value !== 'object')
        return undefined;
    if (Array.isArray(value)) {
        const preferred = preferredId
            ? value.find((item) => objectStringField(item, 'id', 'Id') === preferredId)
            : undefined;
        const preferredHtml = preferred ? extractHtmlFromUnknown(preferred, preferredId) : undefined;
        if (preferredHtml)
            return preferredHtml;
        for (const item of value) {
            const html = extractHtmlFromUnknown(item, preferredId);
            if (html)
                return html;
        }
        return undefined;
    }
    const record = value;
    for (const key of ['htmlBody', 'bodyHtml', 'commentHtml', 'sourceHtml', 'body', 'Body']) {
        const candidate = record[key];
        if (typeof candidate === 'string' && candidate.trim())
            return candidate;
    }
    return undefined;
}
function objectStringField(value, ...keys) {
    if (!value || typeof value !== 'object')
        return undefined;
    const record = value;
    for (const key of keys) {
        const candidate = record[key];
        if (typeof candidate === 'string' && candidate.trim())
            return candidate;
    }
    return undefined;
}
async function fetchSourceHtml(params) {
    if (!params.urlOrPath?.trim())
        return undefined;
    try {
        const response = await nextCompanyApiRawRequest({
            account: params.account,
            baseUrl: params.baseUrl,
            urlOrPath: params.urlOrPath,
        });
        if (!response?.ok)
            return undefined;
        const contentType = response.headers.get('content-type') ?? '';
        if (contentType.toLowerCase().includes('application/json')) {
            return extractHtmlFromUnknown(await response.json(), params.preferredId);
        }
        return await response.text();
    }
    catch {
        return undefined;
    }
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
function workItemPayloadString(payload, key) {
    const value = workItemPayloadField(payload, key);
    return typeof value === 'string' && value.trim() ? value : undefined;
}
function collectWorkItemHtmlBodies(workItem) {
    const payload = workItem.payload;
    const html = [
        workItemPayloadString(payload, 'htmlBody'),
        workItemPayloadString(payload, 'bodyHtml'),
        workItemPayloadString(payload, 'commentHtml'),
        workItemPayloadString(payload, 'sourceHtml'),
    ].find((value) => value?.trim());
    if (!html)
        return [];
    return [{
            html,
            sourceKind: `${normalizeToken(workItem.sourceType)}_${normalizeToken(workItem.triggerKind)}_inline`,
        }];
}
function collectNotificationHtmlBodies(message) {
    const html = notificationField(message, 'htmlBody', 'HtmlBody')
        ?? notificationField(message, 'bodyHtml', 'BodyHtml');
    if (!html?.trim())
        return [];
    const sourceType = notificationField(message, 'sourceType', 'SourceType');
    const kind = notificationField(message, 'kind', 'Kind');
    return [{ html, sourceKind: `${normalizeToken(sourceType)}_${normalizeToken(kind)}_inline` }];
}
function decodeBasicHtmlEntities(value) {
    return value
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'");
}
function htmlToReadableText(html) {
    if (!html?.trim())
        return undefined;
    const text = decodeBasicHtmlEntities(html
        .replace(/<\/(p|div|li|h[1-6]|blockquote)>/gi, '\n')
        .replace(/<br\s*\/?\s*>/gi, '\n')
        .replace(/<li[^>]*>/gi, '- ')
        .replace(/<[^>]+>/g, '')
        .replace(/\r/g, '')
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .join('\n'));
    return text.trim() ? text : undefined;
}
async function fetchCardDetailForWorkItem(params) {
    if (normalizeToken(params.workItem.sourceType) !== 'card')
        return undefined;
    const tableId = workItemPayloadString(params.workItem.payload, 'tableId');
    const cardId = params.workItem.sourceId;
    if (!params.workItem.projectId || !tableId || !cardId)
        return undefined;
    try {
        return await nextCompanyApiRequest({
            account: params.account,
            path: `/api/projects/${params.workItem.projectId}/card-tables/${tableId}/cards/${cardId}`,
        });
    }
    catch (error) {
        console.error('[NC] failed to fetch card detail for work item', {
            workItemId: params.workItem.id,
            cardId,
            err: error,
        });
        return undefined;
    }
}
async function enrichCardWorkItemContext(params) {
    const card = await fetchCardDetailForWorkItem({ account: params.account, workItem: params.workItem });
    if (!card)
        return;
    const descriptionText = htmlToReadableText(card.description);
    const lines = joinContextLines([
        card.title?.trim() ? `Card title: ${card.title.trim()}` : undefined,
        card.columnName?.trim() ? `Column: ${card.columnName.trim()}` : undefined,
        !card.columnName?.trim() && card.columnId?.trim() ? `Column id: ${card.columnId.trim()}` : undefined,
        card.dueDate?.trim() ? `Due date: ${card.dueDate.trim()}` : undefined,
        descriptionText ? `Card description:\n${descriptionText}` : undefined,
    ]);
    if (lines.length > 0) {
        params.inbound.rawBody = joinContextLines([params.inbound.rawBody, lines.join('\n')]).join('\n\n');
    }
    if (card.description?.trim()) {
        params.inbound.htmlBodies = [
            ...(params.inbound.htmlBodies ?? []),
            { html: card.description, sourceKind: 'card_description_inline' },
        ];
    }
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
    if (normalizeToken(triggerKind) === 'execute_github_pr') {
        return `Execute GitHub PR work item for ${sourceType} "${title}".`;
    }
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
function buildExecutionWorkItemBody(workItem) {
    const payload = workItem.payload;
    if (normalizeToken(workItem.triggerKind) !== 'execute_github_pr')
        return undefined;
    const repositorySlug = workItemPayloadString(payload, 'repositorySlug');
    const baseBranch = workItemPayloadString(payload, 'baseBranch') ?? 'main';
    const branchPrefix = workItemPayloadString(payload, 'branchPrefix');
    const bodyTemplate = workItemPayloadString(payload, 'bodyTemplate');
    const title = normalizeLabel(workItemPayloadField(payload, 'sourceTitle') ?? workItemPayloadField(payload, 'title') ?? undefined, 'Untitled');
    const excerpt = workItemPayloadString(payload, 'excerpt');
    return joinContextLines([
        'Execution request: create a GitHub PR for this NextCompany card.',
        repositorySlug ? `Repository slug: ${repositorySlug}` : undefined,
        `Card id: ${workItem.sourceId}`,
        `Card title: ${title}`,
        `Base branch: ${baseBranch}`,
        branchPrefix ? `Branch prefix: ${branchPrefix}` : undefined,
        excerpt ? `Card excerpt:\n${excerpt}` : undefined,
        bodyTemplate ? `PR body template:\n${bodyTemplate}` : undefined,
        '',
        'Execution requirements:',
        '- Use the OpenClaw runtime/coding tools, not this channel plugin, to inspect the repository and make changes.',
        '- Create a branch from the requested base branch.',
        '- Implement the requested change, run focused validation, commit, push, and open a GitHub PR.',
        '- Reply with the PR URL, branch, validation performed, and any blockers.',
    ]).join('\n');
}
function buildWorkItemContext(workItem, account) {
    const payload = workItem.payload;
    const sourceTitle = workItemPayloadField(payload, 'sourceTitle');
    const actorName = workItemPayloadField(payload, 'actorName');
    const excerpt = workItemPayloadField(payload, 'excerpt');
    const executionBody = buildExecutionWorkItemBody(workItem);
    const entityType = normalizeToken(workItemPayloadField(payload, 'entityKind') ?? workItem.sourceType, 'notification');
    const entityId = normalizeToken(workItemPayloadField(payload, 'entityId') ?? workItem.sourceId ?? workItem.id, 'unknown');
    const projectId = normalizeToken(workItem.projectId, 'project');
    const actionUrl = resolveWorkItemEntityUrl({ baseUrl: normalizeBaseUrl(account.url), workItem });
    const peerId = `${entityType}:${projectId}:${entityId}`;
    const rawBody = [
        buildWorkItemSummary(workItem),
        executionBody,
        !executionBody && excerpt?.trim() ? `Excerpt:\n${excerpt.trim()}` : undefined,
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
            workItemPayloadString(payload, 'repositorySlug') ? `Repository slug: ${workItemPayloadString(payload, 'repositorySlug')}` : undefined,
            workItemPayloadString(payload, 'baseBranch') ? `Base branch: ${workItemPayloadString(payload, 'baseBranch')}` : undefined,
            workItemPayloadString(payload, 'branchPrefix') ? `Branch prefix: ${workItemPayloadString(payload, 'branchPrefix')}` : undefined,
            workItemPayloadField(payload, 'threadId') ? `Thread id: ${workItemPayloadField(payload, 'threadId')}` : undefined,
            workItemPayloadField(payload, 'conversationId') ? `Conversation id: ${workItemPayloadField(payload, 'conversationId')}` : undefined,
            workItemPayloadField(payload, 'mailboxId') ? `Mailbox id: ${workItemPayloadField(payload, 'mailboxId')}` : undefined,
            workItemPayloadField(payload, 'occurrenceId') ? `Occurrence id: ${workItemPayloadField(payload, 'occurrenceId')}` : undefined,
            workItemPayloadField(payload, 'checkInId') ? `Check-in id: ${workItemPayloadField(payload, 'checkInId')}` : undefined,
            actionUrl ? `Open in NextCompany: ${actionUrl}` : undefined,
        ]),
        workItemId: workItem.id,
        sessionKey: workItem.sessionKey ?? undefined,
        workItem,
        htmlBodies: collectWorkItemHtmlBodies(workItem),
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
        htmlBodies: collectNotificationHtmlBodies(message),
    };
}
function buildMessageContext(message, baseUrl) {
    const senderId = normalizeToken(message.fromUserId ?? message.from ?? message.channelId, 'system');
    const senderName = normalizeLabel(message.fromName ?? message.senderName ?? message.from, 'NextCompany');
    const attachmentLine = message.attachmentUrl
        ? `Attachment: ${message.attachmentFileName ?? message.attachmentUrl}`
        : undefined;
    const directImage = buildDirectImageSource({
        url: message.attachmentUrl,
        baseUrl,
        sourceKind: 'chat_attachment',
        alt: message.attachmentFileName,
    });
    const html = message.htmlBody?.trim() || message.bodyHtml?.trim();
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
        channelId: message.channelId,
        senderName,
        senderId,
        senderUsername: message.from,
        untrustedContext: joinContextLines([
            message.channelId ? `Channel id: ${message.channelId}` : undefined,
            message.attachmentUrl ? `Attachment URL: ${message.attachmentUrl}` : undefined,
            message.attachmentContentType ? `Attachment content type: ${message.attachmentContentType}` : undefined,
        ]),
        htmlBodies: html ? [{ html, sourceKind: 'chat_message_inline' }] : undefined,
        directImageSources: directImage ? [directImage] : undefined,
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
function escapeHtml(value) {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}
function plainTextToHtml(value) {
    const normalized = value.replace(/\r\n/g, '\n').trim();
    if (!normalized)
        return '';
    return normalized
        .split(/\n\s*\n/)
        .map((paragraph) => `<p>${escapeHtml(paragraph).replace(/\n/g, '<br/>')}</p>`)
        .join('');
}
function resolveTaskRouteFromWorkItem(workItem) {
    let projectId = workItem.projectId?.trim();
    let taskId = workItem.sourceId?.trim();
    let listId;
    const actionUrl = workItemPayloadField(workItem.payload, 'actionUrl');
    if (actionUrl?.trim()) {
        try {
            const pathname = new URL(actionUrl, 'https://nextcompany.invalid').pathname;
            const parts = pathname.split('/').filter(Boolean);
            if (parts[0] === 'projects' && parts[2] === 'tasks') {
                projectId = projectId ?? parts[1];
                if (parts[4]) {
                    listId = parts[3];
                    taskId = taskId ?? parts[4];
                }
            }
        }
        catch {
            // Ignore malformed URLs and fall back to work-item fields.
        }
    }
    if (!projectId || !taskId || !listId)
        return undefined;
    return { projectId, listId, taskId };
}
async function fetchTask(account, projectId, listId, taskId) {
    return await nextCompanyApiRequest({
        account,
        path: `/api/projects/${projectId}/task-lists/${listId}/tasks/${taskId}`,
    });
}
async function createTaskComment(params) {
    const body = plainTextToHtml(params.text);
    if (!body.trim())
        return;
    await nextCompanyApiRequest({
        account: params.account,
        path: `/api/projects/${params.projectId}/tasks/${params.taskId}/comments`,
        method: 'POST',
        body: JSON.stringify({ body }),
    });
}
function resolveCardCommentPathFromWorkItem(workItem) {
    const payload = workItem.payload;
    const commentPostUrl = workItemPayloadString(payload, 'commentPostUrl');
    if (commentPostUrl)
        return commentPostUrl;
    const tableId = workItemPayloadString(payload, 'tableId');
    const cardId = workItem.sourceId;
    if (!workItem.projectId || !tableId || !cardId)
        return undefined;
    return `/api/projects/${workItem.projectId}/card-tables/${tableId}/cards/${cardId}/comments`;
}
async function createCardComment(params) {
    const path = resolveCardCommentPathFromWorkItem(params.workItem);
    if (!path) {
        throw new Error(`Unable to resolve card comment route for work item ${params.workItem.id}.`);
    }
    const body = plainTextToHtml(params.text);
    if (!body.trim())
        return;
    await nextCompanyApiRequest({
        account: params.account,
        path,
        method: 'POST',
        body: JSON.stringify({ body }),
    });
}
async function persistCardReply(params) {
    await createCardComment({
        account: params.account,
        workItem: params.workItem,
        text: params.text,
    });
}
async function completeTaskIfNeeded(params) {
    const task = await fetchTask(params.account, params.projectId, params.listId, params.taskId);
    if (task.isCompleted)
        return;
    await nextCompanyApiRequest({
        account: params.account,
        path: `/api/projects/${params.projectId}/task-lists/${params.listId}/tasks/${params.taskId}/toggle`,
        method: 'POST',
    });
}
async function persistTaskReplyAndComplete(params) {
    const taskRoute = resolveTaskRouteFromWorkItem(params.workItem);
    if (!taskRoute) {
        throw new Error(`Unable to resolve task route for work item ${params.workItem.id}.`);
    }
    await createTaskComment({
        account: params.account,
        projectId: taskRoute.projectId,
        taskId: taskRoute.taskId,
        text: params.text,
    });
    await completeTaskIfNeeded({
        account: params.account,
        projectId: taskRoute.projectId,
        listId: taskRoute.listId,
        taskId: taskRoute.taskId,
    });
    return taskRoute;
}
async function resolveInboundContext(message, account) {
    const baseUrl = normalizeBaseUrl(account.url);
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
        const inbound = buildWorkItemContext(workItem, account);
        await enrichCardWorkItemContext({ account, inbound, workItem });
        if (!inbound.htmlBodies?.length) {
            const fetchedHtml = await fetchSourceHtml({
                account,
                baseUrl,
                urlOrPath: workItemPayloadString(workItem.payload, 'sourceHtmlReadUrl')
                    ?? workItemPayloadString(workItem.payload, 'commentReadUrl'),
                preferredId: workItem.commentId,
            });
            if (fetchedHtml) {
                inbound.htmlBodies = [{
                        html: fetchedHtml,
                        sourceKind: `${normalizeToken(workItem.sourceType)}_${normalizeToken(workItem.triggerKind)}_inline`,
                    }];
            }
        }
        return inbound;
    }
    switch (message.type) {
        case 'message':
            return buildMessageContext(message, baseUrl);
        case 'notification':
            return buildNotificationContext(message, baseUrl);
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
    inbound.organizationId ??= connections.get(accountId)?.organizationId;
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
    const imageConfig = resolveImageAttachmentConfig(getPluginConfig(cfg));
    if (imageConfig.enabled && (!inbound.attachments || !inbound.attachmentsSkipped)) {
        const baseUrl = normalizeBaseUrl(account.url);
        const htmlSources = (inbound.htmlBodies ?? []).flatMap((entry) => (extractHtmlImageSources(entry.html, baseUrl, entry.sourceKind)));
        const directSources = inbound.directImageSources ?? [];
        try {
            const resolved = await resolveImageAttachments({
                account,
                baseUrl,
                sources: [...htmlSources, ...directSources],
                config: imageConfig,
            });
            inbound.attachments = resolved.attachments;
            inbound.attachmentsSkipped = resolved.skipped;
            if (resolved.attachments.length > 0 || resolved.skipped.length > 0) {
                console.log('[NC] image attachments processed', {
                    accountId,
                    messageSid: inbound.messageSid,
                    found: htmlSources.length + directSources.length,
                    attached: resolved.attachments.length,
                    skipped: resolved.skipped.length,
                });
            }
        }
        catch (error) {
            console.error('[NC] image attachment processing failed', {
                accountId,
                messageSid: inbound.messageSid,
                err: error,
            });
            inbound.attachments = [];
            inbound.attachmentsSkipped = [];
        }
    }
    const attachmentSummary = inbound.attachments?.length
        ? inbound.attachments.map((attachment) => `[image attached: ${attachment.fileName ?? attachment.mimeType} (${attachment.mimeType})]`).join('\n')
        : undefined;
    const agentBody = joinContextLines([attachmentSummary, inbound.rawBody]).join('\n\n');
    const envelope = channelRuntime.reply.resolveEnvelopeFormatOptions(cfg);
    const body = channelRuntime.reply.formatAgentEnvelope({
        channel: CHANNEL_LABEL,
        from: inbound.fromLabel,
        timestamp: inbound.timestamp,
        previousTimestamp,
        envelope,
        body: agentBody,
    });
    const resolvedSessionKey = route.sessionKey ?? inbound.sessionKey ?? inbound.peerId;
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
        await transitionAgentWorkItem({
            account,
            workItemId: inbound.workItemId,
            action: 'start',
            body: {
                sessionKey: resolvedSessionKey,
                metadataJson: JSON.stringify({
                    transport: 'openclaw-plugin',
                    state: 'runtime-dispatch-started',
                    accountId,
                    agentId: route.agentId,
                }),
            },
        });
    }
    const ctxPayload = channelRuntime.reply.finalizeInboundContext({
        Body: body,
        BodyForAgent: agentBody,
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
        ChannelId: inbound.channelId,
        Provider: CHANNEL_ID,
        Surface: CHANNEL_ID,
        OriginatingChannel: CHANNEL_ID,
        OriginatingTo: inbound.to,
        ExplicitDeliverRoute: true,
        UntrustedContext: joinContextLines([
            ...(inbound.untrustedContext ?? []),
            inbound.attachments?.length ? `Image attachments: ${inbound.attachments.length}` : undefined,
            inbound.attachmentsSkipped?.length ? `Image attachments skipped: ${inbound.attachmentsSkipped.length}` : undefined,
        ]),
        ...(inbound.attachments?.length ? { Attachments: inbound.attachments } : {}),
        ...(inbound.attachmentsSkipped?.length ? { AttachmentsSkipped: inbound.attachmentsSkipped } : {}),
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
                try {
                    const parsedMedia = parseOutboundMediaMessage(text);
                    if (parsedMedia.files.length > 0) {
                        const channelId = typeof payload === 'string'
                            ? inbound.channelId
                            : payload.channelId ?? inbound.channelId;
                        const organizationId = inbound.organizationId;
                        if (!channelId)
                            throw new Error('Cannot send outbound media without a NextCompany chat channelId.');
                        if (!organizationId)
                            throw new Error('Cannot send outbound media without a NextCompany organizationId.');
                        for (const [index, file] of parsedMedia.files.entries()) {
                            await uploadChatAttachment({
                                account,
                                organizationId,
                                channelId,
                                file,
                                text: index === 0 ? parsedMedia.text : undefined,
                            });
                        }
                        return;
                    }
                    if (inbound.workItem && normalizeToken(inbound.workItem.sourceType) === 'card') {
                        await persistCardReply({
                            account,
                            workItem: inbound.workItem,
                            text,
                        });
                        if (inbound.workItemId) {
                            await transitionAgentWorkItem({
                                account,
                                workItemId: inbound.workItemId,
                                action: 'complete',
                                body: {
                                    sessionKey: resolvedSessionKey,
                                    metadataJson: JSON.stringify({
                                        transport: 'openclaw-plugin',
                                        state: 'card-commented-and-completed',
                                        projectId: inbound.workItem.projectId,
                                        cardId: inbound.workItem.sourceId,
                                    }),
                                },
                            });
                        }
                        return;
                    }
                    if (inbound.workItem && normalizeToken(inbound.workItem.sourceType) === 'task') {
                        const taskRoute = await persistTaskReplyAndComplete({
                            account,
                            workItem: inbound.workItem,
                            text,
                        });
                        if (inbound.workItemId) {
                            await transitionAgentWorkItem({
                                account,
                                workItemId: inbound.workItemId,
                                action: 'complete',
                                body: {
                                    sessionKey: resolvedSessionKey,
                                    metadataJson: JSON.stringify({
                                        transport: 'openclaw-plugin',
                                        state: 'task-commented-and-completed',
                                        projectId: taskRoute.projectId,
                                        taskListId: taskRoute.listId,
                                        taskId: taskRoute.taskId,
                                    }),
                                },
                            });
                        }
                        return;
                    }
                    client.send({
                        type: 'message',
                        text,
                        replyToMessageId: inbound.replyToId,
                        channelId: inbound.channelId,
                    });
                }
                catch (error) {
                    if (inbound.workItemId) {
                        const message = error instanceof Error ? error.message : String(error);
                        try {
                            await transitionAgentWorkItem({
                                account,
                                workItemId: inbound.workItemId,
                                action: 'fail',
                                body: {
                                    sessionKey: resolvedSessionKey,
                                    error: message,
                                    metadataJson: JSON.stringify({
                                        transport: 'openclaw-plugin',
                                        state: 'reply-persistence-failed',
                                    }),
                                },
                            });
                        }
                        catch (transitionError) {
                            console.error('[NC] failed marking work item as failed', transitionError);
                        }
                    }
                    throw error;
                }
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
                if (message.type === 'connected') {
                    entry.organizationId = message.organizationId;
                    return;
                }
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
                    const runtime = channelRuntime;
                    client.sendAvatarStatus('working');
                    await dispatchInboundContext({
                        cfg,
                        accountId,
                        account,
                        inbound,
                        channelRuntime: runtime,
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
