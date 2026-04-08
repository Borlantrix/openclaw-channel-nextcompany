import { type InboundMessage, type OutboundMessage } from './types.js';
export type MessageHandler = (msg: InboundMessage) => void;
export declare class NextCompanyWebSocketClient {
    private readonly url;
    private readonly apiKey;
    private readonly agentName?;
    private ws;
    private stopped;
    private backoffMs;
    private pingTimer;
    private pongTimer;
    private reconnectCheckTimer;
    private lastDataAt;
    private queue;
    private onMessage;
    private identifyPayload;
    constructor(url: string, apiKey: string, onMessage: MessageHandler, agentName?: string | undefined);
    setIdentifyPayload(payload: Record<string, unknown>): void;
    start(): void;
    stop(): void;
    send(msg: OutboundMessage): void;
    sendAvatarMove(location: string): void;
    sendAvatarSay(text: string): void;
    sendAvatarEmote(emote: string): void;
    sendAvatarStatus(status: 'working' | 'idle' | 'available' | 'busy'): void;
    get isConnected(): boolean;
    private connect;
    private flushQueue;
    private startPing;
    private startReconnectCheck;
    private clearPongTimer;
    private clearTimers;
}
//# sourceMappingURL=websocket.d.ts.map