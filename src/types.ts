// Protocol messages — NextCompany ↔ Agent

export type InboundMessage =
  | { type: 'connected'; agentId: string; agentName: string; organizationId: string; timestamp: string }
  | { type: 'identified'; name: string }
  | { type: 'message'; fromUserId?: string; fromName?: string; text: string; messageId?: string; timestamp?: string; from?: string; channelId?: string; senderName?: string; attachmentUrl?: string; attachmentFileName?: string; attachmentContentType?: string }
  | { type: 'notification'; kind: string; sourceType: string; sourceId: string; sourceTitle: string; excerpt?: string; actorName?: string; actorAvatarUrl?: string; actionUrl: string; projectId: string; projectName?: string; id?: string; isRead?: boolean; createdAt?: string }
  | { type: 'readFile'; file: string; requestId: string }
  | { type: 'model_query' }
  | { type: 'check_in'; occurrenceId: string; checkInId: string; projectId: string; question: string; description?: string; scheduledAt: string }
  | { type: 'mailbox_email'; messageId: string; accountId: string; from: string; fromName?: string; subject: string; snippet?: string; bodyText?: string; receivedAt: string }
  | { type: 'pong' };

export type OutboundMessage =
  | { type: 'message'; text: string; replyToMessageId?: string }
  | { type: 'ping' }
  | { type: 'identify'; name: string }
  | { type: 'fileContent'; requestId: string; content: string | null; error: string | null }
  | { type: 'avatar'; action: 'move'; location: string }
  | { type: 'avatar'; action: 'say'; text: string }
  | { type: 'avatar'; action: 'emote'; emote: string }
  | { type: 'avatar'; action: 'status'; status: 'working' | 'idle' | 'available' | 'busy' }
  | { type: 'model_response'; model: string };

export interface NextCompanyAccountConfig {
  id: string;
  apiKey: string;
  url: string;
  name?: string;   // OpenClaw agent name — sent as identify on connect
}
