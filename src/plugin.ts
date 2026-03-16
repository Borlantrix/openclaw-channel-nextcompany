import { NextCompanyWebSocketClient } from './websocket.js';
import { type NextCompanyAccountConfig, type InboundMessage } from './types.js';

// Minimal ChannelPlugin shape — matches openclaw ChannelPlugin interface
// Full types available when openclaw is installed as peer dependency

const connections = new Map<string, NextCompanyWebSocketClient>();

function resolveAccount(cfg: unknown): NextCompanyAccountConfig {
  const c = cfg as Record<string, unknown>;
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
    resolveAccount: (raw: unknown) => resolveAccount(raw),
    validateAccount: (raw: unknown) => {
      const { id, apiKey, url } = resolveAccount(raw);
      if (!id) return { ok: false as const, error: 'Missing account id' };
      if (!apiKey) return { ok: false as const, error: 'Missing apiKey' };
      if (!url) return { ok: false as const, error: 'Missing url' };
      return { ok: true as const, account: resolveAccount(raw) };
    },
  },

  gateway: {
    startAccount: async (ctx: {
      accountId: string;
      account: NextCompanyAccountConfig;
      dispatch: (envelope: unknown) => void;
    }) => {
      const { accountId, account, dispatch } = ctx;

      const onMessage = (msg: InboundMessage) => {
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

        if (msg.type === 'notification') {
          // Payload is flattened — fields are directly on msg, not nested in msg.payload
          const baseUrl = account.url.replace('/ws/agents', '').replace('wss://', 'https://');

          // Build a human-readable notification message for the agent
          let notifText = `[NextCompany Notification] ${msg.kind}: "${msg.sourceTitle}"`;
          if (msg.actorName) notifText += ` — by ${msg.actorName}`;
          if (msg.excerpt) notifText += `\n\n${msg.excerpt}`;
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

    stopAccount: async (ctx: { accountId: string }) => {
      const client = connections.get(ctx.accountId);
      client?.stop();
      connections.delete(ctx.accountId);
    },
  },

  outbound: {
    sendMessage: async (ctx: {
      accountId: string;
      text: string;
      replyToMessageId?: string;
    }) => {
      const client = connections.get(ctx.accountId);
      if (!client) throw new Error(`No active connection for account ${ctx.accountId}`);
      client.send({ type: 'message', text: ctx.text, replyToMessageId: ctx.replyToMessageId });
    },
  },

  heartbeat: {
    checkReady: async (ctx: { accountId: string }) => {
      const client = connections.get(ctx.accountId);
      const ok = client?.isConnected ?? false;
      return { ok, reason: ok ? 'connected' : 'disconnected' };
    },
  },
};
