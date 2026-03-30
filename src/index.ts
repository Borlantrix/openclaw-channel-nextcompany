import type { OpenClawConfig, OpenClawPluginApi, ChannelPlugin } from 'openclaw/plugin-sdk';
import { createAccountListHelpers } from 'openclaw/plugin-sdk/account-helpers';
import { NextCompanyWebSocketClient } from './websocket.js';
import type { NextCompanyAccountConfig, InboundMessage } from './types.js';
import { execSync } from 'child_process';
import { readdirSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const connections = new Map<string, NextCompanyWebSocketClient>();

const { listAccountIds, resolveDefaultAccountId } = createAccountListHelpers('nextcompany');

function getAccounts(cfg: OpenClawConfig): Record<string, NextCompanyAccountConfig> {
  const ch = (cfg as Record<string, unknown>)['channels'] as Record<string, unknown> | undefined;
  const nc = ch?.['nextcompany'] as Record<string, unknown> | undefined;
  const accounts = nc?.['accounts'] as Record<string, unknown> | undefined;
  if (!accounts) return {};
  const result: Record<string, NextCompanyAccountConfig> = {};
  for (const [id, v] of Object.entries(accounts)) {
    const a = v as Record<string, unknown>;
    result[id] = { id, apiKey: String(a['apiKey'] ?? ''), url: String(a['url'] ?? ''), name: a['name'] ? String(a['name']) : undefined };
  }
  return result;
}

function resolveAccount(cfg: OpenClawConfig, accountId?: string | null): NextCompanyAccountConfig {
  const accounts = getAccounts(cfg);
  const id = accountId ?? resolveDefaultAccountId(cfg);
  return accounts[id] ?? { id: id ?? 'default', apiKey: '', url: '' };
}

function getOpenClawVersion(): string | undefined {
  try { return execSync('openclaw --version 2>/dev/null', { timeout: 5000 }).toString().trim(); } catch { return undefined; }
}

function getLatestOpenClawVersion(): string | undefined {
  try { return execSync('npm view openclaw version 2>/dev/null', { timeout: 10000 }).toString().trim(); } catch { return undefined; }
}

function getWorkspaceFiles(): string[] {
  const wsDir = join(homedir(), '.openclaw', 'workspace');
  if (!existsSync(wsDir)) return [];
  const files: string[] = [];
  try {
    // Root .md files
    for (const f of readdirSync(wsDir)) {
      if (f.endsWith('.md')) files.push(f);
    }
    // memory/ and docs/ — .md only
    for (const subdir of ['memory', 'docs']) {
      const dir = join(wsDir, subdir);
      if (existsSync(dir)) {
        for (const f of readdirSync(dir)) {
          if (f.endsWith('.md')) files.push(`${subdir}/${f}`);
        }
      }
    }
    // downloads/ — all files (images, PDFs, etc.)
    const downloadsDir = join(wsDir, 'downloads');
    if (existsSync(downloadsDir)) {
      for (const f of readdirSync(downloadsDir)) {
        files.push(`downloads/${f}`);
      }
    }
  } catch { /* ignore */ }
  return files;
}

function readWorkspaceFile(path: string): string | undefined {
  try { return readFileSync(path, 'utf-8'); } catch { return undefined; }
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

  // Read email and GitHub from IDENTITY.md and TOOLS.md
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

  // Read tools from OpenClaw config
  const channels: { name: string; enabled: boolean }[] = [];
  const clis: { name: string; label: string; version: string }[] = [];
  const plugins: { name: string; enabled: boolean }[] = [];
  const skills: { name: string; source: string; description: string; enabled: boolean }[] = [];

  const cfgAny = cfg as Record<string, unknown>;
  // Channels
  const chSection = cfgAny['channels'] as Record<string, unknown> | undefined;
  if (chSection) {
    for (const [name, v] of Object.entries(chSection)) {
      const ch = v as Record<string, unknown>;
      channels.push({ name, enabled: ch['enabled'] !== false });
    }
  }
  // Plugins
  const plSection = (cfgAny['plugins'] as Record<string, unknown>)?.['entries'] as Record<string, unknown> | undefined;
  if (plSection) {
    for (const [name, v] of Object.entries(plSection)) {
      const pl = v as Record<string, unknown>;
      plugins.push({ name, enabled: pl['enabled'] !== false });
    }
  }

  // Cron jobs
  const cronJobs: { name: string; schedule: string; enabled: boolean; type: string }[] = [];
  const heartbeat = cfgAny['heartbeat'] as Record<string, unknown> | undefined;
  if (heartbeat) {
    cronJobs.push({ name: 'Heartbeat', schedule: String(heartbeat['interval'] ?? '5m'), enabled: heartbeat['enabled'] !== false, type: 'heartbeat' });
  }

  return {
    version,
    latestVersion,
    workspaceFiles,
    email,
    gitHubUsername,
    cronJobs,
    tools: { channels, clis, plugins, skills },
  };
}

const channelPlugin: ChannelPlugin<NextCompanyAccountConfig> = {
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
    chatTypes: ['direct'],
  },

  config: {
    listAccountIds,
    resolveAccount,
    describeAccount: (account: NextCompanyAccountConfig) => ({
      accountId: account.id,
      name: `NextCompany (${account.id})`,
      connected: connections.get(account.id)?.isConnected ?? false,
    }),
  },

  gateway: {
    startAccount: async (ctx) => {
      const { accountId, account, cfg } = ctx;
      console.log("[NC] startAccount called for", accountId, "url:", account.url);
      const channelRuntime = ctx.channelRuntime;

      const onMessage = async (msg: InboundMessage) => {
        // Handle file read requests from the backend
        if (msg.type === 'readFile') {
          const wsDir = join(homedir(), '.openclaw', 'workspace');
          const filePath = join(wsDir, msg.file);
          const content = readWorkspaceFile(filePath);
          const client = connections.get(accountId);
          client?.send({
            type: 'fileContent',
            requestId: msg.requestId,
            content: content ?? null,
            error: content === undefined ? 'File not found' : null,
          });
          return;
        }

        if (msg.type === 'notification') {
          if (!channelRuntime) return;
          // Backend now sends flattened payload (fields directly on msg)
          const p = msg;
          const baseUrl = account.url.replace('/ws/agents', '').replace('wss://', 'https://');
          const apiKey = account.apiKey;

          // Build notification text based on kind
          let notifText: string;
          if (p.kind === 'Assigned') {
            notifText = `[NextCompany] You were assigned to ${p.sourceType}: "${p.sourceTitle}"`;
            if (p.actorName) notifText += ` by ${p.actorName}`;
            notifText += `.`;
          } else if (p.kind === 'Mention') {
            notifText = `[NextCompany] You were mentioned in ${p.sourceType}: "${p.sourceTitle}"`;
            if (p.actorName) notifText += ` by ${p.actorName}`;
            notifText += `.`;
          } else if (p.kind === 'NewPost') {
            notifText = `[NextCompany] New post: "${p.sourceTitle}"`;
            if (p.actorName) notifText += ` by ${p.actorName}`;
            notifText += `.`;
          } else if (p.kind === 'Comment') {
            notifText = `[NextCompany] New comment on ${p.sourceType}: "${p.sourceTitle}"`;
            if (p.actorName) notifText += ` by ${p.actorName}`;
            notifText += `.`;
          } else {
            notifText = `[NextCompany] ${p.kind} notification: "${p.sourceTitle}"`;
            if (p.actorName) notifText += ` by ${p.actorName}`;
            notifText += `.`;
          }
          if (p.excerpt) notifText += `\n\nExcerpt: ${p.excerpt}`;
          notifText += `\n\n⚠️ IMPORTANT: Do NOT use the message tool to respond. You MUST use the exec tool with curl to post your comment directly to the NextCompany API.`;

          // Build correct API URLs based on sourceType
          let readUrl: string;
          let commentUrl: string;
          if (p.sourceType === 'Task') {
            const taskId = p.sourceId;
            readUrl = `${baseUrl}/api/projects/${p.projectId}/tasks/${taskId}/comments`;
            commentUrl = readUrl;
            notifText += `\n\nTo read the task comments, run:`;
            notifText += `\ncurl -s -H "X-Api-Key: ${apiKey}" "${readUrl}" | python3 -m json.tool`;
          } else if (p.sourceType === 'Card') {
            const cardId = p.sourceId;
            // Extract tableId from actionUrl: /projects/{pid}/card-tables/{tableId}/cards/{cardId}
            const tableMatch = (p.actionUrl ?? '').match(/card-tables\/([0-9a-fA-F-]{36})/);
            const tableId = tableMatch ? tableMatch[1] : '';
            readUrl = `${baseUrl}/api/projects/${p.projectId}/card-tables/${tableId}/cards/${cardId}/comments`;
            commentUrl = readUrl;
            notifText += `\n\nTo read the card comments, run:`;
            notifText += `\ncurl -s -H "X-Api-Key: ${apiKey}" "${readUrl}" | python3 -m json.tool`;
          } else {
            readUrl = `${baseUrl}/api/projects/${p.projectId}/posts/${p.sourceId}`;
            commentUrl = `${baseUrl}/api/projects/${p.projectId}/posts/${p.sourceId}/comments`;
            notifText += `\n\nTo read the full post, run:`;
            notifText += `\ncurl -s -H "X-Api-Key: ${apiKey}" "${readUrl}" | python3 -m json.tool`;
          }
          notifText += `\n\nTo post your comment, run:`;
          notifText += `\ncurl -s -X POST -H "X-Api-Key: ${apiKey}" -H "Content-Type: application/json" -d '{"body":"YOUR RESPONSE HERE"}' "${commentUrl}"`;
          notifText += `\n\nReplace YOUR RESPONSE HERE with your actual response. Write your comment in Portuguese. Respond thoughtfully to what was asked of you.`;

          const client = connections.get(accountId);
          await channelRuntime.reply.dispatchReplyWithBufferedBlockDispatcher({
            ctx: {
              Body: notifText,
              BodyForAgent: notifText,
              CommandBody: notifText,
            },
            cfg,
            dispatcherOptions: {
              deliver: async (payload) => {
                const text = typeof payload === 'string'
                  ? payload
                  : (payload as { text?: string }).text ?? '';
                client?.send({ type: 'message', text });
              },
            },
          });
          return;
        }

        if (msg.type !== 'message') return;
        if (!channelRuntime) return;

        const client = connections.get(accountId);

        await channelRuntime.reply.dispatchReplyWithBufferedBlockDispatcher({
          ctx: {
            Body: msg.text,
            BodyForAgent: msg.text,
            CommandBody: msg.text,
          },
          cfg,
          dispatcherOptions: {
            deliver: async (payload) => {
              const text = typeof payload === 'string'
                ? payload
                : (payload as { text?: string }).text ?? '';
              client?.send({ type: 'message', text, replyToMessageId: msg.messageId });
            },
          },
        });
      };

      // Agent name: from plugin config (plugins.entries.openclaw-channel-nextcompany.config.name)
      const pluginCfg = (cfg as Record<string, unknown>)?.['plugins'] as Record<string, unknown> | undefined;
      const entries = pluginCfg?.['entries'] as Record<string, unknown> | undefined;
      const pluginEntry = entries?.['openclaw-channel-nextcompany'] as Record<string, unknown> | undefined;
      const pluginConfig = pluginEntry?.['config'] as Record<string, unknown> | undefined;
      const agentName = pluginConfig?.['name'] ? String(pluginConfig['name']) : account.name;

      const client = new NextCompanyWebSocketClient(account.url, account.apiKey, onMessage, agentName);

      // Build identify payload with version, tools, workspace files, email, github
      const identifyPayload = buildIdentifyPayload(cfg);
      client.setIdentifyPayload(identifyPayload);

      connections.set(accountId, client);
      client.start();
      const startedAt = Date.now();

      // ── Avatar autonomous behaviour ────────────────────────────────────────
      // When idle (no incoming message in the last N minutes), the agent moves
      // around the Virtual Office autonomously.
      const IDLE_LOCATIONS = [
        'coffee', 'whiteboard', 'water_cooler', 'bookshelf', 'ping_pong', 'sofa',
      ] as const;
      const IDLE_SAYS: string[] = [
        'Pausa para café ☕', 'Hmm, interessante...', 'Bom dia! 👋',
        'A pensar...', 'Quem quer jogar? 🏓', 'Back in a bit...',
      ];

      let lastMessageAt = Date.now();
      let avatarLoopTimer: ReturnType<typeof setTimeout> | null = null;
      let isAvatarLoopActive = false;

      // Track when messages arrive — resets idle clock
      const origOnMessage = onMessage;
      const wrappedOnMessage = async (msg: InboundMessage) => {
        lastMessageAt = Date.now();
        // Entering working mode
        client.sendAvatarStatus('working');
        await origOnMessage(msg);
        // After replying, back to idle after 2 min
        setTimeout(() => client.sendAvatarStatus('idle'), 2 * 60_000);
      };
      // Patch the client — re-register with the wrapped handler
      (client as unknown as Record<string, unknown>)['onMessage'] = wrappedOnMessage;

      const scheduleAvatarAction = () => {
        const idleMs = Date.now() - lastMessageAt;
        const IDLE_THRESHOLD = 2 * 60_000; // 2 minutes

        if (client.isConnected && idleMs > IDLE_THRESHOLD) {
          const loc = IDLE_LOCATIONS[Math.floor(Math.random() * IDLE_LOCATIONS.length)];
          const say = Math.random() > 0.6
            ? IDLE_SAYS[Math.floor(Math.random() * IDLE_SAYS.length)]
            : null;
          client.sendAvatarMove(loc);
          if (say) setTimeout(() => client.sendAvatarSay(say), 3000);
        }

        // Next action: 3–8 minutes
        const nextMs = (3 + Math.random() * 5) * 60_000;
        if (isAvatarLoopActive) {
          avatarLoopTimer = setTimeout(scheduleAvatarAction, nextMs);
        }
      };

      // Mark as idle initially (so frontend knows we're alive and controlled by plugin)
      setTimeout(() => {
        if (client.isConnected) client.sendAvatarStatus('idle');
      }, 5000);

      // Start avatar loop after 1 min
      isAvatarLoopActive = true;
      avatarLoopTimer = setTimeout(scheduleAvatarAction, 1 * 60_000);

      // startAccount must be a long-running function — it should only return when the
      // channel account is stopped. OpenClaw interprets a return as "account exited"
      // and schedules an auto-restart. We wait for the abortSignal (fired by stopAccount
      // or gateway shutdown) to cleanly exit.
      const abortSignal = (ctx as Record<string, unknown>)['abortSignal'] as AbortSignal | undefined;
      if (abortSignal) {
        await new Promise<void>((resolve) => {
          abortSignal.addEventListener('abort', () => resolve(), { once: true });
        });
      } else {
        // Fallback: wait indefinitely (until stopAccount clears the connection map)
        await new Promise<void>((resolve) => {
          const interval = setInterval(() => {
            if (!connections.has(accountId)) {
              clearInterval(interval);
              resolve();
            }
          }, 1000);
        });
      }
      isAvatarLoopActive = false;
      if (avatarLoopTimer) clearTimeout(avatarLoopTimer);
      client.stop();
      connections.delete(accountId);
    },

    stopAccount: async (ctx) => {
      const client = connections.get(ctx.accountId);
      client?.stop();
      connections.delete(ctx.accountId);
    },
  },

  outbound: {
    deliveryMode: 'gateway',
  },

  heartbeat: {
    checkReady: async (params) => {
      const client = params.accountId ? connections.get(params.accountId) : undefined;
      if (!client) return { ok: false, reason: 'no client' };
      // Grace period: consider healthy for 30s after start to allow WS handshake
      const age = Date.now() - ((client as unknown as { startedAt?: number }).startedAt ?? Date.now());
      if (typeof age === 'number' && age < 30_000) return { ok: true, reason: 'connecting' };
      const ok = client.isConnected;
      return { ok, reason: ok ? 'connected' : 'disconnected' };
    },
  },
};

export default function register(api: OpenClawPluginApi) {
  api.registerChannel(channelPlugin);
}
