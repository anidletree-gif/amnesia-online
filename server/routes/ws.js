const url = require('url');
const game = require('../core/game');
const auth = require('../core/auth');

const connections = new Map();

// ★ 鉴权：外部连接必须发送 {type:'auth', token} 首条消息；本机回环(机器人/压测)免鉴权
//   playerId（邮箱）从会话中解析，不再走 URL query，避免 token/邮箱被 nginx 访问日志明文记录
const AUTH_TIMEOUT = 5000;

function handleWs(ws, req) {
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });

    const parsedUrl = url.parse(req.url, true);
    // ★ 关键：nginx 反代时 Node 看到的 remoteAddress 全是 127.0.0.1，
    //   必须优先用 nginx 注入的 X-Real-IP 判断真实客户端来源，否则外部连接会被误判为回环、跳过鉴权
    const realIp = req.headers['x-real-ip'] || req.socket?.remoteAddress || '';
    const isLoopback = realIp === '127.0.0.1' || realIp === '::1' || realIp === '::ffff:127.0.0.1' || realIp === 'localhost';

    // ★ 本机回环：playerId 从 query 取，免鉴权（bot_play.js / 压测脚本走这里）
    if (isLoopback) {
        const loopbackId = parsedUrl.query.playerId;
        if (loopbackId) {
            attach(ws, loopbackId);
        } else {
            try { ws.send(JSON.stringify({ type: 'error', message: '缺少 playerId' })); } catch(_) {}
            try { ws.close(); } catch(_) {}
        }
        return;
    }

    // ★ 外部连接：等待首条 auth 消息，超时未认证则断开
    let authed = false;
    const authTimer = setTimeout(() => {
        if (!authed) {
            try { ws.send(JSON.stringify({ type: 'error', message: '认证超时' })); } catch(_) {}
            try { ws.close(); } catch(_) {}
        }
    }, AUTH_TIMEOUT);

    ws.on('message', function onFirst(rawData) {
        if (authed) return;
        let strData;
        if (Buffer.isBuffer(rawData)) strData = rawData.toString();
        else if (typeof rawData === 'string') strData = rawData;
        else if (rawData instanceof ArrayBuffer) strData = new TextDecoder().decode(rawData);
        else { return; } // 非文本首帧直接忽略，等超时

        let msg;
        try { msg = JSON.parse(strData); } catch(e) { return; }
        if (msg.type !== 'auth' || typeof msg.token !== 'string') return;

        const sess = auth.verifySession(msg.token);
        if (!sess) {
            try { ws.send(JSON.stringify({ type: 'error', message: '登录已失效，请重新登录' })); } catch(_) {}
            try { ws.close(); } catch(_) {}
            return;
        }
        authed = true;
        clearTimeout(authTimer);
        ws.removeListener('message', onFirst);
        attach(ws, sess.email);
    });
}

function attach(ws, playerId) {
    const oldWs = connections.get(playerId);
    if (oldWs && oldWs !== ws) {
        const theOld = oldWs;
        theOld.onclose = null;
        theOld.onmessage = null;
        theOld.onerror = null;
        try { theOld.send(JSON.stringify({ type: 'kicked_offline', message: '账号已在其他设备登录' })); } catch(_) {}
        try { theOld.close(); } catch(_) {}
    }

    connections.set(playerId, ws);
    try { ws.send(JSON.stringify({ type: 'connected', playerId })); } catch(_) {}

    ws.on('message', (rawData) => {
        let strData;
        if (Buffer.isBuffer(rawData)) {
            strData = rawData.toString();
        } else if (typeof rawData === 'string') {
            strData = rawData;
        } else if (rawData instanceof ArrayBuffer) {
            strData = new TextDecoder().decode(rawData);
        } else {
            if (game.canPlayerSpeakVoice(playerId)) {
                const roomId = game.playerRoomMap.get(playerId);
                if (roomId) {
                    const room = game.getRoom(roomId);
                    const speaker = room?.players.find(p => p.id === playerId);
                    if (speaker) broadcastAudioToRoom(roomId, speaker.number, rawData, playerId);
                }
            }
            return;
        }

        let msg;
        try {
            msg = JSON.parse(strData);
        } catch (e) {
            if (game.canPlayerSpeakVoice(playerId)) {
                const roomId = game.playerRoomMap.get(playerId);
                if (roomId) {
                    const room = game.getRoom(roomId);
                    const speaker = room?.players.find(p => p.id === playerId);
                    if (speaker) broadcastAudioToRoom(roomId, speaker.number, rawData, playerId);
                }
            }
            return;
        }

        if (!msg.type) {
            ws.send(JSON.stringify({ type: 'error', message: '缺少消息类型' }));
            return;
        }
        if (msg.type === 'volume') {
            if (game.canPlayerSpeakVoice(playerId)) {
                const roomId = game.playerRoomMap.get(playerId);
                if (roomId) broadcastToRoom(roomId, { type: 'volume', number: msg.number, volume: msg.volume }, playerId);
            }
            return;
        }
        if (msg.type === 'signal') {
            const roomId = game.playerRoomMap.get(playerId);
            const room = game.getRoom(roomId);
            if (!room) return;
            const from = room.players.find(p => p.id === playerId);
            const target = room.players.find(p => p.number === msg.targetNumber);
            if (!from || !target || !msg.signal || typeof msg.signal.type !== 'string') return;
            const targetWs = connections.get(target.id);
            if (targetWs?.readyState === 1) {
                try {
                    targetWs.send(JSON.stringify({ type: 'signal', fromNumber: from.number, signal: msg.signal }));
                } catch (_) {}
            }
            return;
        }
        try {
            game.handleMessage(ws, playerId, msg);
        } catch (error) {
            console.error('handleMessage 异常:', error);
            try {
                ws.send(JSON.stringify({ type: 'error', message: '服务器内部错误' }));
            } catch (_) {}
        }
    });

    ws.on('close', () => {
        if (connections.get(playerId) === ws) {
            connections.delete(playerId);
            game.handleDisconnect(playerId);
        }
    });

    ws.on('error', () => {
        if (connections.get(playerId) === ws) connections.delete(playerId);
    });
}

function broadcastToRoom(roomId, msg, excludePlayerId = null) {
    const room = game.getRoom(roomId);
    if (!room) return;
    const data = JSON.stringify(msg);
    room.players.forEach(p => {
        if (p.id !== excludePlayerId) {
            const ws = connections.get(p.id);
            if (ws?.readyState === 1) ws.send(data);
        }
    });
    room.spectators.forEach(s => {
        if (s.id !== excludePlayerId) {
            const ws = connections.get(s.id);
            if (ws?.readyState === 1) ws.send(data);
        }
    });
}

function broadcastAudioToRoom(roomId, number, data, excludePlayerId = null) {
    const room = game.getRoom(roomId);
    if (!room) return;
    const header = Buffer.alloc(4);
    header.writeUInt32BE(number, 0);
    const payload = Buffer.isBuffer(data) ? data : Buffer.from(data);
    const packet = Buffer.concat([header, payload]);
    room.players.forEach(p => {
        if (p.id !== excludePlayerId) {
            const ws = connections.get(p.id);
            if (ws?.readyState === 1) ws.send(packet);
        }
    });
    room.spectators.forEach(s => {
        if (s.id !== excludePlayerId) {
            const ws = connections.get(s.id);
            if (ws?.readyState === 1) ws.send(packet);
        }
    });
}

function sendToPlayer(playerId, msg) {
    const ws = connections.get(playerId);
    if (ws?.readyState === 1) ws.send(JSON.stringify(msg));
}

module.exports = { handleWs, broadcastToRoom, broadcastAudioToRoom, sendToPlayer };