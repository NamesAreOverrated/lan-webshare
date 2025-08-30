import { loadQueue, clearQueue, pushOp } from './storage';

export function makeUrl(host, port, secure = false) {
    const proto = secure || port === 443 ? 'wss' : 'ws';
    return `${proto}://${host}:${port}`;
}

export function createWS({ host, port, onSync, onStatus }) {
    let ws;
    let closed = false;

    const connect = () => {
        if (closed) return;
        try { ws?.close?.(); } catch { }
        const url = makeUrl(host, port);
        ws = new WebSocket(url);
        ws.onopen = async () => {
            onStatus?.({ online: true });
            // flush queue
            const q = await loadQueue(host, port);
            for (const op of q) {
                try { ws.send(JSON.stringify({ type: op.type, payload: op.payload })); } catch { break; }
            }
            await clearQueue(host, port);
        };
        ws.onclose = () => { onStatus?.({ online: false }); if (!closed) setTimeout(connect, 2000); };
        ws.onerror = () => { onStatus?.({ online: false }); };
        ws.onmessage = (ev) => {
            try {
                const msg = JSON.parse(ev.data);
                if (msg.type === 'full_sync') onSync?.(msg.payload);
            } catch { }
        };
    };

    connect();

    return {
        send(type, payload) {
            if (ws && ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type, payload }));
            } else {
                // fallback: store to queue handled by caller
                pushOp(host, port, { type, payload, ts: Date.now() }).catch(() => { });
            }
        },
        close() { closed = true; try { ws?.close?.(); } catch { } },
    };
}
