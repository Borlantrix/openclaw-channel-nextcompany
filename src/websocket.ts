import { createRequire } from 'module';
import { type InboundMessage, type OutboundMessage } from './types.js';

const _require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const WS: any = _require('ws');

const MIN_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 30_000;
const PING_INTERVAL_MS = 25_000;
const PONG_TIMEOUT_MS = 10_000;
const RECONNECT_CHECK_MS = 60_000; // periodic check: if no data received for this long, force reconnect

const WS_OPEN = 1;

export type MessageHandler = (msg: InboundMessage) => void;

export class NextCompanyWebSocketClient {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private ws: any = null;
  private stopped = false;
  private backoffMs = MIN_BACKOFF_MS;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private pongTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectCheckTimer: ReturnType<typeof setInterval> | null = null;
  private lastDataAt = 0;
  private queue: OutboundMessage[] = [];
  private onMessage: MessageHandler;

  private identifyPayload: Record<string, unknown> = {};

  constructor(
    private readonly url: string,
    private readonly apiKey: string,
    onMessage: MessageHandler,
    private readonly agentName?: string,
  ) {
    this.onMessage = onMessage;
  }

  setIdentifyPayload(payload: Record<string, unknown>): void {
    this.identifyPayload = payload;
  }

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.clearTimers();
    this.ws?.close(1000, 'stopped');
    this.ws = null;
  }

  send(msg: OutboundMessage): void {
    if (this.ws?.readyState === WS_OPEN) {
      this.ws.send(JSON.stringify(msg));
    } else {
      this.queue.push(msg);
    }
  }

  sendAvatarMove(location: string): void {
    this.send({ type: 'avatar', action: 'move', location } as OutboundMessage);
  }

  sendAvatarSay(text: string): void {
    this.send({ type: 'avatar', action: 'say', text } as OutboundMessage);
  }

  sendAvatarEmote(emote: string): void {
    this.send({ type: 'avatar', action: 'emote', emote } as OutboundMessage);
  }

  sendAvatarStatus(status: 'working' | 'idle' | 'available' | 'busy'): void {
    this.send({ type: 'avatar', action: 'status', status } as OutboundMessage);
  }

  get isConnected(): boolean {
    return this.ws?.readyState === WS_OPEN;
  }

  private connect(): void {
    if (this.stopped) return;

    const wsUrl = new URL(this.url);
    const ws = new WS(wsUrl.toString(), {
      headers: { Authorization: `Bearer ${this.apiKey}` },
    });

    this.ws = ws;

    ws.on('open', () => {
      this.backoffMs = MIN_BACKOFF_MS;
      this.lastDataAt = Date.now();
      // Identify to the server with full agent info
      if (this.agentName) {
        ws.send(JSON.stringify({ type: 'identify', name: this.agentName, ...this.identifyPayload }));
      }
      this.flushQueue();
      this.startPing();
      this.startReconnectCheck();
    });

    ws.on('message', (data: Buffer | string) => {
      this.lastDataAt = Date.now();
      let msg: InboundMessage;
      try {
        msg = JSON.parse(data.toString()) as InboundMessage;
      } catch {
        return;
      }
      if (msg.type === 'pong') {
        this.clearPongTimer();
        return;
      }
      if (msg.type === 'identified') {
        // Server acknowledged our identity — nothing to do
        return;
      }
      this.onMessage(msg);
    });

    ws.on('error', () => { /* reconnect handled by close */ });

    ws.on('close', () => {
      this.clearTimers();
      if (!this.stopped) {
        setTimeout(() => this.connect(), this.backoffMs);
        this.backoffMs = Math.min(this.backoffMs * 2, MAX_BACKOFF_MS);
      }
    });
  }

  private flushQueue(): void {
    const pending = this.queue.splice(0);
    for (const msg of pending) {
      this.send(msg);
    }
  }

  private startPing(): void {
    this.pingTimer = setInterval(() => {
      if (this.ws?.readyState === WS_OPEN) {
        this.ws.send(JSON.stringify({ type: 'ping' }));
        this.pongTimer = setTimeout(() => {
          this.ws?.close(4000, 'pong timeout');
        }, PONG_TIMEOUT_MS);
      }
    }, PING_INTERVAL_MS);
  }

  private startReconnectCheck(): void {
    this.reconnectCheckTimer = setInterval(() => {
      const elapsed = Date.now() - this.lastDataAt;
      if (elapsed > RECONNECT_CHECK_MS && this.ws?.readyState === WS_OPEN) {
        // No data received for too long — connection is likely dead (zombie after swap)
        this.ws?.close(4001, 'no data timeout');
      }
    }, RECONNECT_CHECK_MS / 2);
  }

  private clearPongTimer(): void {
    if (this.pongTimer) {
      clearTimeout(this.pongTimer);
      this.pongTimer = null;
    }
  }

  private clearTimers(): void {
    this.clearPongTimer();
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    if (this.reconnectCheckTimer) {
      clearInterval(this.reconnectCheckTimer);
      this.reconnectCheckTimer = null;
    }
  }
}
