const url = require('url');
const game = require('../core/game');

const connections = new Map();

function handleWs(ws, req) {
    // ★ 心跳标记：收到 pong 视为存活，超时未响应会被 server.js 强制断开
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });

    const parsedUrl = url.parse(req.url, true);
    const playerId = parsedUrl.query.playerId || Math.random().toString(36).substring(2, 10);

    const oldWs = connections.get(playerId);
    if (oldWs && oldWs !== ws) {
        // 记录旧连接，close 时只清理"仍指向旧连接"的条目，避免误删重连后的新连接
        const theOld = oldWs;
        oldWs.onclose = null; // 移除旧连接自带的 close 处理器
        oldWs.onmessage = null;
        oldWs.onerror = null;
        // ★ 通知旧连接被顶下线（客户端收到后停止自动重连，避免双端互顶乒乓）
        try { theOld.send(JSON.stringify({ type: 'kicked_offline', message: '账号已在其他设备登录' })); } catch(_) {}
        try { theOld.close(); } catch(_) {}
    }

    connections.set(playerId, ws);
    ws.send(JSON.stringify({ type: 'connected', playerId }));

    ws.on('message', (rawData) => {
        // 将数据转换为字符串（兼容 Buffer / string / ArrayBuffer）
        let strData;
        if (Buffer.isBuffer(rawData)) {
            strData = rawData.toString();
        } else if (typeof rawData === 'string') {
            strData = rawData;
        } else if (rawData instanceof ArrayBuffer) {
            strData = new TextDecoder().decode(rawData);
        } else {
            // 无法转为文本，当作二进制音频转发（★ 仅白天当前发言人可发语音，且携带发言人编号）
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

        // 尝试解析 JSON
        let msg;
        try {
            msg = JSON.parse(strData);
        } catch (e) {
            // 解析失败，也当作二进制音频（★ 同样做权限过滤 + 携带发言人编号）
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

        // 处理 JSON 消息
        if (!msg.type) {
            ws.send(JSON.stringify({ type: 'error', message: '缺少消息类型' }));
            return;
        }
        if (msg.type === 'volume') {
            // ★ 音量也只允许白天当前发言人上报，且只转发数值不转发原始
            if (game.canPlayerSpeakVoice(playerId)) {
                const roomId = game.playerRoomMap.get(playerId);
                if (roomId) broadcastToRoom(roomId, { type: 'volume', number: msg.number, volume: msg.volume }, playerId);
            }
            return;
        }
        if (msg.type === 'signal') {
            // ★ WebRTC 语音信令转发（语音 P2P：媒体不经过服务器，服务器只转发 offer/answer/ICE）
            // 寻址用房间内唯一的 number，服务端映射到真实 playerId，避免泄露邮箱 id
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
        // 核心游戏逻辑
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
        // 仅当 Map 中仍指向此连接时才删除，避免误删重连后的新连接
        if (connections.get(playerId) === ws) connections.delete(playerId);
        game.handleDisconnect(playerId);
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

// ★ 音频转发：前4字节为大端发言人编号，其后为音频数据（解决前端无法区分发言人导致的混流冲突）
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