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
    htmlBody?: string;
    bodyHtml?: string;
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
    workItemId?: string;
    WorkItemId?: string;
    kind?: string;
    Kind?: string;
    sourceType?: string;
    SourceType?: string;
    sourceId?: string;
    SourceId?: string;
    sourceTitle?: string;
    SourceTitle?: string;
    projectId?: string;
    ProjectId?: string;
    excerpt?: string;
    Excerpt?: string;
    htmlBody?: string;
    HtmlBody?: string;
    bodyHtml?: string;
    BodyHtml?: string;
    actorName?: string;
    ActorName?: string;
    actorAvatarUrl?: string;
    ActorAvatarUrl?: string;
    actionUrl?: string;
    ActionUrl?: string;
    projectName?: string;
    ProjectName?: string;
    id?: string;
    Id?: string;
    isRead?: boolean;
    IsRead?: boolean;
    createdAt?: string;
    CreatedAt?: string;
    tableId?: string;
    TableId?: string;
    commentId?: string;
    CommentId?: string;
    triggerKind?: string;
    TriggerKind?: string;
    entityKind?: string;
    EntityKind?: string;
    entityId?: string;
    EntityId?: string;
    threadId?: string;
    ThreadId?: string;
    conversationId?: string;
    ConversationId?: string;
    mailboxId?: string;
    MailboxId?: string;
    occurrenceId?: string;
    OccurrenceId?: string;
    checkInId?: string;
    CheckInId?: string;
    metadata?: NextCompanyNotificationMetadata;
    Metadata?: NextCompanyNotificationMetadata;
}
export interface NextCompanyAgentWakeMessage {
    type: 'agent_wake';
    workItemId?: string;
    WorkItemId?: string;
    agentId?: string;
    AgentId?: string;
    organizationId?: string;
    OrganizationId?: string;
    projectId?: string;
    ProjectId?: string;
    notificationId?: string;
    NotificationId?: string;
    wakeReason?: string;
    WakeReason?: string;
    sourceType?: string;
    SourceType?: string;
    sourceId?: string;
    SourceId?: string;
    sessionKey?: string;
    SessionKey?: string;
    correlationKey?: string;
    CorrelationKey?: string;
    createdAt?: string;
    CreatedAt?: string;
    metadata?: NextCompanyNotificationMetadata;
    Metadata?: NextCompanyNotificationMetadata;
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
export interface NextCompanyAgentInboxEvent {
    id: string;
    fromStatus?: string | null;
    toStatus: string;
    eventKind: string;
    occurredAt: string;
    actorType: string;
    actorId?: string | null;
    metadata?: unknown;
}
export interface NextCompanyAgentWorkItemPayload {
    kind?: string;
    cardId?: string;
    title?: string | null;
    notificationKind?: string;
    sourceTitle?: string;
    excerpt?: string | null;
    htmlBody?: string | null;
    bodyHtml?: string | null;
    commentHtml?: string | null;
    sourceHtml?: string | null;
    sourceHtmlReadUrl?: string | null;
    commentReadUrl?: string | null;
    commentPostUrl?: string | null;
    actorName?: string;
    actorAvatarUrl?: string | null;
    actionUrl?: string;
    tableId?: string | null;
    entityKind?: string | null;
    entityId?: string;
    threadId?: string | null;
    conversationId?: string | null;
    mailboxId?: string | null;
    occurrenceId?: string | null;
    checkInId?: string | null;
}
export interface NextCompanyAgentWorkItem {
    id: string;
    organizationId: string;
    projectId: string;
    agentId: string;
    notificationId?: string | null;
    sourceType: string;
    sourceId: string;
    commentId?: string | null;
    triggerKind: string;
    status: string;
    payload?: NextCompanyAgentWorkItemPayload | null;
    createdAt: string;
    wakeSentAt?: string | null;
    deliveredAt?: string | null;
    ackedAt?: string | null;
    claimedAt?: string | null;
    startedAt?: string | null;
    completedAt?: string | null;
    failedAt?: string | null;
    attemptCount: number;
    lastError?: string | null;
    sessionKey?: string | null;
    correlationKey?: string | null;
    events?: NextCompanyAgentInboxEvent[];
}
export type InboundMessage = NextCompanyConnectedMessage | NextCompanyIdentifiedMessage | NextCompanyDirectMessage | NextCompanyNotificationMessage | NextCompanyAgentWakeMessage | NextCompanyReadFileMessage | NextCompanyModelQueryMessage | NextCompanyCheckInMessage | NextCompanyMailboxEmailMessage | NextCompanyPongMessage;
export type OutboundMessage = {
    type: 'message';
    text: string;
    replyToMessageId?: string;
    channelId?: string;
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