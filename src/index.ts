import { execSync, spawn } from 'child_process';
import { existsSync, readdirSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import type { ChannelPlugin, OpenClawConfig, OpenClawPluginApi } from 'openclaw/plugin-sdk';
import { createAccountListHelpers } from 'openclaw/plugin-sdk';
import type {
  InboundMessage,
  NextCompanyAccountConfig,
  NextCompanyAgentWakeMessage,
  NextCompanyAgentWorkItem,
  NextCompanyAgentWorkItemPayload,
  NextCompanyCheckInMessage,
  NextCompanyDirectMessage,
  NextCompanyMailboxEmailMessage,
  NextCompanyNotificationMessage,
  NextCompanyNotificationMetadata,
} from './types.js';
import { NextCompanyWebSocketClient } from './websocket.js';

const CHANNEL_ID = 'nextcompany';
const CHANNEL_LABEL = 'NextCompany';
const connections = new Map<string, { client: NextCompanyWebSocketClient; startedAt: number }>();

const { listAccountIds, resolveDefaultAccountId } = createAccountListHelpers(CHANNEL_ID);
type StartAccountContext = Parameters<
  NonNullable<NonNullable<ChannelPlugin<NextCompanyAccountConfig>['gateway']>['startAccount']>
>[0];
type ChannelRuntime = NonNullable<StartAccountContext['channelRuntime']>;

interface RoutedInboundContext {
  rawBody: string;
  from: string;
  fromLabel: string;
  to: string;
  peerId: string;
  conversationLabel: string;
  timestamp?: number;
  messageSid?: string;
  replyToId?: string;
  senderName?: string;
  senderId?: string;
  senderUsername?: string;
  untrustedContext?: string[];
  workItemId?: string;
  sessionKey?: string;
  workItem?: NextCompanyAgentWorkItem;
}

interface NextCompanyTransitionBody {
  metadataJson?: string;
  sessionKey?: string;
  error?: string;
  occurredAt?: string;
}

interface GithubPrExecutorConfig {
  enabled?: boolean;
  mode?: 'codex' | 'command';
  command?: string;
  args?: string[];
  timeoutMs?: number;
  repoMap?: Record<string, string>;
}

interface GithubPrExecutionResult {
  prUrl: string;
  prNumber: number;
  branchName?: string;
  changedFilesCount?: number;
}

function getAccounts(cfg: OpenClawConfig): Record<string, NextCompanyAccountConfig> {
  const ch = (cfg as Record<string, unknown>)['channels'] as Record<string, unknown> | undefined;
  const nc = ch?.[CHANNEL_ID] as Record<string, unknown> | undefined;
  const accounts = nc?.['accounts'] as Record<string, unknown> | undefined;
  if (!accounts) return {};

  const result: Record<string, NextCompanyAccountConfig> = {};
  for (const [id, value] of Object.entries(accounts)) {
    const account = value as Record<string, unknown>;
    result[id] = {
      id,
      apiKey: String(account['apiKey'] ?? ''),
      url: String(account['url'] ?? ''),
      name: account['name'] ? String(account['name']) : undefined,
    };
  }
  return result;
}

function getPluginConfig(cfg: OpenClawConfig): Record<string, unknown> {
  const plugins = (cfg as Record<string, unknown>)['plugins'] as Record<string, unknown> | undefined;
  const entries = plugins?.['entries'] as Record<string, unknown> | undefined;
  const pluginEntry = entries?.['openclaw-channel-nextcompany'] as Record<string, unknown> | undefined;
  return (pluginEntry?.['config'] as Record<string, unknown> | undefined) ?? {};
}

function resolveAccount(cfg: OpenClawConfig, accountId?: string | null): NextCompanyAccountConfig {
  const accounts = getAccounts(cfg);
  const id = accountId ?? resolveDefaultAccountId(cfg);
  return accounts[id] ?? { id: id ?? 'default', apiKey: '', url: '' };
}

function getOpenClawVersion(): string | undefined {
  try {
    return execSync('openclaw --version 2>/dev/null', { timeout: 5000 }).toString().trim();
  } catch {
    return undefined;
  }
}

function getLatestOpenClawVersion(): string | undefined {
  try {
    return execSync('npm view openclaw version 2>/dev/null', { timeout: 10000 }).toString().trim();
  } catch {
    return undefined;
  }
}

function getWorkspaceFiles(): string[] {
  const wsDir = join(homedir(), '.openclaw', 'workspace');
  if (!existsSync(wsDir)) return [];

  const files: string[] = [];
  try {
    for (const file of readdirSync(wsDir)) {
      if (file.endsWith('.md')) files.push(file);
    }
    for (const subdir of ['memory', 'docs']) {
      const dir = join(wsDir, subdir);
      if (!existsSync(dir)) continue;
      for (const file of readdirSync(dir)) {
        if (file.endsWith('.md')) files.push(`${subdir}/${file}`);
      }
    }
    const downloadsDir = join(wsDir, 'downloads');
    if (existsSync(downloadsDir)) {
      for (const file of readdirSync(downloadsDir)) {
        files.push(`downloads/${file}`);
      }
    }
  } catch {
    return files;
  }

  return files;
}

function readWorkspaceFile(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf-8');
  } catch {
    return undefined;
  }
}

function extractField(content: string, field: string): string | undefined {
  const regex = new RegExp(`\\*\\*${field}:\\*\\*\\s*(.+)`, 'i');
  const match = content.match(regex);
  return match?.[1]?.trim();
}

function buildIdentifyPayload(cfg: OpenClawConfig): Record<string, unknown> {
  const version = getOpenClawVersion();
  const latestVersion = getLatestOpenClawVersion();
  const workspaceFiles = getWorkspaceFiles();

  const wsDir = join(homedir(), '.openclaw', 'workspace');
  let email: string | undefined;
  let gitHubUsername: string | undefined;

  const identityPath = join(wsDir, 'IDENTITY.md');
  if (existsSync(identityPath)) {
    const content = readWorkspaceFile(identityPath) ?? '';
    email = extractField(content, 'Email');
    gitHubUsername = extractField(content, 'GitHub Team') ?? extractField(content, 'GitHub');
  }

  const toolsPath = join(wsDir, 'TOOLS.md');
  if (existsSync(toolsPath)) {
    const content = readWorkspaceFile(toolsPath) ?? '';
    if (!gitHubUsername) gitHubUsername = extractField(content, 'Conta autenticada');
    if (!email) email = extractField(content, 'Email');
  }

  const channels: { name: string; enabled: boolean }[] = [];
  const clis: { name: string; label: string; version: string }[] = [];
  const plugins: { name: string; enabled: boolean }[] = [];
  const skills: { name: string; source: string; description: string; enabled: boolean }[] = [];
  const cronJobs: { name: string; schedule: string; enabled: boolean; type: string }[] = [];

  const cfgAny = cfg as Record<string, unknown>;
  const channelSection = cfgAny['channels'] as Record<string, unknown> | undefined;
  if (channelSection) {
    for (const [name, value] of Object.entries(channelSection)) {
      const channel = value as Record<string, unknown>;
      channels.push({ name, enabled: channel['enabled'] !== false });
    }
  }

  const pluginSection = (cfgAny['plugins'] as Record<string, unknown>)?.['entries'] as Record<string, unknown> | undefined;
  if (pluginSection) {
    for (const [name, value] of Object.entries(pluginSection)) {
      const plugin = value as Record<string, unknown>;
      plugins.push({ name, enabled: plugin['enabled'] !== false });
    }
  }

  const heartbeat = cfgAny['heartbeat'] as Record<string, unknown> | undefined;
  if (heartbeat) {
    cronJobs.push({
      name: 'Heartbeat',
      schedule: String(heartbeat['interval'] ?? '5m'),
      enabled: heartbeat['enabled'] !== false,
      type: 'heartbeat',
    });
  }

  let activeModel: string | undefined;
  try {
    const agentsSection = cfgAny['agents'] as Record<string, unknown> | undefined;
    const defaults = agentsSection?.['defaults'] as Record<string, unknown> | undefined;
    const modelSection = defaults?.['model'] as Record<string, unknown> | undefined;
    activeModel = modelSection?.['primary'] as string | undefined;
  } catch {
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

function normalizeBaseUrl(url: string): string {
  return url
    .replace(/^wss:\/\//, 'https://')
    .replace(/^ws:\/\//, 'http://')
    .replace(/\/ws\/agents\/?$/, '');
}

function buildNextCompanyApiUrl(account: NextCompanyAccountConfig, path: string): string {
  const baseUrl = normalizeBaseUrl(account.url).replace(/\/+$/, '');
  return `${baseUrl}${path.startsWith('/') ? path : `/${path}`}`;
}

function serializeTransitionBody(body: NextCompanyTransitionBody): string | undefined {
  const payload = Object.fromEntries(
    Object.entries({
      metadataJson: body.metadataJson,
      sessionKey: body.sessionKey,
      error: body.error,
      occurredAt: body.occurredAt,
    }).filter(([, value]) => value !== undefined),
  );
  return Object.keys(payload).length > 0 ? JSON.stringify(payload) : undefined;
}

function getGithubPrExecutorConfig(cfg: OpenClawConfig): GithubPrExecutorConfig {
  const pluginConfig = getPluginConfig(cfg);
  const raw = pluginConfig['githubPrExecutor'] as Record<string, unknown> | undefined;
  const repoMapRaw = raw?.['repoMap'] as Record<string, unknown> | undefined;
  const repoMap = repoMapRaw
    ? Object.fromEntries(Object.entries(repoMapRaw).map(([key, value]) => [key, String(value)]))
    : undefined;

  return {
    enabled: raw?.['enabled'] === undefined ? true : Boolean(raw['enabled']),
    mode: raw?.['mode'] === 'command' ? 'command' : 'codex',
    command: raw?.['command'] ? String(raw['command']) : undefined,
    args: Array.isArray(raw?.['args']) ? raw?.['args'].map((v) => String(v)) : undefined,
    timeoutMs: typeof raw?.['timeoutMs'] === 'number' ? (raw['timeoutMs'] as number) : 20 * 60_000,
    repoMap,
  };
}

function resolveRepoPath(repoSlug: string, cfg: OpenClawConfig): string {
  const executor = getGithubPrExecutorConfig(cfg);
  const mapped = executor.repoMap?.[repoSlug];
  if (mapped) return mapped;

  const repoName = repoSlug.split('/').pop() ?? repoSlug;
  return join(homedir(), '.openclaw', 'workspace', 'repos', repoName);
}

function commandExists(command: string): boolean {
  try {
    execSync(`command -v ${command} >/dev/null 2>&1`, { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

function parseJsonObject(text: string): Record<string, unknown> {
  const trimmed = text.trim();
  if (!trimmed) throw new Error('Executor returned empty output.');

  try {
    return JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    const match = trimmed.match(/\{[\s\S]*\}/);
    if (!match) throw new Error(`Executor output is not valid JSON: ${trimmed.slice(0, 500)}`);
    return JSON.parse(match[0]) as Record<string, unknown>;
  }
}

async function runProcessJson(params: {
  command: string;
  args: string[];
  cwd: string;
  input: string;
  timeoutMs: number;
}): Promise<Record<string, unknown>> {
  return await new Promise((resolve, reject) => {
    const child = spawn(params.command, params.args, {
      cwd: params.cwd,
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, params.timeoutMs);

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timeout);
      if (timedOut) {
        reject(new Error(`Executor timed out after ${params.timeoutMs}ms.`));
        return;
      }
      if (code !== 0) {
        reject(new Error(`Executor exited with code ${code}. ${stderr || stdout}`.trim()));
        return;
      }

      try {
        resolve(parseJsonObject(stdout));
      } catch (error) {
        reject(error);
      }
    });

    child.stdin.write(params.input);
    child.stdin.end();
  });
}

async function nextCompanyApiRequest<T>(params: {
  account: NextCompanyAccountConfig;
  path: string;
  method?: 'GET' | 'POST';
  body?: string;
}): Promise<T> {
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

  if (response.status === 204) return undefined as T;
  return await response.json() as T;
}

function normalizeToken(value: string | undefined, fallback = 'unknown'): string {
  const normalized = (value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._:-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return normalized || fallback;
}

function normalizeLabel(value: string | undefined, fallback: string): string {
  const trimmed = value?.trim();
  return trimmed ? trimmed : fallback;
}

function toTimestamp(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function joinContextLines(lines: Array<string | undefined>): string[] {
  return lines
    .map((line) => line?.trim())
    .filter((line): line is string => Boolean(line));
}

function workItemPayloadField<T = string>(payload: NextCompanyAgentWorkItemPayload | undefined | null, key: keyof NextCompanyAgentWorkItemPayload): T | undefined {
  return payload?.[key] as T | undefined;
}

function notificationField<T = string>(message: NextCompanyNotificationMessage, camel: keyof NextCompanyNotificationMessage, pascal?: keyof NextCompanyNotificationMessage): T | undefined {
  return (message[camel] as T | undefined)
    ?? (pascal ? (message[pascal] as T | undefined) : undefined);
}

function wakeField<T = string>(message: NextCompanyAgentWakeMessage, camel: keyof NextCompanyAgentWakeMessage, pascal?: keyof NextCompanyAgentWakeMessage): T | undefined {
  return (message[camel] as T | undefined)
    ?? (pascal ? (message[pascal] as T | undefined) : undefined);
}

function resolveReferencedWorkItemId(message: NextCompanyNotificationMessage | NextCompanyAgentWakeMessage): string | undefined {
  if (message.type === 'agent_wake') {
    return wakeField(message, 'workItemId', 'WorkItemId')?.trim();
  }
  return notificationField(message, 'workItemId', 'WorkItemId')?.trim();
}

function formatNotificationSummary(message: NextCompanyNotificationMessage): string {
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

function resolveNotificationMetadata(message: NextCompanyNotificationMessage): NextCompanyNotificationMetadata {
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

function resolveNotificationEntityUrl(params: {
  baseUrl: string;
  message: NextCompanyNotificationMessage;
  metadata: NextCompanyNotificationMetadata;
}): string | undefined {
  const { baseUrl, message, metadata } = params;
  const actionUrl = notificationField(message, 'actionUrl', 'ActionUrl');
  const projectId = notificationField(message, 'projectId', 'ProjectId');
  const sourceType = notificationField(message, 'sourceType', 'SourceType');
  const sourceId = notificationField(message, 'sourceId', 'SourceId');

  if (actionUrl?.trim()) {
    if (/^https?:\/\//i.test(actionUrl)) return actionUrl;
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

function resolveWorkItemEntityUrl(params: {
  baseUrl: string;
  workItem: NextCompanyAgentWorkItem;
}): string | undefined {
  const { baseUrl, workItem } = params;
  const actionUrl = workItemPayloadField(workItem.payload, 'actionUrl');
  const tableId = workItemPayloadField(workItem.payload, 'tableId');

  if (actionUrl?.trim()) {
    if (/^https?:\/\//i.test(actionUrl)) return actionUrl;
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

function buildWorkItemSummary(workItem: NextCompanyAgentWorkItem): string {
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

function buildWorkItemContext(workItem: NextCompanyAgentWorkItem, account: NextCompanyAccountConfig): RoutedInboundContext {
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
    .filter((line): line is string => Boolean(line))
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
    workItem,
  };
}

function buildNotificationContext(message: NextCompanyNotificationMessage, baseUrl: string): RoutedInboundContext {
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
    .filter((line): line is string => Boolean(line))
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

function buildMessageContext(message: NextCompanyDirectMessage): RoutedInboundContext {
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

function buildCheckInContext(message: NextCompanyCheckInMessage): RoutedInboundContext {
  const peerId = `checkin:${normalizeToken(message.projectId)}:${normalizeToken(message.checkInId)}`;
  const rawBody = [
    `Check-in question: ${message.question.trim()}`,
    message.description?.trim() ? `Details:\n${message.description.trim()}` : undefined,
  ]
    .filter((line): line is string => Boolean(line))
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

function buildMailboxContext(message: NextCompanyMailboxEmailMessage): RoutedInboundContext {
  const mailboxScope = normalizeToken(
    message.threadId ?? message.conversationId ?? message.messageId,
    normalizeToken(message.messageId),
  );
  const peerId = `mailbox:${normalizeToken(message.accountId)}:${mailboxScope}`;
  const preview = message.bodyText?.trim() || message.snippet?.trim();
  const rawBody = [
    `Email from ${normalizeLabel(message.fromName, message.from)}`,
    `Subject: ${message.subject.trim()}`,
    preview ? `Preview:\n${preview}` : undefined,
  ]
    .filter((line): line is string => Boolean(line))
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

async function fetchAgentWorkItem(account: NextCompanyAccountConfig, workItemId: string): Promise<NextCompanyAgentWorkItem> {
  return await nextCompanyApiRequest<NextCompanyAgentWorkItem>({
    account,
    path: `/api/agents/me/inbox/${workItemId}`,
  });
}

async function transitionAgentWorkItem(params: {
  account: NextCompanyAccountConfig;
  workItemId: string;
  action: 'delivered' | 'ack' | 'claim' | 'start' | 'complete' | 'fail';
  body?: NextCompanyTransitionBody;
}): Promise<NextCompanyAgentWorkItem> {
  return await nextCompanyApiRequest<NextCompanyAgentWorkItem>({
    account: params.account,
    path: `/api/agent-work-items/${params.workItemId}/${params.action}`,
    method: 'POST',
    body: serializeTransitionBody(params.body ?? {}),
  });
}

interface NextCompanyProjectTask {
  id: string;
  taskListId: string;
  projectId: string;
  isCompleted: boolean;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function plainTextToHtml(value: string): string {
  const normalized = value.replace(/\r\n/g, '\n').trim();
  if (!normalized) return '';

  return normalized
    .split(/\n\s*\n/)
    .map((paragraph) => `<p>${escapeHtml(paragraph).replace(/\n/g, '<br/>')}</p>`)
    .join('');
}

function resolveTaskRouteFromWorkItem(workItem: NextCompanyAgentWorkItem): { projectId: string; listId: string; taskId: string } | undefined {
  let projectId = workItem.projectId?.trim();
  let taskId = workItem.sourceId?.trim();
  let listId: string | undefined;
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
    } catch {
      // Ignore malformed URLs and fall back to work-item fields.
    }
  }

  if (!projectId || !taskId || !listId) return undefined;
  return { projectId, listId, taskId };
}

async function fetchTask(account: NextCompanyAccountConfig, projectId: string, listId: string, taskId: string): Promise<NextCompanyProjectTask> {
  return await nextCompanyApiRequest<NextCompanyProjectTask>({
    account,
    path: `/api/projects/${projectId}/task-lists/${listId}/tasks/${taskId}`,
  });
}

async function createTaskComment(params: {
  account: NextCompanyAccountConfig;
  projectId: string;
  taskId: string;
  text: string;
}): Promise<void> {
  const body = plainTextToHtml(params.text);
  if (!body.trim()) return;

  await nextCompanyApiRequest({
    account: params.account,
    path: `/api/projects/${params.projectId}/tasks/${params.taskId}/comments`,
    method: 'POST',
    body: JSON.stringify({ body }),
  });
}

async function completeTaskIfNeeded(params: {
  account: NextCompanyAccountConfig;
  projectId: string;
  listId: string;
  taskId: string;
}): Promise<void> {
  const task = await fetchTask(params.account, params.projectId, params.listId, params.taskId);
  if (task.isCompleted) return;

  await nextCompanyApiRequest({
    account: params.account,
    path: `/api/projects/${params.projectId}/task-lists/${params.listId}/tasks/${params.taskId}/toggle`,
    method: 'POST',
  });
}

async function persistTaskReplyAndComplete(params: {
  account: NextCompanyAccountConfig;
  workItem: NextCompanyAgentWorkItem;
  text: string;
}): Promise<{ projectId: string; listId: string; taskId: string }> {
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

async function fetchExecutionContext(account: NextCompanyAccountConfig, cardId: string): Promise<Record<string, unknown> | undefined> {
  try {
    return await nextCompanyApiRequest<Record<string, unknown>>({
      account,
      path: `/api/agents/me/execution-context?cardId=${encodeURIComponent(cardId)}`,
    });
  } catch {
    return undefined;
  }
}

function buildCodexGithubPrPrompt(params: {
  workItem: NextCompanyAgentWorkItem;
  repoPath: string;
  executionContext?: Record<string, unknown>;
}): string {
  const payload = params.workItem.payload ?? {};
  const card = params.executionContext?.['card'] as Record<string, unknown> | undefined;
  const currentStage = params.executionContext?.['currentStage'] as Record<string, unknown> | undefined;
  const board = params.executionContext?.['board'] as Record<string, unknown> | undefined;

  const cardTitle = String(card?.['title'] ?? payload.title ?? 'Untitled');
  const cardDescription = typeof card?.['description'] === 'string' ? card['description'] : '';
  const stageInstructions = typeof currentStage?.['agentInstructions'] === 'string' ? currentStage['agentInstructions'] : '';
  const boardPrompt = typeof board?.['agentPrompt'] === 'string' ? board['agentPrompt'] : '';

  return [
    'You are executing a NextCompany github_pr work item.',
    `Repository slug: ${payload.repositorySlug ?? 'unknown'}`,
    `Local repository path: ${params.repoPath}`,
    `Card id: ${payload.cardId ?? params.workItem.sourceId}`,
    `Card title: ${cardTitle}`,
    cardDescription ? `Card description:\n${cardDescription}` : undefined,
    `Base branch: ${String(payload.baseBranch ?? 'main')}`,
    payload.branchPrefix ? `Branch prefix: ${payload.branchPrefix}` : undefined,
    payload.bodyTemplate ? `PR body template:\n${payload.bodyTemplate}` : undefined,
    boardPrompt ? `Board prompt:\n${boardPrompt}` : undefined,
    stageInstructions ? `Stage instructions:\n${stageInstructions}` : undefined,
    '',
    'Requirements:',
    '- Make the requested change in the local repository.',
    '- Use git and gh to create a real GitHub PR against the base branch.',
    '- Run focused validation when relevant.',
    '- Commit and push your branch.',
    '- Output ONLY a single JSON object and no markdown.',
    '- On success output: {"prUrl":"...","prNumber":123,"branchName":"...","changedFilesCount":4}',
    '- On failure output: {"error":"clear reason"}',
  ].filter(Boolean).join('\n');
}

async function executeGithubPrWorkItem(params: {
  cfg: OpenClawConfig;
  account: NextCompanyAccountConfig;
  inbound: RoutedInboundContext;
  sessionKey: string;
}): Promise<GithubPrExecutionResult> {
  const workItem = params.inbound.workItem;
  if (!workItem) throw new Error('Missing work item context for github_pr execution.');

  const payload = workItem.payload ?? {};
  const repoSlug = payload.repositorySlug;
  if (!repoSlug) throw new Error('github_pr payload is missing repositorySlug.');

  const repoPath = resolveRepoPath(repoSlug, params.cfg);
  if (!existsSync(repoPath)) throw new Error(`Local repository path not found for ${repoSlug}: ${repoPath}`);

  const executor = getGithubPrExecutorConfig(params.cfg);
  if (executor.enabled === false) {
    throw new Error('github_pr executor is disabled in plugin configuration.');
  }

  const executionContext = payload.cardId ? await fetchExecutionContext(params.account, payload.cardId) : undefined;

  let rawResult: Record<string, unknown>;
  if (executor.mode === 'command' && executor.command) {
    rawResult = await runProcessJson({
      command: executor.command,
      args: executor.args ?? [],
      cwd: repoPath,
      timeoutMs: executor.timeoutMs ?? 20 * 60_000,
      input: JSON.stringify({
        workItem,
        sessionKey: params.sessionKey,
        repoPath,
        executionContext,
      }),
    });
  } else {
    if (!commandExists('codex')) {
      throw new Error('github_pr executor is not configured and Codex CLI is unavailable.');
    }

    rawResult = await runProcessJson({
      command: 'codex',
      args: ['exec', '--skip-git-repo-check', '--dangerously-bypass-approvals-and-sandbox', buildCodexGithubPrPrompt({
        workItem,
        repoPath,
        executionContext,
      })],
      cwd: repoPath,
      timeoutMs: executor.timeoutMs ?? 20 * 60_000,
      input: '',
    });
  }

  if (typeof rawResult['error'] === 'string' && rawResult['error'].trim()) {
    throw new Error(String(rawResult['error']).trim());
  }

  const prUrl = rawResult['prUrl'];
  const prNumber = rawResult['prNumber'];
  if (typeof prUrl !== 'string' || !prUrl.trim()) throw new Error('Executor did not return prUrl.');
  if (typeof prNumber !== 'number' || prNumber <= 0) throw new Error('Executor did not return a valid prNumber.');

  return {
    prUrl: prUrl.trim(),
    prNumber,
    branchName: typeof rawResult['branchName'] === 'string' ? rawResult['branchName'] : undefined,
    changedFilesCount: typeof rawResult['changedFilesCount'] === 'number' ? rawResult['changedFilesCount'] : undefined,
  };
}

async function resolveInboundContext(message: InboundMessage, account: NextCompanyAccountConfig): Promise<RoutedInboundContext | undefined> {
  const referencedWorkItemId = (
    message.type === 'agent_wake' || message.type === 'notification'
  ) ? resolveReferencedWorkItemId(message) : undefined;

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

async function dispatchInboundContext(params: {
  cfg: OpenClawConfig;
  accountId: string;
  account: NextCompanyAccountConfig;
  inbound: RoutedInboundContext;
  channelRuntime: ChannelRuntime;
  client: NextCompanyWebSocketClient;
}): Promise<void> {
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

    if (inbound.workItem?.triggerKind === 'execute_github_pr') {
      try {
        const result = await executeGithubPrWorkItem({
          cfg,
          account,
          inbound,
          sessionKey: resolvedSessionKey,
        });

        await transitionAgentWorkItem({
          account,
          workItemId: inbound.workItemId,
          action: 'complete',
          body: {
            sessionKey: resolvedSessionKey,
            metadataJson: JSON.stringify({
              transport: 'openclaw-plugin',
              state: 'executor-completed',
              prUrl: result.prUrl,
              prNumber: result.prNumber,
              branchName: result.branchName,
              changedFilesCount: result.changedFilesCount,
            }),
          },
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await transitionAgentWorkItem({
          account,
          workItemId: inbound.workItemId,
          action: 'fail',
          body: {
            sessionKey: resolvedSessionKey,
            error: message,
            metadataJson: JSON.stringify({
              transport: 'openclaw-plugin',
              state: 'executor-failed',
            }),
          },
        });
      }
      return;
    }
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
          : (payload as { text?: string; replyToId?: string }).text ?? '';
        if (!text.trim()) return;

        try {
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
          });
        } catch (error) {
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
            } catch (transitionError) {
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

const channelPlugin: ChannelPlugin<NextCompanyAccountConfig> = {
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
    describeAccount: (account: NextCompanyAccountConfig) => ({
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
      let avatarLoopTimer: ReturnType<typeof setTimeout> | null = null;
      let isAvatarLoopActive = false;

      const handleInboundMessage = async (message: InboundMessage) => {
        lastMessageAt = Date.now();
        const entry = connections.get(accountId);
        const client = entry?.client;
        if (!client) return;

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
            const agentsSection = (cfg as Record<string, unknown>)['agents'] as Record<string, unknown> | undefined;
            const defaults = agentsSection?.['defaults'] as Record<string, unknown> | undefined;
            const modelSection = defaults?.['model'] as Record<string, unknown> | undefined;
            client.send({
              type: 'model_response',
              model: String(modelSection?.['primary'] ?? 'unknown'),
            });
          } catch {
            client.send({ type: 'model_response', model: 'unknown' });
          }
          return;
        }

        try {
          const inbound = await resolveInboundContext(message, account);
          if (!inbound || !channelRuntime) return;

          client.sendAvatarStatus('working');
          await dispatchInboundContext({
            cfg,
            accountId,
            account,
            inbound,
            channelRuntime,
            client,
          });
        } catch (err) {
          console.error('[NC] inbound handling failed', {
            accountId,
            messageType: message.type,
            err,
          });
        } finally {
          setTimeout(() => {
            const activeClient = connections.get(accountId)?.client;
            activeClient?.sendAvatarStatus('idle');
          }, 2 * 60_000);
        }
      };

      const pluginCfg = (cfg as Record<string, unknown>)?.['plugins'] as Record<string, unknown> | undefined;
      const entries = pluginCfg?.['entries'] as Record<string, unknown> | undefined;
      const pluginEntry = entries?.['openclaw-channel-nextcompany'] as Record<string, unknown> | undefined;
      const pluginConfig = pluginEntry?.['config'] as Record<string, unknown> | undefined;
      const agentName = pluginConfig?.['name'] ? String(pluginConfig['name']) : account.name;

      const client = new NextCompanyWebSocketClient(account.url, account.apiKey, (message) => {
        void handleInboundMessage(message);
      }, agentName);

      client.setIdentifyPayload(buildIdentifyPayload(cfg));
      connections.set(accountId, { client, startedAt: Date.now() });
      client.start();

      const IDLE_LOCATIONS = ['coffee', 'whiteboard', 'water_cooler', 'bookshelf', 'ping_pong', 'sofa'] as const;
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
        if (!activeClient) return;

        if (activeClient.isConnected && idleMs > idleThresholdMs) {
          const location = IDLE_LOCATIONS[Math.floor(Math.random() * IDLE_LOCATIONS.length)];
          const say = Math.random() > 0.6
            ? IDLE_SAYS[Math.floor(Math.random() * IDLE_SAYS.length)]
            : undefined;
          activeClient.sendAvatarMove(location);
          if (say) setTimeout(() => activeClient.sendAvatarSay(say), 3000);
        }

        const nextMs = (3 + Math.random() * 5) * 60_000;
        if (isAvatarLoopActive) {
          avatarLoopTimer = setTimeout(scheduleAvatarAction, nextMs);
        }
      };

      setTimeout(() => {
        const activeClient = connections.get(accountId)?.client;
        if (activeClient?.isConnected) activeClient.sendAvatarStatus('idle');
      }, 5000);

      isAvatarLoopActive = true;
      avatarLoopTimer = setTimeout(scheduleAvatarAction, 60_000);

      await new Promise<void>((resolve) => {
        ctx.abortSignal.addEventListener('abort', () => resolve(), { once: true });
      });

      isAvatarLoopActive = false;
      if (avatarLoopTimer) clearTimeout(avatarLoopTimer);
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
      if (!entry) return { ok: false, reason: 'no client' };

      const age = Date.now() - entry.startedAt;
      if (age < 30_000) return { ok: true, reason: 'connecting' };

      const ok = entry.client.isConnected;
      return { ok, reason: ok ? 'connected' : 'disconnected' };
    },
  },
};

export default function register(api: OpenClawPluginApi) {
  api.registerChannel(channelPlugin);
}
