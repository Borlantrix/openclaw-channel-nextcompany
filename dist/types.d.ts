export interface NextCompanyNotificationMetadata {
    tableId?: string;
    commentId?: string;
    triggerKind?: string;
    entityKind?: string;
    entityId?: string;
    mailboxId?: string;
    mailboxThreadId?: string;
    threadId?: string;
    conversationId?: string;
    occurrenceId?: string;
    checkInId?: string;
    [key: string]: unknown;
}
export interface NextCompanyConnectedMessage {
    type: 'connected';
    agentId: string;
    agentName: string;
    organizationId: string;
    timestamp: string;
}
export interface NextCompanyIdentifiedMessage {
    type: 'identified';
    name: string;
}
export interface NextCompanyDirectMessage {
    type: 'message';
    text: string;
    messageId?: string;
    timestamp?: string;
    fromUserId?: string;
    fromName?: string;
    from?: string;
    channelId?: string;
    senderName?: string;
    attachmentUrl?: string;
    attachmentFileName?: string;
    attachmentContentType?: string;
}
export interface NextCompanyNotificationMessage {
    type: 'notification';
    kind: string;
    sourceType: string;
    sourceId: string;
    sourceTitle: string;
    projectId: string;
    excerpt?: string;
    actorName?: string;
    actorAvatarUrl?: string;
    actionUrl?: string;
    projectName?: string;
    id?: string;
    isRead?: boolean;
    createdAt?: string;
    tableId?: string;
    commentId?: string;
    triggerKind?: string;
    metadata?: NextCompanyNotificationMetadata;
}
export interface NextCompanyReadFileMessage {
    type: 'readFile';
    file: string;
    requestId: string;
}
export interface NextCompanyModelQueryMessage {
    type: 'model_query';
}
export interface NextCompanyCheckInMessage {
    type: 'check_in';
    occurrenceId: string;
    checkInId: string;
    projectId: string;
    question: string;
    description?: string;
    scheduledAt: string;
}
export interface NextCompanyMailboxEmailMessage {
    type: 'mailbox_email';
    messageId: string;
    accountId: string;
    from: string;
    fromName?: string;
    subject: string;
    snippet?: string;
    bodyText?: string;
    receivedAt: string;
    mailboxId?: string;
    threadId?: string;
    conversationId?: string;
}
export interface NextCompanyPongMessage {
    type: 'pong';
}
export type InboundMessage = NextCompanyConnectedMessage | NextCompanyIdentifiedMessage | NextCompanyDirectMessage | NextCompanyNotificationMessage | NextCompanyReadFileMessage | NextCompanyModelQueryMessage | NextCompanyCheckInMessage | NextCompanyMailboxEmailMessage | NextCompanyPongMessage;
export type OutboundMessage = {
    type: 'message';
    text: string;
    replyToMessageId?: string;
} | {
    type: 'ping';
} | {
    type: 'identify';
    name: string;
} | {
    type: 'fileContent';
    requestId: string;
    content: string | null;
    error: string | null;
} | {
    type: 'avatar';
    action: 'move';
    location: string;
} | {
    type: 'avatar';
    action: 'say';
    text: string;
} | {
    type: 'avatar';
    action: 'emote';
    emote: string;
} | {
    type: 'avatar';
    action: 'status';
    status: 'working' | 'idle' | 'available' | 'busy';
} | {
    type: 'model_response';
    model: string;
};
export interface NextCompanyAccountConfig {
    id: string;
    apiKey: string;
    url: string;
    name?: string;
}
//# sourceMappingURL=types.d.ts.map