const roleConfig = require('../roles.json');
const auth = require('./auth');
const fs = require('fs');
const path = require('path');
const config = require('../config');

let broadcastToRoom, sendToPlayer;
function loadWSFunctions() {
    if (!broadcastToRoom || !sendToPlayer) {
        const ws = require('../routes/ws');
        broadcastToRoom = ws.broadcastToRoom;
        sendToPlayer = ws.sendToPlayer;
    }
}

// 启动时加载预设文件（★ 缺失时使用内置默认预设兜底，不再 process.exit 崩溃）
let presetsData;
try {
    const presetsPath = path.join(__dirname, '..', 'presets.json');
    presetsData = JSON.parse(fs.readFileSync(presetsPath, 'utf-8'));
} catch (err) {
    console.error('WARN: presets.json 缺失或损坏，使用内置默认预设:', err.message);
    presetsData = {
        presets: {
            '6人基础': { '凶手':1, '侦探':1, '精神病':1, '失忆者':3 },
            '8人进阶': { '凶手':1, '虚构者':1, '侦探':1, '错构者':1, '精神分裂':1, '精神病':1, '失忆者':2 }
        },
        active: '8人进阶'
    };
}

const rooms = new Map();
const playerRoomMap = new Map();

function getCamp(role) { return roleConfig[role]?.camp || 'good'; }
function getKillType(role) { return roleConfig[role]?.kill || 'never'; }
function getCheckType(role) { return roleConfig[role]?.check || 'fixed_non_killer'; }
function getFlipType(role) { return roleConfig[role]?.flip || 'always_die'; }
function getSpecial(role) { return roleConfig[role]?.special || null; }

function getFlipCards(rolePool) {
    const unique = [...new Set(rolePool)];
    return unique.filter(r => r !== '失忆者' && r !== '精神分裂').map(r => ({ name: `${r}牌`, role: r }));
}

function addRecord(room, playerId, text) {
    if (!room.playerRecords[playerId]) room.playerRecords[playerId] = [];
    room.playerRecords[playerId].push(text);
    if (room.playerRecords[playerId].length > 100) room.playerRecords[playerId].shift();
}

function getPlayerList(room, viewerId) {
    const users = auth.loadUsers();
    return room.players.map(p => {
        const user = Object.values(users).find(u => u.nickname === p.name);
        // ★ 防泄露：hasActed（夜晚是否已行动）仅在夜晚阶段且仅本人可见，旁观者/其他玩家一律 false
        const revealActed = room.phase === 'night' && viewerId === p.id;
        const hasActed = revealActed ? room.nightActions.some(a => a.playerId === p.id) : false;
        return {
            number: p.number,
            name: p.name,
            alive: p.alive,
            connected: p.connected,
            isHost: p.id === room.hostId,
            avatar: user?.avatar || null,
            hasActed
        };
    });
}

// ========== 房间管理 ==========
function createRoom(roomId, presetName, hostId, hostName) {
    loadWSFunctions();
    const allPresets = presetsData.presets || presetsData; // 兼容两种格式
    const finalName = allPresets[presetName] ? presetName : Object.keys(allPresets)[0];
    const cfg = allPresets[finalName];
    if (!cfg || typeof cfg !== 'object') {
        sendToPlayer(hostId, { type: 'error', message: '预设不存在' });
        return null;
    }
    const rolePool = [];
    for (let [role, count] of Object.entries(cfg)) {
        for (let i = 0; i < count; i++) rolePool.push(role);
    }
    const room = {
        id: roomId, presetName: finalName, hostId,
        players: [{ id: hostId, name: hostName, number: 1, role: null, alive: true, connected: true }],
        spectators: [], phase: 'waiting', day: 0, nightActions: [], votes: {},
        rolePool, flipCards: getFlipCards(rolePool),
        lastRoundAction: {}, checkModifier: new Map(), fabricatorAwake: false,
        copyMap: new Map(),   // ★ 人格分裂本夜复制的目标角色（playerId -> 角色名）
        currentSpeaker: null, currentNightPlayer: null, timeoutId: null,
        deathRecords: [], playerRecords: {}, isPublic: true,
        gameStarted: false,
        speakTimeoutId: null, speakStartTime: null, speakDuration: Math.max(10, Math.floor((config.SPEAK_TIMEOUT || 120000) / 1000)),  // ★ 与 config 一致
        chatHistory: [], nightTimer: null,
        voteTimeoutId: null, voteDuration: Math.max(10, Math.floor((config.VOTE_TIMEOUT || 30000) / 1000))   // ★ 投票超时（秒），防止有人不投票永久卡死
    };
    rooms.set(roomId, room);
    playerRoomMap.set(hostId, roomId);
    return room;
}

function getRoom(roomId) { return rooms.get(roomId); }

function getPublicRooms() {
    const result = [];
    for (let [id, room] of rooms) {
        if (room.isPublic && room.phase === 'waiting') {
            const host = room.players.find(p => p.id === room.hostId);
            result.push({ id, players: room.players.length, max: room.rolePool.length, preset: room.presetName, hostName: host?.name || '未知' });
        }
    }
    return result;
}

function joinRoom(roomId, playerId, playerName) {
    loadWSFunctions();
    const room = rooms.get(roomId);
    if (!room) return null;

    const existing = room.players.find(p => p.name === playerName);
    if (existing) {
        existing.id = playerId;
        existing.connected = true;
        playerRoomMap.set(playerId, roomId);
        broadcastToRoom(roomId, { type: 'player_list', players: getPlayerList(room) });

        const now = Date.now();
        const syncPayload = {
            type: 'state_sync',
            phase: room.phase, day: room.day,
            myNumber: existing.number,
            isHost: existing.id === room.hostId,
            alive: existing.alive,
            gameStarted: room.gameStarted,
            players: getPlayerList(room, existing.id),
            flipCards: room.flipCards,
            // ★ 防泄露：夜晚行动细节仅返回重连者自己的，看不到别人的行动
            nightActions: room.nightActions.filter(a => a.playerId === existing.id).map(a => ({
                playerNumber: room.players.find(p => p.id === a.playerId)?.number,
                action: a.action, target: a.target, flipCard: a.flipCard
            })),
            votes: room.votes ? Object.fromEntries(Object.entries(room.votes).map(([id, target]) => {
                const voter = room.players.find(p => p.id === id);
                return [voter ? voter.number : id, target];
            })) : {},
            deathRecords: (room.deathRecords || []).map(d => ({ number: d.number, name: d.name, day: d.day })), // ★ 脱敏：不暴露死因和身份
            chatHistory: room.chatHistory ? room.chatHistory.slice(-50) : [],
            currentSpeaker: null, speakRemaining: 0, isMyTurn: false,
            nightActive: false, voteActive: false
        };

        if (room.phase === 'day' && room.currentSpeaker) {
            const speakerPlayer = room.players.find(p => p.id === room.currentSpeaker);
            if (speakerPlayer) {
                syncPayload.currentSpeaker = speakerPlayer.number;
                const elapsed = room.speakStartTime ? (now - room.speakStartTime) / 1000 : 0;
                syncPayload.speakRemaining = Math.max(0, Math.ceil(room.speakDuration - elapsed));
                syncPayload.isMyTurn = (room.currentSpeaker === existing.id);
            }
        }
        if (room.phase === 'night') {
            syncPayload.nightActive = true;
            if (room.currentNightPlayer === existing.id && existing.alive) syncPayload.isMyTurn = true;
        }
        if (room.phase === 'vote') syncPayload.voteActive = true;

        sendToPlayer(playerId, syncPayload);

        if (room.phase === 'night' && room.currentNightPlayer === existing.id && existing.alive) {
            sendToPlayer(playerId, { type: 'your_turn', phase: 'night', flipCards: room.flipCards, day: room.day });
        }
        if (room.phase === 'vote') sendToPlayer(playerId, { type: 'vote_start' });
        if (room.phase === 'day' && room.currentSpeaker && room.currentSpeaker !== existing.id) {
            const speakerPlayer = room.players.find(p => p.id === room.currentSpeaker);
            if (speakerPlayer) {
                const elapsed = room.speakStartTime ? (now - room.speakStartTime) / 1000 : 0;
                const remaining = Math.max(0, Math.ceil(room.speakDuration - elapsed));
                sendToPlayer(playerId, { type: 'speak_start', speaker: speakerPlayer.number, maxTime: remaining });
            }
        }
        return { roomId, yourNumber: existing.number, preset: room.presetName, flipCards: room.flipCards, isHost: existing.id === room.hostId, gameStarted: room.gameStarted };
    }

    if (room.phase !== 'waiting') return null;
    if (room.players.length >= room.rolePool.length) return null;
    if (room.players.some(p => p.name === playerName && p.connected)) return null;

    const num = room.players.length + 1;
    const player = { id: playerId, name: playerName, number: num, role: null, alive: true, connected: true };
    room.players.push(player);
    playerRoomMap.set(playerId, roomId);
    broadcastToRoom(roomId, { type: 'player_list', players: getPlayerList(room) });
    return { roomId, yourNumber: num, preset: room.presetName, flipCards: room.flipCards, isHost: false, gameStarted: false };
}

function spectateRoom(roomId, playerId, playerName) {
    loadWSFunctions();
    const room = rooms.get(roomId);
    if (!room || room.phase === 'waiting') return null;
    if (room.spectators.some(s => s.name === playerName)) return null;
    const spectator = { id: playerId, name: playerName };
    room.spectators.push(spectator);
    playerRoomMap.set(playerId, roomId);
    return true;
}

function kickPlayer(roomId, hostId, targetNumber) {
    loadWSFunctions();
    const room = rooms.get(roomId);
    if (!room || room.hostId !== hostId || room.phase !== 'waiting') return false;
    const target = room.players.find(p => p.number === targetNumber);
    if (!target || target.id === hostId) return false;
    sendToPlayer(target.id, { type: 'kicked', message: '你已被房主踢出房间' });
    room.players = room.players.filter(p => p.id !== target.id);
    playerRoomMap.delete(target.id);
    broadcastToRoom(roomId, { type: 'player_list', players: getPlayerList(room) });
    return true;
}

// ========== 游戏逻辑 ==========
function startGame(roomId, hostId) {
    loadWSFunctions();
    const room = rooms.get(roomId);
    if (!room || room.hostId !== hostId || room.phase !== 'waiting') return false;
    if (room.players.length < room.rolePool.length) return false;
    const shuffled = [...room.rolePool].sort(() => Math.random() - 0.5);
    room.players.forEach((p, i) => p.role = shuffled[i]);
    room.deathRecords = [];
    room.playerRecords = {};
    room.gameStarted = true;
    broadcastToRoom(roomId, { type: 'game_started' });
    startNight(room);
    return true;
}

function startNight(room) {
    loadWSFunctions();
    room.phase = 'night';
    room.day++;
    room.nightActions = [];
    room.votes = {};
    room.fabricatorAwake = !room.players.some(p => p.alive && getCamp(p.role) === 'killer' && p.role !== '虚构者');

    // ★ 人格分裂：每晚随机复制一名其他存活玩家的角色能力
    room.copyMap = new Map();
    const aliveNow = room.players.filter(p => p.alive);
    room.players.filter(p => p.alive && p.role === '人格分裂').forEach(dissociative => {
        const candidates = aliveNow.filter(t => t.id !== dissociative.id);
        if (candidates.length > 0) {
            const copied = candidates[Math.floor(Math.random() * candidates.length)];
            room.copyMap.set(dissociative.id, copied.role);
        }
    });

    setTimeout(() => {
        broadcastToRoom(room.id, { type: 'phase', phase: 'night', day: room.day });
    }, 300); // 阶段过渡延迟

    const alive = room.players.filter(p => p.alive && p.connected).sort((a, b) => a.number - b.number);
    if (alive.length === 0) { resolveNight(room); return; }
    room.currentNightPlayer = alive[0].id;
    sendToPlayer(alive[0].id, { type: 'your_turn', phase: 'night', flipCards: room.flipCards, day: room.day });

    if (room.nightTimer) clearTimeout(room.nightTimer);
    room.nightTimer = setTimeout(() => {
        const stillAlive = room.players.filter(p => p.alive && p.connected);
        const pending = stillAlive.filter(p => !room.nightActions.some(a => a.playerId === p.id));
        pending.forEach(p => {
            const targets = stillAlive.filter(t => t.number !== p.number);
            if (targets.length === 0) return;
            const randomTarget = targets[Math.floor(Math.random() * targets.length)];
            const randomAction = getCamp(p.role) === 'killer' ? 'kill' : 'check';
            const randomFlip = room.flipCards[Math.floor(Math.random() * room.flipCards.length)]?.role || null;
            room.nightActions.push({ playerId: p.id, action: randomAction, target: randomTarget.number, flipCard: randomFlip });
            room.lastRoundAction[p.number] = randomAction;   // ★ 超时自动行动也要记录，供错构者次夜判定
            if (randomAction === 'check') {
                const targetPlayer = room.players.find(pl => pl.number === randomTarget.number);
                if (targetPlayer) {
                    const result = getCheckResult(room, p, targetPlayer);
                    addRecord(room, p.id, `第${room.day}夜（超时自动）：查验${targetPlayer.name}，结果${result}`);
                }
            } else {
                const targetPlayer = room.players.find(pl => pl.number === randomTarget.number);
                addRecord(room, p.id, `第${room.day}夜（超时自动）：暗杀${targetPlayer?.name || randomTarget.number + '号'}`);
                // 私人记录（推送聊天）
                sendToPlayer(p.id, { type: 'chat', from: '系统', message: `第${room.day}夜：你自动暗杀了${targetPlayer?.name || randomTarget.number + '号'}` });
            }
        });
        resolveNight(room);
    }, config.ACTION_TIMEOUT || 300000);
}

function processNightAction(room, player, actionData) {
    loadWSFunctions();
    // 必须处于夜晚阶段
    if (room.phase !== 'night') return;
    // 必须轮到该玩家
    if (room.currentNightPlayer !== player.id) return;

    const { action, target, flipCard } = actionData;
    // ★ 输入校验：action 必须合法
    if (action !== 'check' && action !== 'kill') return;
    // ★ 输入校验：目标必须是存活玩家
    const targetPlayer = room.players.find(p => p.number === target);
    if (!targetPlayer || !targetPlayer.alive || targetPlayer.id === player.id) return;
    // ★ 输入校验：flipCard 必须是本局存在的牌（允许 null=不翻牌）
    if (flipCard !== null && flipCard !== undefined) {
        const validFlip = room.flipCards.some(c => c.role === flipCard);
        if (!validFlip) return;
    }

    if (action === 'check') {
        const result = getCheckResult(room, player, targetPlayer);
        sendToPlayer(player.id, { type: 'check_result', result, targetNumber: target, targetName: targetPlayer.name, day: room.day });
        addRecord(room, player.id, `第${room.day}夜：查验${targetPlayer.name}，结果${result}`);
    } else if (action === 'kill') {
        addRecord(room, player.id, `第${room.day}夜：暗杀${targetPlayer.name}`);
        // 私人暗杀记录
        sendToPlayer(player.id, { type: 'chat', from: '系统', message: `第${room.day}夜：你暗杀了${targetPlayer.name}` });
    }
    room.nightActions.push({ playerId: player.id, action, target, flipCard });
    room.lastRoundAction[player.number] = action;

    const alive = room.players.filter(p => p.alive && p.connected).sort((a, b) => a.number - b.number);
    const idx = alive.findIndex(p => p.id === room.currentNightPlayer);
    if (idx === -1 || idx === alive.length - 1) {
        if (room.nightTimer) clearTimeout(room.nightTimer);
        resolveNight(room);
    } else {
        room.currentNightPlayer = alive[idx + 1].id;
        sendToPlayer(alive[idx + 1].id, { type: 'your_turn', phase: 'night', flipCards: room.flipCards, day: room.day });
    }
}

function resolveNight(room) {
    loadWSFunctions();
    if (room.nightTimer) clearTimeout(room.nightTimer);
    const killed = new Set();
    room.fabricatorAwake = !room.players.some(p => p.alive && getCamp(p.role) === 'killer' && p.role !== '虚构者');

    room.players.filter(p => p.alive).forEach(p => {
        const act = room.nightActions.find(a => a.playerId === p.id);
        if (!act || act.action !== 'kill') return;
        if (isKillEffective(room, p)) {
            const target = room.players.find(pl => pl.number === act.target && pl.alive);
            if (target) { killed.add(target.id); recordDeath(room, target, '被暗杀'); }
        }
        // ★ 侦探带刀：侦探暗杀仅对凶手阵营目标有效（刀真狼），好人/中立不误杀；人格分裂复制到侦探也继承
        else if (p.role === '侦探' || (p.role === '人格分裂' && room.copyMap.get(p.id) === '侦探')) {
            const target = room.players.find(pl => pl.number === act.target && pl.alive);
            if (target && getCamp(target.role) === 'killer') {
                killed.add(target.id);
                recordDeath(room, target, '被侦探刀杀');
            }
        }
    });

    room.players.filter(p => p.alive).forEach(p => {
        const act = room.nightActions.find(a => a.playerId === p.id);
        if (!act || act.flipCard === undefined || act.flipCard === null) return;
        if (shouldDieFromFlip(room, p, act.flipCard)) {
            killed.add(p.id);
            recordDeath(room, p, '翻错牌');
        }
    });

    killed.forEach(id => {
        const p = room.players.find(pl => pl.id === id);
        if (p) p.alive = false;
    });

    // ★ 修复：死亡结算后立即广播最新玩家列表（含 alive 状态），前端面板立刻渲染死亡
    if (killed.size > 0) {
        broadcastToRoom(room.id, { type: 'player_list', players: getPlayerList(room) });
    }

    // ★ 清空当前夜行动玩家，防止白天误操作
    room.currentNightPlayer = null;

    const winner = checkGameOver(room);
    if (winner) {
        room.phase = 'gameover';
        broadcastToRoom(room.id, {
            type: 'gameover',
            winner,
            roles: room.players.map(p => ({ number: p.number, name: p.name, role: p.role, alive: p.alive })),
            deathRecords: room.deathRecords
        });
    } else {
        startDay(room);
    }
}

function startDay(room) {
    loadWSFunctions();
    // ★ 清理夜晚状态
    room.currentNightPlayer = null;
    if (room.nightTimer) { clearTimeout(room.nightTimer); room.nightTimer = null; }

    room.phase = 'day';
    room.votes = {};
    const todayDeath = room.deathRecords.filter(r => r.day === room.day);
    // ★ 去重：同一玩家一夜多次死亡（如被暗杀+翻错牌）时，白天死者名单不重复显示
    const killedNames = [...new Set(todayDeath.map(r => r.name))].join('、');

    const alive = room.players.filter(p => p.alive && p.connected).sort((a, b) => a.number - b.number);
    const firstSpeaker = alive.length > 0 ? alive[0] : null;

    if (firstSpeaker) {
        room.currentSpeaker = firstSpeaker.id;
        room.speakStartTime = Date.now();
    }

    setTimeout(() => {
        broadcastToRoom(room.id, {
            type: 'phase',
            phase: 'day',
            day: room.day,
            killedNames,
            currentSpeaker: firstSpeaker ? firstSpeaker.number : null,
            speakRemaining: firstSpeaker ? room.speakDuration : 0
        });

        if (firstSpeaker) {
            broadcastToRoom(room.id, { type: 'speak_start', speaker: firstSpeaker.number, maxTime: room.speakDuration });
            if (room.speakTimeoutId) clearTimeout(room.speakTimeoutId);
            room.speakTimeoutId = setTimeout(() => {
                endSpeak(room, firstSpeaker.id, true);
            }, room.speakDuration * 1000);
        } else {
            startVote(room);
        }
    }, 300);
}

function endSpeak(room, playerId, isAuto = false) {
    loadWSFunctions();
    if (room.currentSpeaker !== playerId) return;
    if (room.speakTimeoutId) { clearTimeout(room.speakTimeoutId); room.speakTimeoutId = null; }
    const alive = room.players.filter(p => p.alive && p.connected).sort((a, b) => a.number - b.number);
    const currentIdx = alive.findIndex(p => p.id === playerId);
    if (currentIdx === -1 || currentIdx === alive.length - 1) {
        broadcastToRoom(room.id, { type: 'speak_end', auto: isAuto });
        startVote(room);
    } else {
        room.currentSpeaker = alive[currentIdx + 1].id;
        room.speakStartTime = Date.now();
        broadcastToRoom(room.id, { type: 'speak_start', speaker: alive[currentIdx + 1].number, maxTime: room.speakDuration });
        room.speakTimeoutId = setTimeout(() => { endSpeak(room, alive[currentIdx + 1].id, true); }, room.speakDuration * 1000);
    }
}

function startVote(room) {
    loadWSFunctions();
    room.phase = 'vote';
    room.votes = {};
    setTimeout(() => {
        broadcastToRoom(room.id, { type: 'vote_start' });
    }, 300);
    // ★ 投票超时兜底：超时后未投票玩家按弃权处理并自动结算，防止游戏永久卡死
    if (room.voteTimeoutId) clearTimeout(room.voteTimeoutId);
    room.voteTimeoutId = setTimeout(() => {
        if (room.phase !== 'vote') return;
        const alive = room.players.filter(p => p.alive && p.connected);
        alive.forEach(p => {
            if (!room.votes.hasOwnProperty(p.id)) room.votes[p.id] = -1;
        });
        broadcastToRoom(room.id, { type: 'vote_timeout', message: '投票超时，未投票玩家按弃权处理' });
        finishVote(room);
    }, room.voteDuration * 1000);
}

function processVote(room, playerId, target) {
    loadWSFunctions();
    if (room.phase !== 'vote') return;
    const voter = room.players.find(p => p.id === playerId);
    // 只有存活玩家能投票
    if (!voter?.alive) return;
    // 目标必须是-1(弃权)或存活玩家编号（不能投死者/不存在/自己）
    if (target !== -1) {
        if (typeof target !== 'number' || !Number.isInteger(target)) return;
        const t = room.players.find(p => p.number === target && p.alive);
        if (!t) return;
    }
    room.votes[playerId] = target;
    addRecord(room, playerId, `第${room.day}天：投票给${target === -1 ? '弃权' : room.players.find(p => p.number === target)?.name}`);
    const alive = room.players.filter(p => p.alive && p.connected);
    if (alive.every(p => room.votes.hasOwnProperty(p.id))) finishVote(room);
}

function finishVote(room) {
    loadWSFunctions();
    // ★ 防重复结算：超时回调与全员投票可能同时触发
    if (room.phase !== 'vote') return;
    if (room.voteTimeoutId) { clearTimeout(room.voteTimeoutId); room.voteTimeoutId = null; }
    const tally = {};
    Object.values(room.votes).forEach(t => { if (t !== -1) tally[t] = (tally[t] || 0) + 1; });
    let max = 0, exec = null;
    const nums = Object.keys(tally);
    for (const num of nums) {
        if (tally[num] > max) { max = tally[num]; exec = parseInt(num); }
    }
    // 平票判定：统计最高票数是否唯一
    let tie = false;
    let topCount = 0;
    for (const num of nums) {
        if (tally[num] === max && max > 0) topCount++;
    }
    if (topCount > 1) tie = true;
    if (exec && !tie) {
        const p = room.players.find(pl => pl.number === exec);
        if (p) { p.alive = false; recordDeath(room, p, '被投票处决'); }
        broadcastToRoom(room.id, {
            type: 'executed',
            name: p?.name,
            number: exec,
            tally: Object.fromEntries(Object.entries(tally))
        });
        broadcastToRoom(room.id, { type: 'player_list', players: getPlayerList(room) });
        const winner = checkGameOver(room);
        if (winner) {
            room.phase = 'gameover';
            broadcastToRoom(room.id, {
                type: 'gameover', winner,
                roles: room.players.map(p => ({ number: p.number, name: p.name, role: p.role, alive: p.alive })),
                deathRecords: room.deathRecords
            });
            return;
        }
    } else {
        broadcastToRoom(room.id, {
            type: 'no_execution',
            tally: Object.fromEntries(Object.entries(tally))
        });
    }
    startNight(room);
}

// ... 以下 getCheckResult, isKillEffective, shouldDieFromFlip, recordDeath, checkGameOver, resetRoom 保持不变 ...

function getCheckResult(room, player, targetPlayer) {
    let checkType = getCheckType(player.role);
    // ★ 人格分裂：复制本夜随机指派目标角色的查验规则
    if (player.role === '人格分裂') {
        const copiedRole = room.copyMap.get(player.id);
        checkType = copiedRole ? getCheckType(copiedRole) : 'fixed_non_killer';
    }
    let result = '非凶手';
    switch (checkType) {
        case 'true': result = getCamp(targetPlayer.role) === 'killer' ? '是凶手' : '非凶手'; break;
        case 'fixed_killer': result = '是凶手'; break;
        case 'misconstruct': const prev = room.lastRoundAction[player.number]; result = (room.day === 1) ? '非凶手' : (prev === 'kill' ? '是凶手' : '非凶手'); break;
    }
    // ★ 虚构者：对目标施加"下次查验反转"标记（挂在被验者身上）
    if (player.role === '虚构者') room.checkModifier.set(targetPlayer.number, true);
    // ★ 被验者若带反转标记，则本次结果反转并消耗标记
    if (room.checkModifier.has(targetPlayer.number)) {
        result = result === '是凶手' ? '非凶手' : '是凶手';
        room.checkModifier.delete(targetPlayer.number);
    }
    return result;
}

function isKillEffective(room, player) {
    let killType = getKillType(player.role);
    // ★ 人格分裂：复制本夜随机指派目标角色的暗杀能力
    if (player.role === '人格分裂') {
        const copiedRole = room.copyMap.get(player.id);
        killType = copiedRole ? getKillType(copiedRole) : 'never';
    }
    switch (killType) {
        case 'always': return true;
        case 'never': return false;
        case 'conditional_awake': return room.fabricatorAwake;
        // ★ 侦探带刀：这里拿不到目标，统一在 resolveNight 里对侦探单独判断目标阵营
        case 'detective': return false;
        default: return false;
    }
}

function shouldDieFromFlip(room, player, flipCard) {
    if (flipCard === undefined || flipCard === null) return false;
    const flipType = getFlipType(player.role);
    switch (flipType) {
        case 'never_die': return false; case 'always_die': return true;
        case 'match_self': return flipCard !== player.role;
        case 'conditional_fabricator': const killerAlive = room.players.some(p => p.alive && getCamp(p.role) === 'killer' && p.role !== '虚构者'); return !killerAlive ? true : flipCard !== player.role;
        default: return true;
    }
}

function recordDeath(room, player, cause) {
    room.deathRecords.push({ number: player.number, name: player.name, role: player.role, cause, day: room.day });
    addRecord(room, player.id, `第${room.day}天：你${cause}`);
}

function checkGameOver(room) {
    const alive = room.players.filter(p => p.alive);
    const killerAlive = alive.some(p => getCamp(p.role) === 'killer');
    const goodAlive = alive.some(p => getCamp(p.role) === 'good');
    const neutralAlive = alive.filter(p => getCamp(p.role) === 'neutral');
    if (alive.length === 2 && neutralAlive.length > 0) return neutralAlive.length === 2 ? '中立阵营' : neutralAlive[0].role;
    if (!goodAlive) return '凶手阵营';
    if (!killerAlive) return '好人阵营';
    return null;
}

function resetRoom(roomId, hostId) {
    loadWSFunctions();
    const room = rooms.get(roomId);
    if (!room || room.hostId !== hostId) return false;
    room.phase = 'waiting'; room.day = 0;
    room.players.forEach(p => { p.alive = true; p.role = null; });
    room.deathRecords = []; room.playerRecords = {}; room.nightActions = []; room.votes = {};
    room.currentSpeaker = null; room.currentNightPlayer = null;
    room.lastRoundAction = {}; room.checkModifier = new Map(); room.copyMap = new Map(); // ★ 重置能力状态
    room.gameStarted = false;
    if (room.speakTimeoutId) { clearTimeout(room.speakTimeoutId); room.speakTimeoutId = null; }
    if (room.nightTimer) { clearTimeout(room.nightTimer); room.nightTimer = null; }
    if (room.voteTimeoutId) { clearTimeout(room.voteTimeoutId); room.voteTimeoutId = null; }
    broadcastToRoom(roomId, { type: 'room_reset' });
    broadcastToRoom(roomId, { type: 'player_list', players: getPlayerList(room) });
    return true;
}

// ========== 消息处理 ==========
function handleMessage(ws, playerId, msg) {
    loadWSFunctions();
    const roomId = playerRoomMap.get(playerId);
    const room = roomId ? rooms.get(roomId) : null;

    switch (msg.type) {
        case 'create': {
            const newRoomId = Math.random().toString(36).substring(2, 8).toUpperCase();
            const newRoom = createRoom(newRoomId, msg.preset, playerId, msg.name);
            if (!newRoom) return;
            sendToPlayer(playerId, {
                type: 'room_created',
                roomId: newRoomId,
                yourNumber: 1,
                preset: newRoom.presetName,
                flipCards: newRoom.flipCards,
                isHost: true,
                gameStarted: false
            });
            break;
        }
        case 'join': {
            if (!msg.roomId || !msg.name) { sendToPlayer(playerId, { type: 'error', message: '缺少参数' }); return; }
            const result = joinRoom(msg.roomId, playerId, msg.name);
            if (result) sendToPlayer(playerId, { type: 'joined', ...result });
            else sendToPlayer(playerId, { type: 'error', message: '加入失败' });
            break;
        }
        case 'spectate': {
            if (!msg.roomId || !msg.name) return;
            const success = spectateRoom(msg.roomId, playerId, msg.name);
            if (success) {
                const targetRoom = rooms.get(msg.roomId);
                sendToPlayer(playerId, { type: 'spectator_joined', roomId: msg.roomId, preset: targetRoom.presetName, players: getPlayerList(targetRoom) });
            } else sendToPlayer(playerId, { type: 'error', message: '观战失败' });
            break;
        }
        case 'kick': { if (room) kickPlayer(room.id, playerId, msg.target); break; }
        case 'start_game': { if (room) startGame(room.id, playerId); break; }
        case 'night_action': {
            if (!room || room.currentNightPlayer !== playerId) return;
            const player = room.players.find(p => p.id === playerId);
            if (player && player.alive) processNightAction(room, player, msg);
            break;
        }
        case 'end_speak': { if (room) endSpeak(room, playerId, false); break; }
        case 'vote': { if (room) processVote(room, playerId, msg.target); break; }
        case 'chat': {
            if (!room) return;
            const sender = room.players.find(p => p.id === playerId) || room.spectators.find(s => s.id === playerId);
            if (!sender) return;
            const isSpectator = room.spectators.some(s => s.id === playerId);
            const msgText = typeof msg.message === 'string' ? msg.message.trim().slice(0, 1000) : '';
            if (!msgText) return;
            // ★ 发言权限校验：夜晚/投票禁止聊天；白天仅当前发言人可聊；等待/结束后可自由聊；旁观者可聊但标记
            if (room.phase === 'night' || room.phase === 'vote') {
                if (!isSpectator) return; // 玩家在夜晚/投票禁言；旁观者仅允许看，不发言
                return;
            }
            if (room.phase === 'day' && !isSpectator) {
                if (room.currentSpeaker !== playerId) return; // 白天只有当前发言人可以聊
            }
            const name = isSpectator ? `👁️ ${sender.name}` : sender.name;
            const chatMsg = { type: 'chat', from: name, message: msgText };
            if (!room.chatHistory) room.chatHistory = [];
            room.chatHistory.push(chatMsg);
            if (room.chatHistory.length > 200) room.chatHistory.shift();
            broadcastToRoom(room.id, chatMsg);
            break;
        }
        case 'reset_room': { if (room) resetRoom(room.id, playerId); break; }
        default: sendToPlayer(playerId, { type: 'error', message: `未知消息类型: ${msg.type}` });
    }
}

// ★ 语音权限：仅白天发言阶段、当前发言人、存活玩家可发言（旁观者只收不发）
function canPlayerSpeakVoice(playerId) {
    const roomId = playerRoomMap.get(playerId);
    if (!roomId) return false;
    const room = rooms.get(roomId);
    if (!room || room.phase !== 'day') return false;
    if (room.currentSpeaker !== playerId) return false;
    const player = room.players.find(p => p.id === playerId);
    return !!player && player.alive && player.connected;
}

function handleDisconnect(playerId) {
    loadWSFunctions();
    const roomId = playerRoomMap.get(playerId);
    if (!roomId) return;
    const room = rooms.get(roomId);
    if (!room) return;
    const player = room.players.find(p => p.id === playerId);
    if (!player) {
        // 观战者断开：直接移除
        room.spectators = room.spectators.filter(s => s.id !== playerId);
        playerRoomMap.delete(playerId);
        return;
    }
    if (!room.gameStarted && room.phase === 'waiting') {
        // ★ 等待阶段：
        // 房主离开 → 解散房间并通知剩余玩家；普通玩家离开 → 移除占位（不残留幽灵房间）
        if (player.id === room.hostId) {
            rooms.delete(roomId);
            room.players.forEach(p => playerRoomMap.delete(p.id));
            room.spectators.forEach(s => playerRoomMap.delete(s.id));
            broadcastToRoom(roomId, { type: 'room_dissolved', message: '房主已离开，房间解散' });
        } else {
            room.players = room.players.filter(p => p.id !== playerId);
            playerRoomMap.delete(playerId);
            broadcastToRoom(roomId, { type: 'player_list', players: getPlayerList(room) });
        }
        return;
    }
    // 游戏中 / 已结束：标记离线，可重连恢复
    player.connected = false;
    broadcastToRoom(roomId, { type: 'player_list', players: getPlayerList(room) });
}

module.exports = {
    createRoom, getRoom, getPublicRooms, joinRoom,
    spectateRoom, kickPlayer, startGame, resetRoom,
    handleMessage, handleDisconnect,
    canPlayerSpeakVoice,   // ★ 语音权限校验
    playerRoomMap
};