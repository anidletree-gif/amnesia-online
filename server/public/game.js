(function(){
    "use strict";

    // ========== 用户状态 ==========
    let currentUser = null;
    try {
        const stored = localStorage.getItem('amnesia_user');
        if (stored) currentUser = JSON.parse(stored);
    } catch(e) { currentUser = null; }

    if (!currentUser || !currentUser.email) {
        location.href = '/login.html';
        return;
    }

    // ========== DOM 元素 ==========
    const getEl = id => document.getElementById(id);
    const avatarImg = getEl('avatarImg');
    const userNickname = getEl('userNickname');
    const chatLog = getEl('chatLogArea');
    const loginPanel = getEl('loginPanel');
    const gamePanel = getEl('gamePanel');
    const gameCornerButtons = getEl('gameCornerButtons');
    const roomCodeSpan = getEl('roomCodeDisplay');
    const statusArea = getEl('statusArea');
    const presetInfo = getEl('presetInfo');
    const playerListDiv = getEl('playerList');
    const startBtn = getEl('startGameBtn');
    const actionCard = getEl('actionCard');
    const chatInput = getEl('chatInput');
    const sendChatBtn = getEl('sendChatBtn');
    const presetSelect = getEl('presetSelect');
    const publicRoomCheck = getEl('publicRoomCheck');
    const createPanel = getEl('createPanel');
    const joinPanel = getEl('joinPanel');
    const roomIdInput = getEl('roomIdInput');
    const startBtnText = getEl('startBtnText');

    if (userNickname) {
    userNickname.textContent = currentUser.nickname;
    userNickname.style.cursor = 'pointer';
    userNickname.title = '点击修改昵称';
    userNickname.onclick = async () => {
        const nn = prompt('输入新昵称（1-12位，中文/字母/数字）', currentUser.nickname || '');
        if (!nn || nn.trim() === currentUser.nickname) return;
        try {
            const r = await fetch('/api/update-nickname', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email: currentUser.email, nickname: nn.trim() })
            });
            const d = await r.json();
            if (r.ok) {
                currentUser.nickname = d.nickname;
                localStorage.setItem('amnesia_user', JSON.stringify(currentUser));
                userNickname.textContent = d.nickname;
                alert('昵称已更新为：' + d.nickname);
            } else {
                alert(d.error || '修改失败');
            }
        } catch(e) { alert('网络错误，请重试'); }
    };
}
if (avatarImg) {
        avatarImg.src = currentUser.avatar || '/avatars/default.png';
        avatarImg.onerror = function() {
            this.src = 'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 40 40%22%3E%3Ccircle cx=%2220%22 cy=%2220%22 r=%2220%22 fill=%22%234a3a2a%22/%3E%3Ctext x=%2220%22 y=%2226%22 text-anchor=%22middle%22 fill=%22%23d4c9b8%22 font-size=%2218%22%3E?%3C/text%3E%3C/svg%3E';
        };
    }

    // 创建右上角阶段指示器
    const phaseIndicator = document.createElement('div');
    phaseIndicator.id = 'phaseIndicator';
    phaseIndicator.style.cssText = 'position:fixed;top:10px;right:10px;background:rgba(0,0,0,0.7);color:#d4c9b8;padding:6px 14px;border-radius:12px;font-size:14px;z-index:9999;';
    document.body.appendChild(phaseIndicator);

    // ========== 游戏状态 ==========
    let ws = null;
    let roomId = null;
    let myNumber = null;
    let isHost = false;
    let isSpectator = false;
    let phase = 'waiting';
    let players = [];
    let currentSpeaker = null;
    let flipCards = [];
    let allMessages = [];
    let currentDay = 0;
    let roleImages = {};
    let overlayDiv = null;
    let isDead = false;
    let speakInterval = null;
    let speakRemaining = 0;
    let canSpeak = false;
    let hasVoted = false;

    // ========== 语音 ==========
    let audioContext = null;
    let mediaStream = null;
    let mediaRecorder = null;
    let isSpeaking = false;
    let analyserNode = null;
    let volumeInterval = null;
    let speakingLock = false;
    const MAX_QUEUE_LEN = 10;

    // ========== WebRTC 语音（★ P2P：媒体直连，服务器只转信令，语音零服务器压力） ==========
    const RTC_CONFIG = { iceServers: [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }] };
    const webRTCSupported = typeof RTCPeerConnection !== 'undefined';
    const peerConnections = new Map(); // number -> RTCPeerConnection（房间内唯一编号寻址）
    const remoteAudios = new Map();    // number -> HTMLAudioElement（接收播放）
    const pendingIce = new Map();      // number -> RTCIceCandidate[]（remoteDescription 就绪前缓存）
    let makingOffer = false;           // 全局协商锁（8人小房间串行协商，避免并发 offer 风暴）

    // ========== 辅助函数 ==========
    function safeSetText(el, text) { if(el) el.innerText = text; }
    function safeDisplay(el, val) { if(el) el.style.display = val; }
    function safeEnable(el, enable) { if(el) el.disabled = !enable; }

    function addChatLog(msg) {
        if(!chatLog) return;
        const d = document.createElement('div');
        d.textContent = '· ' + msg;
        chatLog.appendChild(d);
        chatLog.scrollTop = chatLog.scrollHeight;
        while(chatLog.children.length > 30) chatLog.removeChild(chatLog.firstChild);
        allMessages.push(msg);
        if(allMessages.length > 200) allMessages.shift();
    }

    function clearChat() { if(chatLog) chatLog.innerHTML = ''; allMessages = []; }
    function enableChat(enable) { safeEnable(chatInput, enable); safeEnable(sendChatBtn, enable); }

    function showToast(text, isGood = true) {
        const t = getEl('checkResultToast');
        if(!t) return;
        t.textContent = text;
        t.style.display = 'block';
        t.style.background = isGood ? 'rgba(25,30,28,0.9)' : 'rgba(60,30,30,0.9)';
        setTimeout(() => t.style.display = 'none', 4000);
    }

    // ========== 语音核心 ==========
    // ★★★ WebRTC P2P 语音（媒体不经过服务器；信令走 WS JSON 通道） ★★★
    function sendSignal(targetNumber, signal) {
        if (!ws || ws.readyState !== 1) return;
        try { ws.send(JSON.stringify({ type: 'signal', targetNumber, signal })); } catch(e) {}
    }

    function createRemoteAudio(number, stream) {
        let audio = remoteAudios.get(number);
        if (!audio) {
            audio = new Audio();
            audio.autoplay = true;
            remoteAudios.set(number, audio);
        }
        try { audio.srcObject = stream; audio.play().catch(() => {}); } catch(e) {}
    }

    function handleRemoteTrack(number, event) {
        const stream = (event.streams && event.streams[0]) ? event.streams[0] : new MediaStream([event.track]);
        createRemoteAudio(number, stream);
    }

    function ensurePeerConnection(number) {
        if (number === myNumber) return null;
        const existing = peerConnections.get(number);
        if (existing && existing.connectionState !== 'failed' && existing.connectionState !== 'closed') return existing;
        if (existing) { try { existing.close(); } catch(_) {} peerConnections.delete(number); }
        if (!webRTCSupported) return null;
        let pc;
        try { pc = new RTCPeerConnection(RTC_CONFIG); } catch(e) { console.error('创建 RTCPeerConnection 失败', e); return null; }
        peerConnections.set(number, pc);
        pc.onicecandidate = (e) => {
            if (e.candidate) sendSignal(number, { type: 'candidate', candidate: e.candidate.toJSON ? e.candidate.toJSON() : e.candidate });
        };
        pc.ontrack = (event) => handleRemoteTrack(number, event);
        pc.onconnectionstatechange = () => {
            const st = pc.connectionState;
            if (st === 'failed' || st === 'closed' || st === 'disconnected') {
                if (peerConnections.get(number) === pc) { try { pc.close(); } catch(_) {} peerConnections.delete(number); }
                const ra = remoteAudios.get(number);
                if (ra) { try { ra.pause(); ra.srcObject = null; } catch(_) {} remoteAudios.delete(number); }
            }
        };
        // ★ 双方都注册协商回调，用 polite/impolite 处理 glare（小号 polite）
        pc.onnegotiationneeded = async () => {
            if (makingOffer || pc.signalingState !== 'stable') return;
            makingOffer = true;
            try {
                await pc.setLocalDescription(await pc.createOffer());
                sendSignal(number, { type: 'offer', sdp: pc.localDescription });
            } catch(e) { console.error('createOffer 失败', e); }
            finally { makingOffer = false; }
        };
        return pc;
    }

    function flushPendingIce(number) {
        const list = pendingIce.get(number);
        if (!list || list.length === 0) return;
        pendingIce.delete(number);
        const pc = peerConnections.get(number);
        if (!pc) return;
        list.forEach(c => { try { pc.addIceCandidate(c); } catch(e) {} });
    }

    async function handleSignal(fromNumber, signal) {
        if (!signal || typeof signal.type !== 'string') return;
        const polite = myNumber < fromNumber; // 小号 polite
        const pc = ensurePeerConnection(fromNumber);
        if (!pc) return;
        try {
            if (signal.type === 'offer') {
                const collision = pc.signalingState !== 'stable' || makingOffer;
                if (collision) {
                    if (!polite) return; // impolite：忽略冲突 offer（对方会再协商）
                    await Promise.all([
                        pc.setLocalDescription({ type: 'rollback' }),
                        pc.setRemoteDescription({ type: 'offer', sdp: signal.sdp })
                    ]);
                } else {
                    await pc.setRemoteDescription({ type: 'offer', sdp: signal.sdp });
                }
                await pc.setLocalDescription(await pc.createAnswer());
                sendSignal(fromNumber, { type: 'answer', sdp: pc.localDescription });
                flushPendingIce(fromNumber);
            } else if (signal.type === 'answer') {
                await pc.setRemoteDescription({ type: 'answer', sdp: signal.sdp });
                flushPendingIce(fromNumber);
            } else if (signal.type === 'candidate') {
                if (pc.remoteDescription) {
                    await pc.addIceCandidate(signal.candidate);
                } else {
                    if (!pendingIce.has(fromNumber)) pendingIce.set(fromNumber, []);
                    pendingIce.get(fromNumber).push(signal.candidate);
                }
            }
        } catch(e) {
            console.error('信令处理失败', e);
        }
    }

    function attachLocalTrackToPeers() {
        if (!mediaStream) return;
        const track = mediaStream.getAudioTracks()[0];
        if (!track) return;
        peerConnections.forEach((pc) => {
            try {
                const has = pc.getSenders().some(s => s.track === track);
                if (!has) pc.addTrack(track, mediaStream);
            } catch(e) {}
        });
    }

    // ★ 按当前房间玩家列表同步 peer 连接：清理已离开的，为在房玩家建立连接
    function reconcilePeers() {
        if (!players || players.length === 0 || myNumber == null) return;
        const numbers = new Set(players.filter(p => p.number !== myNumber).map(p => p.number));
        peerConnections.forEach((pc, number) => {
            if (!numbers.has(number)) {
                try { pc.close(); } catch(_) {}
                peerConnections.delete(number);
                const ra = remoteAudios.get(number);
                if (ra) { try { ra.pause(); ra.srcObject = null; } catch(_) {} remoteAudios.delete(number); }
            }
        });
        if (!webRTCSupported) return;
        numbers.forEach(number => ensurePeerConnection(number));
    }

    function teardownPeers() {
        peerConnections.forEach((pc) => { try { pc.close(); } catch(_) {} });
        peerConnections.clear();
        remoteAudios.forEach((a) => { try { a.pause(); a.srcObject = null; } catch(_) {} });
        remoteAudios.clear();
        pendingIce.clear();
    }

    function initAudioContext() {
        if (audioContext && audioContext.state !== 'closed') return audioContext;
        audioContext = new (window.AudioContext || window.webkitAudioContext)();
        return audioContext;
    }

        // ★ 停止音量分析（WebRTC 发言结束：静音即可，保留连接零延迟）
    function stopVolumeMeter() {
        if (volumeInterval) { clearInterval(volumeInterval); volumeInterval = null; }
        if (analyserNode) { try { analyserNode.disconnect(); } catch (e) {} analyserNode = null; }
        isSpeaking = false;
        updatePlayerVolume(myNumber, 0);
        if (ws && ws.readyState === 1) {
            try { ws.send(JSON.stringify({ type: 'volume', number: myNumber, volume: 0 })); } catch(e) {}
        }
    }

    // ★ 完全释放本地麦克风（仅退出/断线/降级通道时调用）
    function releaseMic() {
        if (mediaStream) {
            mediaStream.getTracks().forEach(t => t.stop());
            mediaStream = null;
        }
        stopVolumeMeter();
    }

    async function destroyRecorder() {
        if (mediaRecorder) {
            try {
                mediaRecorder.ondataavailable = null;
                mediaRecorder.onerror = null;
                if (mediaRecorder.state !== 'inactive') mediaRecorder.stop();
            } catch (e) {}
            mediaRecorder = null;
        }
        releaseMic();
    }

    async function startSpeaking() {
        if (speakingLock) return;
        speakingLock = true;
        try {
            const ctx = initAudioContext();
            if (ctx.state === 'suspended') await ctx.resume();
            // ★ WebRTC 主通道：复用麦克风推流到所有 peer（无 MediaRecorder，零服务器音频流量）
            if (webRTCSupported && peerConnections.size > 0) {
                if (!mediaStream || mediaStream.getAudioTracks().length === 0) {
                    mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
                }
                const track = mediaStream.getAudioTracks()[0];
                if (track) track.enabled = true; // 解除静音
                attachLocalTrackToPeers();
            } else {
                // ★ 降级通道：WebRTC 不可用/无人可连 -> 旧 MediaRecorder -> WS 转发
                mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
            }
            const source = ctx.createMediaStreamSource(mediaStream);
            analyserNode = ctx.createAnalyser();
            analyserNode.fftSize = 256;
            source.connect(analyserNode);
            volumeInterval = setInterval(() => {
                const dataArray = new Uint8Array(analyserNode.frequencyBinCount);
                analyserNode.getByteTimeDomainData(dataArray);
                let sum = 0;
                for (let i = 0; i < dataArray.length; i++) {
                    const v = (dataArray[i] - 128) / 128;
                    sum += v * v;
                }
                const vol = Math.min(1, Math.sqrt(sum / dataArray.length) * 2);
                updatePlayerVolume(myNumber, vol);
                if (ws && ws.readyState === 1) {
                    try { ws.send(JSON.stringify({ type: 'volume', number: myNumber, volume: vol })); } catch(e) {}
                }
            }, 100);
            if (webRTCSupported && peerConnections.size > 0) {
                // WebRTC 模式：无需 MediaRecorder
                isSpeaking = true;
            } else {
                const mimeType = 'audio/webm; codecs=opus';
                if (!MediaRecorder.isTypeSupported(mimeType)) throw new Error("不支持Opus");
                mediaRecorder = new MediaRecorder(mediaStream, { mimeType, audioBitsPerSecond: 16000 });
                mediaRecorder.ondataavailable = (e) => {
                    if (e.data && e.data.size > 0) {
                        e.data.arrayBuffer().then(buf => {
                            if (ws && ws.readyState === WebSocket.OPEN) {
                                try { ws.send(buf); } catch(e) {}
                            }
                        });
                    }
                };
                mediaRecorder.onerror = (err) => { console.error(err); destroyRecorder(); };
                mediaRecorder.start(20);
                isSpeaking = true;
            }
        } catch (e) {
            console.error(e);
            alert("无法启动麦克风：" + e.message);
            await destroyRecorder();
        } finally { speakingLock = false; }
    }

    async function stopRecording() {
        // ★ WebRTC 模式：只静音推流（保留连接与麦克风，下次按住说话零延迟）
        if (webRTCSupported && mediaStream && mediaStream.getAudioTracks().length > 0 && peerConnections.size > 0) {
            const track = mediaStream.getAudioTracks()[0];
            if (track) track.enabled = false;
            stopVolumeMeter();
            return;
        }
        await destroyRecorder();
    }
    async function endTurn() { await destroyRecorder(); if (ws) ws.send(JSON.stringify({ type: 'end_speak' })); }

    // ========== 语音接收（★ 重构：按发言人独立 MediaSource 播放链） ==========
    // 根因：旧实现所有发言人共用同一个 SourceBuffer，每个 MediaRecorder 会话自带 init segment，
    // 第二次发言追加新 init 段会与已初始化的解码器冲突 -> 没声音；失败回调还无限递归导致卡死。
    // 新架构：每个发言人的一次发言会话独占 MediaSource；静默超时后 endOfStream 播放并结束会话，
    // 下次（同一人或他人）发言自动新建会话，天然解决"第二次按住没声音"。
    const AUDIO_MIME = 'audio/webm; codecs=opus';
    const AUDIO_SESSION_IDLE_MS = 800;   // 静默超过该时长判定本次发言结束
    const audioSessions = new Map();      // number -> session

    function cleanupAudioSession(s) {
        if (s.endTimer) { clearTimeout(s.endTimer); s.endTimer = null; }
        if (s.sourceBuffer) { try { s.sourceBuffer.abort(); } catch(e) {} s.sourceBuffer = null; }
        if (s.mediaSource) {
            try { if (s.mediaSource.readyState === 'open') s.mediaSource.endOfStream(); } catch(e) {}
            s.mediaSource = null;
        }
        if (s.audio) {
            try { s.audio.pause(); URL.revokeObjectURL(s.audio.src); s.audio = null; } catch(e) {}
        }
        s.ended = true; s.busy = false; s.chunks = [];
    }

    function failAudioSession(s) {
        s.failed = true;
        cleanupAudioSession(s);
    }

    function getOrCreateAudioSession(number) {
        const existing = audioSessions.get(number);
        if (existing && !existing.ended && !existing.failed) return existing;
        // 旧会话已结束/失败 -> 重建全新会话（关键：新 MediaSource 接受新 init 段）
        if (existing) cleanupAudioSession(existing);
        const s = { number, chunks: [], busy: false, ended: false, failed: false,
                    endTimer: null, mediaSource: null, sourceBuffer: null, audio: null };
        audioSessions.set(number, s);
        try {
            const ms = new MediaSource();
            s.mediaSource = ms;
            const audio = new Audio();
            s.audio = audio;
            audio.src = URL.createObjectURL(ms);
            ms.addEventListener('sourceopen', () => {
                if (s.ended || s.failed || !s.mediaSource) return;
                try {
                    if (MediaSource.isTypeSupported(AUDIO_MIME)) {
                        const sb = ms.addSourceBuffer(AUDIO_MIME);
                        sb.mode = 'segments';
                        s.sourceBuffer = sb;
                        sb.addEventListener('updateend', () => {
                            s.busy = false;
                            flushAudioSession(s);
                        });
                        flushAudioSession(s); // 追加 sourceopen 前已排队的块
                    }
                } catch (e) {
                    console.error('语音会话初始化失败', e);
                    failAudioSession(s);
                }
            });
            audio.play().catch(() => {}); // 可能被自动播放策略拦截，catch 静默
        } catch (e) {
            console.error('创建语音会话失败', e);
            failAudioSession(s);
        }
        return s;
    }

    function flushAudioSession(s) {
        if (s.ended || s.failed || !s.sourceBuffer || s.sourceBuffer.updating || s.busy) return;
        if (s.chunks.length === 0) return;
        s.busy = true;
        const buf = s.chunks.shift();
        try {
            s.sourceBuffer.appendBuffer(buf);
        } catch (e) {
            // ★ 追加失败（init 段冲突/配额超限）：绝不无限递归，清空并标记失败，下次数据自动重建
            console.error('语音追加失败，该会话将重建', e);
            s.failed = true;
            s.chunks = [];
            s.busy = false;
            audioSessions.delete(s.number);
        }
    }

    function handleAudioChunk(number, payload) {
        if (!payload || payload.byteLength === 0) return;
        const s = getOrCreateAudioSession(number);
        if (s.ended || s.failed) return; // 会话不可用（清理中），丢弃本块，下次数据会重建
        if (s.endTimer) { clearTimeout(s.endTimer); s.endTimer = null; }
        // ★ 静默超时结束会话：endOfStream 开始播放，并延迟清理（期间新数据会重建新会话）
        s.endTimer = setTimeout(() => {
            s.ended = true;
            if (s.mediaSource && s.sourceBuffer && !s.sourceBuffer.updating) {
                try { s.mediaSource.endOfStream(); } catch(e) {}
            }
            if (s.audio) { try { s.audio.play().catch(() => {}); } catch(_) {} }
            setTimeout(() => {
                const cur = audioSessions.get(number);
                if (cur === s) { audioSessions.delete(number); cleanupAudioSession(s); }
            }, 10000);
        }, AUDIO_SESSION_IDLE_MS);
        s.chunks.push(payload);
        while (s.chunks.length > MAX_QUEUE_LEN) s.chunks.shift();
        flushAudioSession(s);
    }

    function resetRemoteAudio() {
        // 新发言人开始：结束所有仍在接收的会话（正在播放的音频保留播完）
        audioSessions.forEach((s, num) => {
            if (s.endTimer) { clearTimeout(s.endTimer); s.endTimer = null; }
            if (s.mediaSource && s.sourceBuffer && !s.sourceBuffer.updating) {
                try { s.mediaSource.endOfStream(); } catch(e) {}
            }
            if (s.audio) { try { s.audio.play().catch(() => {}); } catch(_) {} }
            s.ended = true;
            setTimeout(() => {
                const cur = audioSessions.get(num);
                if (cur === s) { audioSessions.delete(num); cleanupAudioSession(s); }
            }, 10000);
        });
    }

    function updatePlayerVolume(playerNumber, volume) {
        const el = document.querySelector(`.player-volume-bar[data-number="${playerNumber}"]`);
        if (el) { el.style.width = (volume * 100) + '%'; el.style.opacity = volume > 0.05 ? 1 : 0; }
    }

    // ========== 按钮逻辑 ==========
    function updateStartButton() {
        if (!startBtn) return;
        if (phase !== 'waiting' || isSpectator) { startBtn.style.display = 'none'; return; }
        startBtn.style.display = 'block';
        let req = 6;
        try {
            const opt = presetSelect?.selectedOptions?.[0];
            if (opt) { const match = opt.text.match(/\d+/); if (match) req = parseInt(match[0]); }
        } catch(e) { req = 6; }
        const btnText = getEl('startBtnText');
        if (players.length < req) {
            if (btnText) btnText.textContent = '⏳ 等待其他人员…';
            startBtn.disabled = true; return;
        }
        if (isHost) { if (btnText) btnText.textContent = '▶ 激活档案'; startBtn.disabled = false; }
        else { if (btnText) btnText.textContent = '⏳ 等待房主开始…'; startBtn.disabled = true; }
    }

    // ========== WebSocket ==========
    function connectWebSocket() {
        if (ws && ws.readyState === 1) return;
        if (ws) { ws.onclose = null; ws.close(); }
        ws = new WebSocket((location.protocol === 'https:' ? 'wss:' : 'ws:') + '//' + location.host + '?playerId=' + encodeURIComponent(currentUser.email));
        ws.binaryType = 'arraybuffer';

        ws.onopen = () => {
            console.log('WebSocket 连接成功');
            if (statusArea) statusArea.innerText = statusArea.innerText.replace('🔴 连接断开，重连中…', '');
        };
ws.onclose = () => {
    destroyRecorder();
    if (statusArea) statusArea.innerText = '🔴 连接断开，重连中…';
    addChatLog('❌ 连接断开，尝试重连...');
    if (roomId) setTimeout(connectWebSocket, 3000);
};

        ws.onmessage = (e) => {
            if (e.data instanceof ArrayBuffer) {
                // ★ 新协议：前4字节为大端发言人编号，其后为音频数据
                if (e.data.byteLength >= 4) {
                    const dv = new DataView(e.data);
                    const speakerNumber = dv.getUint32(0, false);
                    handleAudioChunk(speakerNumber, e.data.slice(4));
                }
                return;
            }
            try {
                const msg = JSON.parse(e.data);
                if (msg.type === 'connected') return;
                if (msg.type === 'kicked_offline') {
                    // ★ 账号在其他设备登录：停止重连并跳回登录页
                    alert(msg.message || '账号已在其他设备登录');
                    try { ws.onclose = null; ws.close(); } catch(_) {}
                    location.href = '/login.html';
                    return;
                }
                if (msg.type === 'error') { alert(msg.message); return; }
                                if (msg.type === 'volume') { updatePlayerVolume(msg.number, msg.volume); return; }
                if (msg.type === 'signal') { handleSignal(msg.fromNumber, msg.signal); return; }
                if (msg.type === 'game_in_progress') {
                    if (confirm('游戏已开始，是否观战？')) ws.send(JSON.stringify({ type:'spectate', roomId:msg.roomId, name:currentUser.nickname }));
                    else ws.close();
                    return;
                }
                if (msg.type === 'state_sync') {
                    isSpeaking = false; speakingLock = false;
                    if (speakInterval) { clearInterval(speakInterval); speakInterval = null; }
                    destroyRecorder();
                    phase = msg.phase; currentDay = msg.day || 0; myNumber = msg.myNumber;
                    isHost = !!msg.isHost; isDead = !msg.alive; flipCards = msg.flipCards || [];
                    canSpeak = false; currentSpeaker = msg.currentSpeaker || null;
                    speakRemaining = msg.speakRemaining || 0; hasVoted = false;
                    if (msg.players) {
                        players = msg.players;
                        const me = players.find(p => p.number === myNumber);
                        if (me) { isHost = !!me.isHost; isDead = !me.alive; }
                        renderPlayerList();
                        // ★ WebRTC：按最新房间成员同步 P2P 连接（离开的关闭，在房的建立）
                        reconcilePeers();
                    }
                    if (msg.chatHistory && chatLog) {
                        chatLog.innerHTML = '';
                        msg.chatHistory.forEach(m => addChatLog(m.from + ': ' + m.message));
                    }
                    if (overlayDiv) { overlayDiv.remove(); overlayDiv = null; }
                    if (statusArea) statusArea.innerText = '';
                    switch (msg.phase) {
                        case 'waiting':
                            safeSetText(statusArea, '等待开始');
                            safeDisplay(actionCard, 'none');
                            enableChat(true);
                            updateStartButton();
                            phaseIndicator.textContent = '等待开始';
                            break;
                        case 'night':
                            safeSetText(statusArea, `🌙 第${currentDay}夜`);
                            if (msg.isMyTurn) showNightActions();
                            else { safeDisplay(actionCard, 'block'); if(actionCard) actionCard.innerHTML = '<p class="text-center py-8">夜幕降临…等待他人行动</p>'; }
                            enableChat(false);
                            safeDisplay(startBtn, 'none');
                            phaseIndicator.textContent = `🌙 第${currentDay}夜`;
                            break;
                        case 'day':
                            safeSetText(statusArea, `☀️ 第${currentDay}天`);
                            if (msg.currentSpeaker) {
                                currentSpeaker = msg.currentSpeaker;
                                speakRemaining = msg.speakRemaining || 120;
                                canSpeak = !!msg.isMyTurn;
                                showSpeakUI(currentSpeaker, canSpeak);
                            } else {
                                safeDisplay(actionCard, 'block');
                                if(actionCard) actionCard.innerHTML = '<p class="text-center py-8">等待发言…</p>';
                                enableChat(false);
                            }
                            safeDisplay(startBtn, 'none');
                            phaseIndicator.textContent = `☀️ 第${currentDay}天`;
                            break;
                        case 'vote':
                            safeSetText(statusArea, '🗳️ 投票阶段');
                            showVoteOptions();
                            enableChat(false);
                            safeDisplay(startBtn, 'none');
                            phaseIndicator.textContent = '🗳️ 投票阶段';
                            break;
                        case 'gameover':
                            safeSetText(statusArea, '游戏结束');
                            safeDisplay(actionCard, 'none');
                            enableChat(true);
                            safeDisplay(startBtn, 'none');
                            phaseIndicator.textContent = '游戏结束';
                            break;
                    }
                    return;
                }
                if (msg.type === 'spectator_joined') {
                    isSpectator = true; roomId = msg.roomId;
                    safeSetText(roomCodeSpan, roomId); safeSetText(presetInfo, '档案: ' + msg.preset);
                    safeDisplay(loginPanel, 'none'); safeDisplay(gamePanel, 'block'); safeDisplay(gameCornerButtons, 'flex');
                    enableChat(true); safeDisplay(startBtn, 'none'); safeDisplay(actionCard, 'none');
                    phaseIndicator.textContent = '观战中';
                    return;
                }
                if (msg.type === 'room_created') {
                    roomId = msg.roomId; myNumber = msg.yourNumber; isHost = !!msg.isHost;
                    phase = 'waiting'; flipCards = msg.flipCards || [];
                    safeSetText(roomCodeSpan, roomId); safeSetText(presetInfo, '档案: ' + msg.preset);
                    safeDisplay(loginPanel, 'none'); safeDisplay(gamePanel, 'block'); safeDisplay(gameCornerButtons, 'flex');
                    enableChat(true); updateStartButton();
                    phaseIndicator.textContent = '等待开始';
                } else if (msg.type === 'joined') {
      roomId = msg.roomId; myNumber = msg.yourNumber; isHost = !!msg.isHost;
      flipCards = msg.flipCards || [];
      safeSetText(roomCodeSpan, roomId); safeSetText(presetInfo, '档案: ' + msg.preset);
      safeDisplay(loginPanel, 'none'); safeDisplay(gamePanel, 'block'); safeDisplay(gameCornerButtons, 'flex');
      enableChat(true); updateStartButton();
      phaseIndicator.textContent = '等待开始';
      // ★ WebRTC：加入后同步 P2P 连接（player_list 可能先于 joined 到达导致此前 reconcile 被 myNumber 门控跳过）
      reconcilePeers();
    } else if (msg.type === 'player_list') {
      players = Array.isArray(msg.players) ? msg.players : [];
      const me = players.find(p => p.number === myNumber);
      if (me) { isHost = !!me.isHost; isDead = !me.alive; }
      renderPlayerList(); updateStartButton();
      // ★ WebRTC：玩家列表变化时同步 P2P 连接（离开的关闭，新来的建立）
      reconcilePeers();
    } else if (msg.type === 'game_started') {
                    phase = 'playing'; addChatLog('🎲 档案激活'); clearChat();
                    safeDisplay(startBtn, 'none'); renderPlayerList();
                } else if (msg.type === 'phase') {
                    phase = msg.phase; currentDay = msg.day;
                    if (msg.phase !== 'vote') hasVoted = false;
                    if (msg.phase === 'waiting') {
                        safeSetText(statusArea, '等待开始'); safeDisplay(actionCard, 'none'); enableChat(true); updateStartButton();
                        phaseIndicator.textContent = '等待开始';
                    } else if (msg.phase === 'night') {
                        safeSetText(statusArea, `🌙 第${msg.day}夜`);
                        safeDisplay(actionCard, 'block'); actionCard.innerHTML = '<p class="text-center py-8">夜幕降临…</p>';
                        enableChat(false); destroyRecorder();
                        phaseIndicator.textContent = `🌙 第${msg.day}夜`;
                    } else if (msg.phase === 'day') {
                        safeSetText(statusArea, `☀️ 第${msg.day}天`);
                        enableChat(false); destroyRecorder();
                        if(msg.killedNames) addChatLog('🌅 死者: '+msg.killedNames);
                        phaseIndicator.textContent = `☀️ 第${msg.day}天`;
                        // ★ 修复：直接使用附带发言人信息启动发言
                        if (msg.currentSpeaker) {
                            currentSpeaker = msg.currentSpeaker;
                            speakRemaining = msg.speakRemaining || 120;
                            canSpeak = (currentSpeaker === myNumber);
                            showSpeakUI(currentSpeaker, canSpeak);
                        } else {
                            safeDisplay(actionCard, 'block');
                            if(actionCard) actionCard.innerHTML = '<p class="text-center py-8">等待发言…</p>';
                        }
                    } else if (msg.phase === 'vote') {
                        safeSetText(statusArea, '🗳️ 投票阶段'); showVoteOptions(); enableChat(false); safeDisplay(startBtn, 'none');
                        phaseIndicator.textContent = '🗳️ 投票阶段';
                    }
                } else if (msg.type === 'your_turn') {
                    if (!isSpectator) { safeSetText(statusArea, '🌙 你的回合 · 请行动'); showNightActions(); }
                } else if (msg.type === 'check_result') {
                    addChatLog(`🔍 第${msg.day}夜：查验 ${msg.targetName} 为 ${msg.result}`);
                    showToast(`🔍 ${msg.result}`, msg.result !== '是凶手');
                } else if (msg.type === 'speak_start') {
                    // 如果已经通过 phase 消息设置了同一个发言人，仅更新倒计时
                    if (currentSpeaker === msg.speaker) {
                        speakRemaining = msg.maxTime || 120;
                        const timerEl = getEl('speakTimer');
                        if (timerEl) timerEl.textContent = speakRemaining + '秒';
                        return;
                    }
                    // 新发言人
                    resetRemoteAudio();
                    currentSpeaker = msg.speaker;
                    speakRemaining = msg.maxTime || 120;
                    canSpeak = (msg.speaker === myNumber);
                    showSpeakUI(msg.speaker, canSpeak);
                } else if (msg.type === 'speak_end') {
                    stopSpeakCountdown(); currentSpeaker = null; enableChat(false); destroyRecorder();
                    if(!isSpectator && actionCard) actionCard.innerHTML = '<p class="text-center py-4">发言结束，准备投票</p>';
                } else if (msg.type === 'vote_start') {
                    phase = 'vote'; hasVoted = false; showVoteOptions();
                } else if (msg.type === 'executed') {
                    let voteInfo = '投票结果：';
                    if (msg.tally) {
                        for (let [num, cnt] of Object.entries(msg.tally)) {
                            voteInfo += `${num}号:${cnt}票 `;
                        }
                    }
                    addChatLog(voteInfo);
                    if (msg.name) addChatLog(`⚖️ ${msg.name} 被处决`);
                } else if (msg.type === 'no_execution') {
                    let voteInfo = '投票结果：';
                    if (msg.tally) {
                        for (let [num, cnt] of Object.entries(msg.tally)) {
                            voteInfo += `${num}号:${cnt}票 `;
                        }
                    }
                    addChatLog(voteInfo);
                    addChatLog('⚖️ 今日无人被处决');
                } else if (msg.type === 'gameover') {
                    phase = 'gameover'; stopSpeakCountdown(); safeDisplay(startBtn, 'none'); enableChat(true); destroyRecorder();
                    phaseIndicator.textContent = '游戏结束';
                    if(!isSpectator && actionCard) {
                        let h = `<h3>${msg.winner} 胜利</h3><div class="max-h-40 overflow-y-auto my-2">`;
                        msg.roles.sort((a,b) => a.number - b.number).forEach(r => h += `<div>${r.number}号 ${r.name}: ${r.role} ${r.alive ? '' : '☠️'}</div>`);
                        h += '</div>'; if(isHost) h += '<button class="memory-btn w-full mt-4" id="resetRoomBtn">↻ 重新激活</button>';
                        actionCard.innerHTML = h;
                        if(isHost) { const btn = getEl('resetRoomBtn'); if(btn) btn.onclick = () => ws.send(JSON.stringify({ type: 'reset_room' })); }
                    }
                } else if (msg.type === 'room_reset') {
                    phase = 'waiting'; isDead = false; hasVoted = false;
                    renderPlayerList(); safeDisplay(startBtn, 'block'); updateStartButton();
                    if(actionCard) actionCard.innerHTML = ''; safeSetText(statusArea, '等待唤醒'); clearChat(); enableChat(true); destroyRecorder();
                    addChatLog('🔄 房间已重置');
                    phaseIndicator.textContent = '等待开始';
                } else if (msg.type === 'chat') { 
                    addChatLog(msg.from + ': ' + msg.message); 
                } else if (msg.type === 'kicked') { alert(msg.message); location.reload(); }
            } catch(ex) {}
        };
    }

    // ========== 发言 UI ==========
    function showSpeakUI(speakerNumber, isMyTurn) {
        const name = players.find(p => p.number === speakerNumber)?.name || speakerNumber + '号';
        safeSetText(statusArea, `🎤 发言: ${name} (${speakRemaining}s)`);
        if (!isSpectator && actionCard) {
            let html = `<div class="text-center py-4"><p>轮到 ${name} 发言</p><div id="speakTimer" class="text-2xl font-bold my-2">${speakRemaining}秒</div>`;
            if (isMyTurn) {
                html += `<div class="flex gap-3 justify-center items-center mt-3">
                    <button id="pttBtn" class="memory-btn w-auto px-6 py-3 select-none" style="user-select:none; touch-action:none; transition: transform 0.1s;">
                        🎙️ 按住说话
                    </button>
                    <button id="endTurnBtn" class="memory-btn w-auto px-4 py-3" style="background:linear-gradient(145deg, #4a2a2a, #2e1a1a); border-color:#a06060;">
                        结束发言
                    </button>
                </div>`;
            }
            html += '</div>';
            actionCard.innerHTML = html;

            if (isMyTurn) {
                enableChat(true);
                const pttBtn = getEl('pttBtn');
                const endTurnBtn = getEl('endTurnBtn');
                if (pttBtn) {
                    const startRecord = async (e) => { e.preventDefault(); await startSpeaking(); if (pttBtn) { pttBtn.style.transform = 'scale(0.95)'; pttBtn.textContent = '🎙️ 录音中…'; } };
                    const stopRecord = async (e) => { e.preventDefault(); await stopRecording(); if (pttBtn) { pttBtn.style.transform = 'scale(1)'; pttBtn.textContent = '🎙️ 按住说话'; } };
                    pttBtn.addEventListener('mousedown', startRecord);
                    pttBtn.addEventListener('mouseup', stopRecord);
                    pttBtn.addEventListener('mouseleave', (e) => { if (e.buttons === 1 && isSpeaking) stopRecord(e); });
                    pttBtn.addEventListener('touchstart', startRecord, { passive: false });
                    pttBtn.addEventListener('touchend', stopRecord);
                    pttBtn.addEventListener('touchcancel', stopRecord);
                }
                if (endTurnBtn) endTurnBtn.addEventListener('click', () => { if (isSpeaking) stopRecording(); endTurn(); });
            } else { enableChat(false); }
        }
        startSpeakCountdown();
    }

    function startSpeakCountdown() {
        stopSpeakCountdown();
        speakInterval = setInterval(() => {
            speakRemaining = Math.max(0, speakRemaining - 1);
            const timerEl = getEl('speakTimer');
            if (timerEl) timerEl.textContent = speakRemaining + '秒';
            if (currentSpeaker) {
                const name = players.find(p => p.number === currentSpeaker)?.name || currentSpeaker + '号';
                safeSetText(statusArea, `🎤 发言: ${name} (${speakRemaining}s)`);
            }
            if (speakRemaining <= 0) { stopSpeakCountdown(); endTurn(); }
        }, 1000);
    }
    function stopSpeakCountdown() { if (speakInterval) { clearInterval(speakInterval); speakInterval = null; } }

    function renderPlayerList() {
        if (!playerListDiv) return;
        const list = Array.isArray(players) ? players : [];
        let h = '';
        list.forEach(p => {
            const avatarUrl = p.avatar || '/avatars/default.png';
            const isMe = p.number === myNumber;
            const showDisconnected = !p.connected && !isMe;
            h += `<div class="player-badge ${p.alive ? '' : 'dead'} ${showDisconnected ? 'disconnected' : ''}">`;
            if (isHost && phase === 'waiting' && p.number !== myNumber) h += `<button class="kick-btn" onclick="kickPlayer(${p.number})">✕</button>`;
            h += `<div style="display:flex;align-items:center;justify-content:center;gap:4px;">
                <img src="${avatarUrl}" class="player-avatar" onerror="this.style.display='none'">
                <span>${p.number}号 ${p.name}${p.isHost ? ' 👑' : ''}</span>
            </div>`;
            h += `<div class="player-volume-bar" data-number="${p.number}" style="height:4px;background:#4caf50;width:0%;margin:2px 0;transition: width 0.1s;opacity:0;"></div>`;
            h += `<div style="font-size:10px;color:#a69b8a;">${p.alive ? '⚡' : '☠'} ${showDisconnected ? '离线' : ''}</div>`;
            h += `</div>`;
        });
        playerListDiv.innerHTML = h;
    }

    // ========== 夜晚行动 / 投票 UI ==========
    function showNightActions() {
        if (overlayDiv) overlayDiv.remove();
        overlayDiv = document.createElement('div');
        overlayDiv.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.5);z-index:10000;display:flex;align-items:center;justify-content:center;';
        const cont = document.createElement('div');
        cont.style.cssText = 'max-width:500px;width:90%;background:rgba(20,25,23,0.95);backdrop-filter:blur(12px);border:1px solid rgba(180,150,120,0.3);border-radius:8px 32px 8px 32px;padding:24px;color:#d4c9b8;max-height:90vh;overflow-y:auto;';
        let html = `<h2 class="text-3xl font-serif text-center mb-6">⚡ 你的回合</h2>
        <div class="grid grid-cols-2 gap-6 mb-8">
            <div id="actKill" class="memory-card flex flex-col items-center justify-center py-6 cursor-pointer"><span class="text-5xl mb-2">🗡️</span>暗杀</div>
            <div id="actCheck" class="memory-card flex flex-col items-center justify-center py-6 cursor-pointer"><span class="text-5xl mb-2">🔍</span>查验</div>
        </div>
        <div id="targetArea" style="display:none;"><p class="mb-3 text-lg">👉 选择目标</p><div id="targetList" class="grid grid-cols-2 gap-3 mb-6"></div></div>
        <p class="mb-3 text-lg">🃏 翻牌（必选）</p><div id="flipList" class="flex flex-wrap gap-4 justify-center mb-8"></div>
        <button id="submitBtn" class="memory-btn py-4 text-xl" disabled>提交</button>`;
        cont.innerHTML = html;
        overlayDiv.appendChild(cont);
        document.body.appendChild(overlayDiv);

        const killBtn = cont.querySelector('#actKill');
        const checkBtn = cont.querySelector('#actCheck');
        const targetArea = cont.querySelector('#targetArea');
        const targetList = cont.querySelector('#targetList');
        const flipList = cont.querySelector('#flipList');
        const submitBtn = cont.querySelector('#submitBtn');

        let selAct = null, selTarget = null, selFlip = undefined;
        function upd() { if (submitBtn) submitBtn.disabled = !selAct || selTarget === null || selFlip === undefined; }

        const alive = players.filter(p => p.alive && p.number !== myNumber);
        if (targetList) { alive.forEach(p => { const b = document.createElement('div'); b.className = 'player-badge cursor-pointer'; b.textContent = `${p.number}号 ${p.name}`; b.onclick = () => { targetList.querySelectorAll('.player-badge').forEach(x => x.style.background = ''); b.style.background = '#5f7e6b'; selTarget = p.number; upd(); }; targetList.appendChild(b); }); }

        if (flipList) {
            flipCards.forEach(c => {
                if (!c || !c.role) return;
                const roleName = c.name ? c.name.replace('牌', '') : '';
                const imgUrl = roleImages[roleName];
                const card = document.createElement('div');
                card.className = 'flip-card';
                card.style.cssText = 'background:rgba(30,28,26,0.8);border:1px dashed rgba(150,120,90,0.3);border-radius:8px;padding:8px;text-align:center;cursor:pointer;width:70px;height:100px;display:flex;flex-direction:column;align-items:center;justify-content:center;';
                if (imgUrl) { card.innerHTML = `<img src="${imgUrl}" style="width:100%;height:70%;object-fit:contain;border-radius:4px;">`; const nameSpan = document.createElement('div'); nameSpan.textContent = c.name; nameSpan.style.fontSize = '10px'; card.appendChild(nameSpan); }
                else { const iconMap = { '凶手牌':'🗡️', '虚构者牌':'🎭', '侦探牌':'🔍', '错构者牌':'🧩', '精神病牌':'🎪', '人格分裂牌':'👥' }; card.innerHTML = `<div class="text-2xl mb-1">${iconMap[c.role] || '🃏'}</div><div style="font-size:10px;">${c.name}</div>`; }
                card.onclick = () => { flipList.querySelectorAll('.flip-card').forEach(x => { x.classList.remove('selected'); x.style.border = '1px dashed rgba(150,120,90,0.3)'; }); card.classList.add('selected'); card.style.border = '2px solid #b89a7a'; selFlip = c.role; upd(); };
                flipList.appendChild(card);
            });
            const none = document.createElement('div'); none.className = 'flip-card'; none.style.cssText = 'background:rgba(30,28,26,0.8);border:1px dashed rgba(150,120,90,0.3);border-radius:8px;padding:8px;text-align:center;cursor:pointer;width:70px;height:100px;display:flex;flex-direction:column;align-items:center;justify-content:center;';
            none.innerHTML = '<div class="text-2xl mb-1">🚫</div><div style="font-size:10px;">不翻牌</div>';
            none.onclick = () => { flipList.querySelectorAll('.flip-card').forEach(x => { x.classList.remove('selected'); x.style.border = '1px dashed rgba(150,120,90,0.3)'; }); none.classList.add('selected'); none.style.border = '2px solid #b89a7a'; selFlip = null; upd(); };
            flipList.appendChild(none);
        }

        killBtn?.addEventListener('click', () => { selAct = 'kill'; targetArea.style.display = 'block'; killBtn.classList.add('selected'); checkBtn.classList.remove('selected'); upd(); });
        checkBtn?.addEventListener('click', () => { selAct = 'check'; targetArea.style.display = 'block'; checkBtn.classList.add('selected'); killBtn.classList.remove('selected'); upd(); });
        submitBtn?.addEventListener('click', () => { if (selAct && selTarget !== null && selFlip !== undefined) { if (ws) ws.send(JSON.stringify({ type: 'night_action', action: selAct, target: selTarget, flipCard: selFlip })); overlayDiv.remove(); overlayDiv = null; if (actionCard) actionCard.innerHTML = '<p class="text-center py-8 text-xl">✅ 已提交</p>'; } });
    }

    function showVoteOptions() {
        if (!actionCard || hasVoted) return;
        const alive = players.filter(p => p.alive);
        let h = `<h3 class="text-lg font-serif mb-4">🗳️ 投票处决</h3><div class="grid grid-cols-2 gap-3">`;
        alive.forEach(p => h += `<div class="player-badge cursor-pointer" data-vote="${p.number}">${p.number}号 ${p.name}</div>`);
        h += `<div class="player-badge cursor-pointer" data-vote="-1" style="background:#3a2a2a;">🚫 弃权</div></div>`;
        actionCard.innerHTML = h;
        document.querySelectorAll('[data-vote]').forEach(b => b.addEventListener('click', () => {
            if (ws && !hasVoted) { ws.send(JSON.stringify({ type: 'vote', target: parseInt(b.dataset.vote) })); actionCard.innerHTML = '<p class="text-center py-8">已投票</p>'; hasVoted = true; }
        }));
    }

    // ========== UI 函数 ==========
    window.showModal = id => { try { const el = getEl(id); if(el) el.style.display = 'flex'; } catch(e){} };
    window.closeModal = id => { try { const el = getEl(id); if(el) el.style.display = 'none'; } catch(e){} };

    window.showRecords = () => {
        const c = getEl('recordContent');
        if(c) c.innerHTML = allMessages.length ? allMessages.map(m => '· ' + m).join('<br>') : '<p>暂无记录</p>';
        window.showModal('recordModal');
    };

    window.showRules = async () => {
        const c = getEl('ruleContent');
        if(c) c.innerHTML = '加载中...';
        window.showModal('ruleModal');
        try {
            const r = await fetch('/roles.json');
            const d = await r.json();
            let h = `<p><strong>🌙 夜晚</strong> ${d.flow.night}</p><p><strong>☀️ 白天</strong> ${d.flow.day}</p><p><strong>🏆 胜负</strong> ${d.flow.win}</p><h4>角色能力</h4>`;
            for(let k in d.roles) { const v = d.roles[k]; h += `<p><strong>${k}</strong> ${v.camp} | 暗杀:${v.kill} 查验:${v.check} 翻牌:${v.flip}</p>`; }
            if(c) c.innerHTML = h;
        } catch(e) { if(c) c.innerHTML = '规则加载失败'; }
    };

    window.showRoomList = async () => {
        const l = getEl('roomListContent');
        if(l) l.innerHTML = '加载中...';
        window.showModal('roomListModal');
        try {
            const r = await fetch('/rooms');
            const d = await r.json();
            if(d.length) {
                let h = '';
                d.forEach(r => { h += `<div class="flex justify-between p-2 border-b border-[#7a6a58]"><span>${r.id} (${r.players}/${r.max}) 房主:${r.hostName||'未知'} ${r.preset}</span><button class="memory-btn text-xs py-1 px-3" onclick="joinRoomById('${r.id}')">加入</button></div>`; });
                if(l) l.innerHTML = h;
            } else if(l) l.innerHTML = '暂无开放档案';
        } catch(e) { if(l) l.innerHTML = '加载失败'; }
    };

    window.joinRoomById = rid => {
        const inp = getEl('roomIdInput');
        if(inp) inp.value = rid;
        window.closeModal('roomListModal');
        if (joinPanel) joinPanel.style.display = 'block';
    };

    async function loadRoleImages() {
        try {
            const r = await fetch('/roles.json');
            const d = await r.json();
            for(let [k, v] of Object.entries(d.roles)) { if(v.image) roleImages[k] = v.image; }
        } catch(e) {}
    }
    loadRoleImages();

    async function loadPresets() {
        if (!presetSelect) return;
        try {
            const r = await fetch('/admin/presets');
            const d = await r.json();
            if (d && d.presets) {
                presetSelect.innerHTML = '';
                Object.keys(d.presets).forEach(n => {
                    const total = Object.values(d.presets[n]).reduce((a,b) => a + b, 0);
                    const opt = document.createElement('option'); opt.value = n; opt.textContent = `${n} (${total}人)`;
                    if(n === d.active) opt.selected = true; presetSelect.appendChild(opt);
                });
            }
        } catch(e) { if(presetSelect) presetSelect.innerHTML = '<option value="8人进阶">8人进阶 (8人)</option>'; }
    }
    loadPresets();

    // ========== 全局按钮函数 ==========
    window.showCreate = () => { safeDisplay(createPanel, 'block'); safeDisplay(joinPanel, 'none'); };
    window.showJoin = () => { safeDisplay(joinPanel, 'block'); safeDisplay(createPanel, 'none'); };

    window.createRoom = function() {
        if (!currentUser || !currentUser.nickname) return alert('请先登录');
        connectWebSocket();
        const sendCreate = () => { if (!ws || ws.readyState !== 1) return; ws.send(JSON.stringify({ type: 'create', name: currentUser.nickname, preset: presetSelect?.value || '8人进阶', isPublic: publicRoomCheck?.checked ?? true })); };
        if (ws && ws.readyState === 1) sendCreate(); else if (ws) ws.onopen = sendCreate;
    };

    window.joinRoom = function() {
        const rid = (roomIdInput?.value || '').trim().toUpperCase();
        if (!rid) return alert('输入档案编号');
        if (!currentUser || !currentUser.nickname) return alert('请先登录');
        connectWebSocket();
        const sendJoin = () => { if (!ws || ws.readyState !== 1) return; ws.send(JSON.stringify({ type: 'join', name: currentUser.nickname, roomId: rid })); };
        if (ws && ws.readyState === 1) sendJoin(); else if (ws) ws.onopen = sendJoin;
    };

    window.kickPlayer = t => { if (isHost && ws) ws.send(JSON.stringify({ type: 'kick', target: t })); };
    window.startGame = () => { if (isHost && ws) ws.send(JSON.stringify({ type: 'start_game' })); };
    window.sendChat = () => { const m = chatInput?.value.trim(); if (!m || !ws) return; if (phase === 'waiting' || phase === 'gameover' || (phase === 'day' && canSpeak) || isSpectator) { ws.send(JSON.stringify({ type: 'chat', message: m })); chatInput.value = ''; } else alert('现在不能发言'); };

    window.leaveRoom = () => {
    destroyRecorder(); stopSpeakCountdown();
    // ★ 清理所有语音会话 + WebRTC P2P 连接
    audioSessions.forEach((s) => { cleanupAudioSession(s); });
    audioSessions.clear();
    teardownPeers();
    if (gameCornerButtons) gameCornerButtons.style.display = 'none';
    if (ws) { ws.onclose = () => { location.reload(); }; ws.close(); }
    else location.reload();
};

    // ★ 退出登录：断开连接、清理语音/本地会话、清除登录态并跳回登录页
    window.logout = () => {
        try { if (ws) { ws.onclose = null; ws.close(); ws = null; } } catch(_) {}
        try { destroyRecorder(); } catch(_) {}
        try { teardownPeers(); } catch(_) {}
        try { audioSessions.forEach((s) => cleanupAudioSession(s)); audioSessions.clear(); } catch(_) {}
        try { localStorage.removeItem('amnesia_user'); } catch(_) {}
        location.href = '/login.html';
    };

    window.addEventListener('beforeunload', () => destroyRecorder());
    console.log('✅ 完整功能版已加载');
})();