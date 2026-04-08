import { createRequire } from 'module';
import {} from './types.js';
const _require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const WS = _require('ws');
const MIN_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 30_000;
const PING_INTERVAL_MS = 25_000;
const PONG_TIMEOUT_MS = 10_000;
const RECONNECT_CHECK_MS = 60_000; // periodic check: if no data received for this long, force reconnect
const WS_OPEN = 1;
export class NextCompanyWebSocketClient {
    url;
    apiKey;
    agentName;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ws = null;
    stopped = false;
    backoffMs = MIN_BACKOFF_MS;
    pingTimer = null;
    pongTimer = null;
    reconnectCheckTimer = null;
    lastDataAt = 0;
    queue = [];
    onMessage;
    identifyPayload = {};
    constructor(url, apiKey, onMessage, agentName) {
        this.url = url;
        this.apiKey = apiKey;
        this.agentName = agentName;
        this.onMessage = onMessage;
    }
    setIdentifyPayload(payload) {
        this.identifyPayload = payload;
    }
    start() {
        this.stopped = false;
        this.connect();
    }
    stop() {
        this.stopped = true;
        this.clearTimers();
        this.ws?.close(1000, 'stopped');
        this.ws = null;
    }
    send(msg) {
        if (this.ws?.readyState === WS_OPEN) {
            this.ws.send(JSON.stringify(msg));
        }
        else {
            this.queue.push(msg);
        }
    }
    sendAvatarMove(location) {
        this.send({ type: 'avatar', action: 'move', location });
    }
    sendAvatarSay(text) {
        this.send({ type: 'avatar', action: 'say', text });
    }
    sendAvatarEmote(emote) {
        this.send({ type: 'avatar', action: 'emote', emote });
    }
    sendAvatarStatus(status) {
        this.send({ type: 'avatar', action: 'status', status });
    }
    get isConnected() {
        return this.ws?.readyState === WS_OPEN;
    }
    connect() {
        if (this.stopped)
            return;
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
        ws.on('message', (data) => {
            this.lastDataAt = Date.now();
            let msg;
            try {
                msg = JSON.parse(data.toString());
            }
            catch {
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
        ws.on('error', () => { });
        ws.on('close', () => {
            this.clearTimers();
            if (!this.stopped) {
                setTimeout(() => this.connect(), this.backoffMs);
                this.backoffMs = Math.min(this.backoffMs * 2, MAX_BACKOFF_MS);
            }
        });
    }
    flushQueue() {
        const pending = this.queue.splice(0);
        for (const msg of pending) {
            this.send(msg);
        }
    }
    startPing() {
        this.pingTimer = setInterval(() => {
            if (this.ws?.readyState === WS_OPEN) {
                this.ws.send(JSON.stringify({ type: 'ping' }));
                this.pongTimer = setTimeout(() => {
                    this.ws?.close(4000, 'pong timeout');
                }, PONG_TIMEOUT_MS);
            }
        }, PING_INTERVAL_MS);
    }
    startReconnectCheck() {
        this.reconnectCheckTimer = setInterval(() => {
            const elapsed = Date.now() - this.lastDataAt;
            if (elapsed > RECONNECT_CHECK_MS && this.ws?.readyState === WS_OPEN) {
                // No data received for too long — connection is likely dead (zombie after swap)
                this.ws?.close(4001, 'no data timeout');
            }
        }, RECONNECT_CHECK_MS / 2);
    }
    clearPongTimer() {
        if (this.pongTimer) {
            clearTimeout(this.pongTimer);
            this.pongTimer = null;
        }
    }
    clearTimers() {
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
