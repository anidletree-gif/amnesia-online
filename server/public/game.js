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
// ★ 默认头像：干净的深色人物剪影（SVG data URI，不依赖任何图片文件）
const DEFAULT_AVATAR = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Ccircle cx='32' cy='24' r='15' fill='%23b8a888'/%3E%3Cpath d='M6 62c0-15 11-22 26-22s26 7 26 22v2H6z' fill='%23b8a888'/%3E%3C/svg%3E";

if (avatarImg) {
    // ★ 主页头像：优先显示服务器实时头像，无头像时显示干净剪影（而不是丑圆圈）
    avatarImg.src = currentUser.avatar || DEFAULT_AVATAR;
    avatarImg.onerror = function() { this.src = DEFAULT_AVATAR; };
    // 异步从服务器同步最新头像（用户上传后无需重登即可生效）
    (async () => {
        try {
            const r = await fetch('/api/me?email=' + encodeURIComponent(currentUser.email));
            if (r.ok) {
                const fresh = await r.json();
                if (fresh.avatar) {
                    currentUser.avatar = fresh.avatar;
                    localStorage.setItem('amnesia_user', JSON.stringify(currentUser));
                    avatarImg.src = fresh.avatar;
                }
            }
        } catch(e) {}
    })();
}

    // 创建右上角阶段指示器（升级版：光点 + 进度条）
    const phaseIndicator = document.createElement('div');
    phaseIndicator.id = 'phaseIndicator';
    phaseIndicator.style.cssText = 'position:fixed;top:10px;right:10px;background:rgba(0,0,0,0.7);color:#d4c9b8;padding:6px 14px;border-radius:12px;font-size:14px;z-index:9999;display:none;';
    phaseIndicator.innerHTML = '<span class="phase-dot"></span><span id="phaseText">等待开始</span><span class="phase-bar"><i id="phaseBarFill"></i></span>';
    document.body.appendChild(phaseIndicator);

    // ===== 氛围层 =====
    const phaseOverlay = document.getElementById('phaseOverlay');
    const phaseBanner = document.getElementById('phaseBanner');
    let phaseBarTimer = null;
    function setPhaseAtmosphere(newPhase, totalSeconds, label) {
        if (phaseOverlay) phaseOverlay.className = '';
        if (phaseIndicator) {
            phaseIndicator.className = '';
            const t = document.getElementById('phaseText');
            if (t) t.textContent = label || '';
        }
        const valid = ['night', 'day', 'vote'];
        if (valid.includes(newPhase)) {
            if (phaseOverlay) phaseOverlay.classList.add(newPhase);
            if (phaseIndicator) phaseIndicator.classList.add(newPhase);
            // 阶段进度条
            if (phaseBarTimer) { clearInterval(phaseBarTimer); phaseBarTimer = null; }
            const fill = document.getElementById('phaseBarFill');
            if (fill && totalSeconds > 0) {
                let left = totalSeconds;
                fill.style.width = '100%';
                phaseBarTimer = setInterval(() => {
                    left -= 1;
                    if (fill) fill.style.width = Math.max(0, Math.min(100, (left / totalSeconds) * 100)) + '%';
                    if (left <= 0 && phaseBarTimer) { clearInterval(phaseBarTimer); phaseBarTimer = null; }
                }, 1000);
            }
        } else if (phaseBarTimer) { clearInterval(phaseBarTimer); phaseBarTimer = null; }
    }
    // 阶段切换：黑屏过场 + 大字横幅（单行不换行）
    function showPhaseBanner(text, sub, color) {
        // ★ 黑屏过场：先闪黑，再淡入显示横幅，再恢复
        let flash = document.getElementById('fadeFlash');
        if (!flash) { flash = document.createElement('div'); flash.id = 'fadeFlash'; flash.style.cssText = 'position:fixed;inset:0;z-index:90;background:#000;opacity:0;pointer-events:none;transition:opacity .8s ease'; document.body.appendChild(flash); }
        flash.classList.add('on');
        setTimeout(() => {
            flash.classList.remove('on');
            if (!phaseBanner) return;
            phaseBanner.innerHTML = '';
            const main = document.createElement('div');
            main.textContent = text;
            main.style.cssText = 'white-space:nowrap;';
            if (color) main.style.color = color;
            phaseBanner.appendChild(main);
            if (sub) {
                const s = document.createElement('div');
                s.textContent = sub;
                s.style.cssText = 'white-space:nowrap;';
                s.className = 'sub';
                phaseBanner.appendChild(s);
            }
            phaseBanner.classList.add('show');
            clearTimeout(phaseBanner._t);
            phaseBanner._t = setTimeout(() => phaseBanner.classList.remove('show'), 2200);
        }, 400);
    }
    function setPhaseIndicator(label, phase, totalSeconds) {
        setPhaseAtmosphere(phase, totalSeconds, label);
        const t = document.getElementById('phaseText');
        if (t) t.textContent = label;
        // ★ 房间码旁阶段小徽章：🌙 第x夜 / ☀️ 第x天 / 🗳️ 投票
        const badge = document.getElementById('phaseBadge');
        if (badge) {
            const m = label ? label.match(/第\s*(\d+)\s*[夜天]/) : null;
            const dayNum = m ? m[1] : '';
            badge.className = 'phase-badge';
            if (phase === 'night') { badge.classList.add('night'); badge.textContent = `🌙 第${dayNum}夜`; }
            else if (phase === 'day') { badge.classList.add('day'); badge.textContent = `☀️ 第${dayNum}天`; }
            else if (phase === 'vote') { badge.classList.add('vote'); badge.textContent = '🗳️ 投票'; }
            else { badge.style.display = 'none'; }
        }
    }

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
    let isMyActionTurn = false; // ★ 我的夜晚行动回合标记（用于内联行动按钮）

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
        const el = document.querySelector(`.pw-volume i[data-vol="${playerNumber}"]`);
        if (el) { el.style.width = (volume * 100) + '%'; el.style.opacity = volume > 0.05 ? 1 : 0; }
        // 兼容旧版 class
        const el2 = document.querySelector(`.player-volume-bar[data-number="${playerNumber}"]`);
        if (el2) { el2.style.width = (volume * 100) + '%'; el2.style.opacity = volume > 0.05 ? 1 : 0; }
    }
    function setPlayerSpeaking(playerNumber, speaking) {
        if (playerNumber == null) return;
        const el = document.querySelector(`.pw-card[data-num="${playerNumber}"]`);
        if (el) {
            if (speaking) el.classList.add('speaking');
            else el.classList.remove('speaking');
        }
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
                    // ★ 重置行动回合标记：只有夜晚+本人回合+存活 才允许点卡片行动
                    isMyActionTurn = (msg.phase === 'night' && !!msg.isMyTurn && msg.alive !== false);
                    document.querySelectorAll('.pw-action-area').forEach(a => a.remove());
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
                            setPhaseIndicator('等待开始', '', 0);
                            break;
                        case 'night':
                            safeSetText(statusArea, `🌙 第${currentDay}夜`);
                            if (msg.isMyTurn) showNightActions();
                            else { safeDisplay(actionCard, 'block'); if(actionCard) actionCard.innerHTML = '<p class="text-center py-8">夜幕降临…等待他人行动</p>'; }
                            enableChat(false);
                            safeDisplay(startBtn, 'none');
                            setPhaseIndicator(`🌙 第${currentDay}夜`, 'night', msg.actionRemaining || 30);
                            showPhaseBanner('🌙 夜幕降临', `第 ${currentDay} 夜`, '#8fb0ff');
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
                            const daySpeakRemaining = msg.currentSpeaker ? (msg.speakRemaining || 120) : 120;
                            setPhaseIndicator(`☀️ 第${currentDay}天`, 'day', daySpeakRemaining);
                            showPhaseBanner('☀️ 黎明破晓', `第 ${currentDay} 天`, '#e8c46a');
                            break;
                        case 'vote':
                            safeSetText(statusArea, '🗳️ 投票阶段');
                            showVoteOptions();
                            enableChat(false);
                            safeDisplay(startBtn, 'none');
                            setPhaseIndicator('🗳️ 投票阶段', 'vote', msg.voteRemaining || 30);
                            showPhaseBanner('🗳️ 投票时刻', '选择你的立场', '#e86a5a');
                            break;
                        case 'gameover':
                            safeSetText(statusArea, '游戏结束');
                            safeDisplay(actionCard, 'none');
                            enableChat(true);
                            safeDisplay(startBtn, 'none');
                            setPhaseIndicator('游戏结束', '', 0);
                            break;
                    }
                    return;
                }
                if (msg.type === 'spectator_joined') {
                    isSpectator = true; roomId = msg.roomId;
                    safeSetText(roomCodeSpan, roomId); safeSetText(presetInfo, '档案: ' + msg.preset);
                    safeDisplay(loginPanel, 'none'); safeDisplay(gamePanel, 'block'); safeDisplay(gameCornerButtons, 'flex');
                    enableChat(true); safeDisplay(startBtn, 'none'); safeDisplay(actionCard, 'none');
                    setPhaseIndicator('观战中', '', 0);
                    return;
                }
                if (msg.type === 'room_created') {
                    roomId = msg.roomId; myNumber = msg.yourNumber; isHost = !!msg.isHost;
                    phase = 'waiting'; flipCards = msg.flipCards || [];
                    safeSetText(roomCodeSpan, roomId); safeSetText(presetInfo, '档案: ' + msg.preset);
                    safeDisplay(loginPanel, 'none'); safeDisplay(gamePanel, 'block'); safeDisplay(gameCornerButtons, 'flex');
                    enableChat(true); updateStartButton();
                    setPhaseIndicator('等待开始', '', 0);
                } else if (msg.type === 'joined') {
      roomId = msg.roomId; myNumber = msg.yourNumber; isHost = !!msg.isHost;
      flipCards = msg.flipCards || [];
      safeSetText(roomCodeSpan, roomId); safeSetText(presetInfo, '档案: ' + msg.preset);
      safeDisplay(loginPanel, 'none'); safeDisplay(gamePanel, 'block'); safeDisplay(gameCornerButtons, 'flex');
      enableChat(true); updateStartButton();
      setPhaseIndicator('等待开始', '', 0);
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
                    // ★ 非夜晚阶段强制关闭行动模式
                    if (msg.phase !== 'night') {
                        isMyActionTurn = false;
                        document.querySelectorAll('.pw-action-area').forEach(a => a.remove());
                        const flipOv = document.getElementById('flipTableOverlay');
                        if (flipOv) flipOv.remove();
                        // ★ 重建玩家列表 DOM：彻底清掉夜晚绑定的卡片点击监听（白天不可再行动）
                        renderPlayerList();
                    }
                    if (msg.phase === 'waiting') {
                        safeSetText(statusArea, '等待开始'); safeDisplay(actionCard, 'none'); enableChat(true); updateStartButton();
                        setPhaseIndicator('等待开始', '', 0);
                    } else if (msg.phase === 'night') {
                        safeSetText(statusArea, `🌙 第${msg.day}夜`);
                        safeDisplay(actionCard, 'block'); actionCard.innerHTML = '<p class="text-center py-8">夜幕降临…</p>';
                        enableChat(false); destroyRecorder();
                        setPhaseIndicator(`🌙 第${msg.day}夜`, 'night', msg.actionRemaining || 30);
                        showPhaseBanner('🌙 夜幕降临', `第 ${msg.day} 夜`, '#8fb0ff');
                    } else if (msg.phase === 'day') {
                        safeSetText(statusArea, `☀️ 第${msg.day}天`);
                        enableChat(false); destroyRecorder();
                        if(msg.killedNames) addChatLog('🌅 死者: '+msg.killedNames);
                        setPhaseIndicator(`☀️ 第${msg.day}天`, 'day', msg.speakRemaining || 120);
                        showPhaseBanner('☀️ 黎明破晓', `第 ${msg.day} 天`, '#e8c46a');
                        // ★ 白天死者公示：弹公示容器停留展示
                        if (msg.killedNames) {
                            const deadList = msg.killedNames.split('、').map(n => ({ text: '☠ ' + n, dead: true }));
                            showAnnounce({
                                icon: '🌅',
                                title: '昨夜死者',
                                titleCls: 'dead',
                                sub: `第 ${msg.day} 天 · 天亮了`,
                                list: deadList,
                                autoCloseMs: 7000
                            });
                        }
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
                        setPhaseIndicator('🗳️ 投票阶段', 'vote', msg.voteRemaining || 30);
                        showPhaseBanner('🗳️ 投票时刻', '选择你的立场', '#e86a5a');
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
                    setPlayerSpeaking(null, false); document.querySelectorAll('.pw-card').forEach(c => c.classList.remove('speaking'));
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
                    // ★ 3D 结算：被处决者号码牌被清下桌 + 结果横幅
                    showVoteResult(msg.name, msg.tally, msg.number);
                } else if (msg.type === 'no_execution') {
                    let voteInfo = '投票结果：';
                    if (msg.tally) {
                        for (let [num, cnt] of Object.entries(msg.tally)) {
                            voteInfo += `${num}号:${cnt}票 `;
                        }
                    }
                    addChatLog(voteInfo);
                    addChatLog('⚖️ 今日无人被处决');
                    // ★ 平票结果横幅
                    showVoteResult(null, msg.tally, null);
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
                    // ★ 游戏结束公示：全员身份揭晓
                    if (msg.roles && msg.roles.length) {
                        const roleList = msg.roles.slice().sort((a,b) => a.number - b.number).map(r => ({
                            text: `${r.number}号 ${r.name} · ${r.role}${r.alive ? '' : ' ☠'}`,
                            dead: !r.alive
                        }));
                        showAnnounce({
                            icon: '🏆',
                            title: (msg.winner || '') + ' 胜利',
                            titleCls: 'win',
                            sub: '游戏结束 · 身份揭晓',
                            list: roleList,
                            autoCloseMs: 12000
                        });
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
        // ★ 狼人杀式：高亮当前发言人
        document.querySelectorAll('.pw-card').forEach(c => c.classList.remove('speaking'));
        setPlayerSpeaking(speakerNumber, true);
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
        // ★ 固定座位：按编号 1-3 左列 / 4-6 右列，死亡不移位（只变灰）
        const left = [], right = [];
        list.slice().sort((a,b) => a.number - b.number).forEach(p => {
            (p.number <= Math.ceil(list.length / 2) ? left : right).push(p);
        });
        // 若单列不满则从另一列借位，保持两列均衡
        if (left.length > right.length + 1) right.unshift(left.pop());
        if (right.length > left.length + 1) left.push(right.shift());
        function cardHtml(p) {
            // ★ 头像：优先用户上传的真头像，无头像时显示干净人物剪影（绝不再用丑圆圈）
            const avatarUrl = p.avatar || DEFAULT_AVATAR;
            const isMe = p.number === myNumber;
            const showDisconnected = !p.connected && !isMe;
            const kickBtn = (isHost && phase === 'waiting' && p.number !== myNumber) ? `<button class="pw-kick" onclick="kickPlayer(${p.number})">✕</button>` : '';
            const crown = p.isHost ? '<span class="crown">👑</span>' : '';
            const statusCls = p.alive ? (showDisconnected ? 'off' : 'alive') : 'dead';
            const statusTxt = p.alive ? (showDisconnected ? '离线' : '在场') : '已死亡';
            const deadX = p.alive ? '' : '<span class="pw-dead-x">☠</span>';
            return `<div class="pw-card ${p.alive ? '' : 'dead'} ${showDisconnected ? 'disconnected' : ''}" data-num="${p.number}">
                ${kickBtn}${deadX}
                <img src="${avatarUrl}" class="pw-avatar" onerror="this.src='${DEFAULT_AVATAR}'">
                <div class="pw-info">
                    <div class="pw-name"><span class="num">${p.number}号</span><span class="nm">${p.name}</span>${crown}${isMe ? '<span class="me-tag">我</span>' : ''}</div>
                    <div class="pw-status"><span class="dot ${statusCls}"></span>${statusTxt}</div>
                </div>
                <div class="pw-volume"><i data-vol="${p.number}"></i></div>
            </div>`;
        }
        playerListDiv.innerHTML = `<div id="playerListCol">${left.map(cardHtml).join('')}</div><div id="playerListCol">${right.map(cardHtml).join('')}</div>`;
        // ★ 我的回合时，给存活目标卡片挂上"点击展开行动"事件（bindNightTargetClicks 内部有守卫）
        bindNightTargetClicks();
        // ★ 投票阶段：点卡片投票
        if (phase === 'vote') bindVoteClicks();
    }

    // ========== 夜晚行动 / 投票 UI ==========
    function showNightActions() {
        // ★ 内联交互：不弹大容器，直接让玩家列表卡片可点击展开行动
        if (overlayDiv) { overlayDiv.remove(); overlayDiv = null; }
        isMyActionTurn = true;
        if (actionCard) actionCard.innerHTML = '<p class="text-center py-6 text-[#b89a7a]">🌙 点击下方玩家卡片选择行动目标</p>';
        renderPlayerList();
    }

    // ★ 点击玩家卡片 -> 卡片下方内联展开 [暗杀/查验] -> 选动作 -> 展开翻牌 -> 提交
    function bindNightTargetClicks() {
        if (!playerListDiv) return;
        // ★ 守卫：只有夜晚 + 我的回合 + 我还活着 才允许点卡片行动；否则清除所有展开区并返回
        if (phase !== 'night' || !isMyActionTurn || isDead || isSpectator) {
            isMyActionTurn = false;
            document.querySelectorAll('.pw-action-area').forEach(a => a.remove());
            return;
        }
        const alive = players.filter(p => p.alive && p.number !== myNumber);
        const myCard = document.querySelector(`.pw-card[data-num="${myNumber}"]`);
        if (myCard) {
            myCard.style.borderColor = 'rgba(95,174,120,.7)';
            myCard.style.boxShadow = '0 0 12px rgba(95,174,120,.3)';
        }
        document.querySelectorAll('.pw-card').forEach(card => {
            const num = parseInt(card.dataset.num);
            if (!num || num === myNumber) return;
            const isAliveTarget = alive.some(p => p.number === num);
            // 清除旧展开区
            const oldArea = card.parentElement.querySelector('.pw-action-area');
            if (oldArea) oldArea.remove();
            if (!isAliveTarget) { card.style.cursor = 'default'; return; }
            card.style.cursor = 'pointer';
            // 卡片上已有展开区时点击收起
            card.onclick = null;
            card.addEventListener('click', function handler(ev) {
                ev.stopPropagation();
                // ★★ 实时守卫：只有 夜晚+我的回合+我活着+未观战 才允许行动；否则立刻中止
                if (phase !== 'night' || !isMyActionTurn || isDead || isSpectator) {
                    document.querySelectorAll('.pw-action-area').forEach(a => a.remove());
                    // 恢复 actionCard：如果被行动残留覆盖且当前是白天发言，由 speak_start 重新渲染
                    return;
                }
                // 已选中样式
                document.querySelectorAll('.pw-card').forEach(c => { if (c !== card) { c.style.borderColor = ''; c.style.boxShadow = ''; } });
                card.style.borderColor = '#e8c46a';
                card.style.boxShadow = '0 0 14px rgba(232,196,106,.5)';
                // 移除其他卡片展开区
                document.querySelectorAll('.pw-action-area').forEach(a => a.remove());
                const col = card.parentElement; // playerListCol
                // 已存在则收起
                let area = col.querySelector('.pw-action-area');
                if (area) { area.remove(); return; }
                area = document.createElement('div');
                area.className = 'pw-action-area';
                area.innerHTML = `
                    <div style="display:flex;gap:6px;margin-top:8px;flex-wrap:wrap;">
                        <button class="pw-act-btn" data-act="kill">🗡️ 暗杀</button>
                        <button class="pw-act-btn" data-act="check">🔍 查验</button>
                    </div>
                    <div class="pw-flip-row" style="display:none;margin-top:8px;flex-wrap:wrap;gap:4px;"></div>
                    <div class="pw-submit-row" style="display:none;margin-top:8px;">
                        <button class="pw-submit-btn" style="width:100%;padding:6px;background:linear-gradient(145deg,#2a3a2e,#1a2a1e);border:1px solid #5fae78;color:#cfe8d4;border-radius:6px;font-size:12px;cursor:pointer;">✅ 确认行动</button>
                    </div>`;
                col.insertBefore(area, card.nextSibling);
                // 动作按钮
                let selAct = null, selFlip = null;
                const actBtns = area.querySelectorAll('.pw-act-btn');
                const flipRow = area.querySelector('.pw-flip-row');
                const submitRow = area.querySelector('.pw-submit-row');
                actBtns.forEach(btn => {
                    btn.addEventListener('click', (e) => {
                        e.stopPropagation();
                        selAct = btn.dataset.act;
                        actBtns.forEach(b => { b.style.borderColor = ''; b.style.background = ''; });
                        btn.style.borderColor = '#e8c46a';
                        btn.style.background = 'rgba(232,196,106,.15)';
                        // ★ 3D 行动桌：弹出桌面 + 卡牌飞入，选择翻牌/不翻
                        openFlipTable(num, selAct, area);
                    });
                });
                // 提交
                const submitBtn = area.querySelector('.pw-submit-btn');
                submitBtn.addEventListener('click', (ev) => {
                    ev.stopPropagation();
                    if (selAct && selFlip !== undefined) {
                        if (ws) ws.send(JSON.stringify({ type: 'night_action', action: selAct, target: num, flipCard: selFlip }));
                        area.innerHTML = '<p style="text-align:center;padding:6px;color:#8fae98;font-size:12px;">✅ 已行动</p>';
                        isMyActionTurn = false;
                        document.querySelectorAll('.pw-action-area').forEach(a => a.remove());
                        if (actionCard) actionCard.innerHTML = '<p class="text-center py-6 text-xl">✅ 已提交行动</p>';
                    }
                });
            });
        });
    }

    // ========== 头像上传（补全：之前前端缺 uploadAvatar 函数，点选头像根本不上传） ==========
    window.uploadAvatar = function(e) {
        const file = e && e.target && e.target.files && e.target.files[0];
        if (!file) return;
        if (!/^image\/(png|jpeg|jpg|gif|webp)$/.test(file.type)) {
            alert('请选择图片文件（PNG/JPG/GIF/WEBP）');
            return;
        }
        if (file.size > 2 * 1024 * 1024) {
            alert('图片不能超过 2MB');
            return;
        }
        const fd = new FormData();
        fd.append('avatar', file);
        fd.append('email', currentUser.email);
        const btn = e.target;
        fetch('/api/upload-avatar', { method: 'POST', body: fd })
            .then(r => r.json())
            .then(data => {
                if (data && data.avatar) {
                    // 更新 localStorage + 顶部头像立即刷新
                    currentUser.avatar = data.avatar;
                    localStorage.setItem('amnesia_user', JSON.stringify(currentUser));
                    const img = getEl('avatarImg');
                    if (img) img.src = data.avatar;
                    alert('✅ 头像已更新');
                } else {
                    alert('上传失败：' + (data.error || '未知错误'));
                }
            })
            .catch(err => { alert('网络错误：' + err.message); });
        // 清空 input，允许重复选择同一文件
        if (btn) btn.value = '';
    };

    // ★★★ 3D 行动桌：点击暗杀/查验后弹出，卡牌从桌底飞入（背面朝上），点击翻牌显示角色图，选中后确认
    function openFlipTable(targetNumber, actionType, sourceArea) {
        const targetName = players.find(p => p.number === targetNumber)?.name || (targetNumber + '号');
        const actionName = actionType === 'kill' ? '🗡️ 暗杀' : '🔍 查验';
        // 关闭旧弹层
        const oldOv = document.getElementById('flipTableOverlay');
        if (oldOv) oldOv.remove();

        const overlay = document.createElement('div');
        overlay.id = 'flipTableOverlay';
        overlay.className = '';
        let cardsHtml = '';
        const cards = [{ role: null, name: '不翻牌', icon: '🚫' }].concat(
            flipCards.filter(c => c && c.role).map(c => ({ role: c.role, name: c.name || c.role + '牌', icon: '🃏' }))
        );
        const fanBase = cards.length > 1 ? (cards.length - 1) * -4 : 0; // 扇形展开
        cards.forEach((c, i) => {
            const imgUrl = c.role ? roleImages[c.name.replace('牌','')] : null;
            cardsHtml += `
            <div class="ft-card" data-idx="${i}" data-role="${c.role || ''}" style="--fan:${fanBase + i * 8}deg">
                <div class="ft-inner">
                    <div class="ft-face ft-back">
                        <div class="ft-back-pattern">${c.role ? '◈' : '✕'}</div>
                        <div class="ft-sub">点击翻开</div>
                    </div>
                    <div class="ft-face ft-front" style="background:linear-gradient(155deg,#3b3226,#221b12);gap:8px;">
                        ${imgUrl ? `<img src="${imgUrl}" style="width:74px;height:74px;object-fit:contain;border-radius:6px;">` : `<div style="font-size:40px;line-height:1;">${c.icon}</div>`}
                        <div class="ft-name">${c.name}</div>
                        <div class="ft-sub">${c.role ? '翻此牌' : '不冒险'}</div>
                    </div>
                </div>
            </div>`;
        });
        overlay.innerHTML = `
            <button class="ft-cancel">✕</button>
            <div class="ft-desc">${actionName} → 目标 ${targetName} · 选择是否翻开一张牌</div>
            <div class="flip-table">
                <div class="ft-cards">${cardsHtml}</div>
            </div>
            <button class="ft-confirm">✅ 确认行动</button>`;
        document.body.appendChild(overlay);
        // 触发入场动画
        requestAnimationFrame(() => requestAnimationFrame(() => overlay.classList.add('show')));

        let selected = null; // { role: null-不翻 | 角色名 }
        let selectedCard = null;
        const ftCards = overlay.querySelectorAll('.ft-card');
        ftCards.forEach(card => {
            card.addEventListener('click', () => {
                // ★ 点已选中的卡 = 撤回：翻回背面、取消选中
                if (card === selectedCard) {
                    card.classList.remove('flipped', 'up');
                    selectedCard = null;
                    selected = null;
                    const btn = overlay.querySelector('.ft-confirm');
                    if (btn) btn.classList.remove('show');
                    return;
                }
                // ★ 互斥：其他所有卡收起翻转 + 取消选中
                ftCards.forEach(c => c.classList.remove('flipped', 'up'));
                // 翻牌动画 + 选中态
                card.classList.add('flipped', 'up');
                selectedCard = card;
                selected = card.dataset.role === '' ? null : card.dataset.role;
                const btn = overlay.querySelector('.ft-confirm');
                if (btn) btn.classList.add('show');
            });
        });
        overlay.querySelector('.ft-cancel').addEventListener('click', () => {
            overlay.remove();
        });
        overlay.querySelector('.ft-confirm').addEventListener('click', () => {
            // 未选任何牌时默认不翻
            const finalFlip = (selected === undefined) ? null : selected;
            overlay.remove();
            if (sourceArea) sourceArea.innerHTML = '<p style="text-align:center;padding:6px;color:#8fae98;font-size:12px;">✅ 已行动</p>';
            if (ws) ws.send(JSON.stringify({ type: 'night_action', action: actionType, target: targetNumber, flipCard: finalFlip }));
            isMyActionTurn = false;
            document.querySelectorAll('.pw-action-area').forEach(a => a.remove());
            if (actionCard) actionCard.innerHTML = '<p class="text-center py-6 text-xl">✅ 已提交行动</p>';
        });
    }

    // ===== 投票（狼人杀式：点玩家卡片 → 内联出 投票/弃权 按钮） =====
    function showVoteOptions() {
        if (hasVoted) return;
        // 关闭 3D 投票桌/行动桌残留
        const oldOv = document.getElementById('voteTableOverlay');
        if (oldOv) oldOv.remove();
        const oldFlip = document.getElementById('flipTableOverlay');
        if (oldFlip) oldFlip.remove();

        // ★ 狼人杀式：点玩家卡片投票（跟夜晚行动同款交互）
        if (actionCard) actionCard.innerHTML = '<p class="text-center py-6 text-[#b89a7a]">🗳️ 点击下方存活玩家卡片投票</p>';
        renderPlayerList(); // 重建卡片后绑定点击
    }

    // ★ 投票阶段：点玩家卡片 -> 内联展开 [🗳️投票 / 🚫弃权]
    function bindVoteClicks() {
        if (!playerListDiv) return;
        if (phase !== 'vote' || hasVoted || isDead || isSpectator) return;
        const alive = players.filter(p => p.alive && p.number !== myNumber);
        document.querySelectorAll('.pw-card').forEach(card => {
            const num = parseInt(card.dataset.num);
            if (!num || num === myNumber) return;
            const isAliveTarget = alive.some(p => p.number === num);
            const oldArea = card.parentElement.querySelector('.pw-action-area');
            if (oldArea) oldArea.remove();
            if (!isAliveTarget) { card.style.cursor = 'default'; return; }
            card.style.cursor = 'pointer';
            card.onclick = null;
            card.addEventListener('click', function handler(ev) {
                ev.stopPropagation();
                if (phase !== 'vote' || hasVoted || isDead || isSpectator) {
                    document.querySelectorAll('.pw-action-area').forEach(a => a.remove());
                    return;
                }
                document.querySelectorAll('.pw-card').forEach(c => { if (c !== card) { c.style.borderColor = ''; c.style.boxShadow = ''; } });
                card.style.borderColor = '#e86a5a';
                card.style.boxShadow = '0 0 14px rgba(232,106,90,.5)';
                document.querySelectorAll('.pw-action-area').forEach(a => a.remove());
                const col = card.parentElement;
                let area = col.querySelector('.pw-action-area');
                if (area) { area.remove(); return; }
                area = document.createElement('div');
                area.className = 'pw-action-area';
                area.innerHTML = `
                    <div style="display:flex;gap:6px;margin-top:8px;flex-wrap:wrap;">
                        <button class="pw-act-btn" data-vote-target="${num}" style="border-color:#e86a5a;color:#ffd0c8;">🗳️ 投票</button>
                        <button class="pw-act-btn" data-vote-abstain="1">🚫 弃权</button>
                    </div>`;
                col.insertBefore(area, card.nextSibling);
                area.querySelector('[data-vote-target]').addEventListener('click', (e) => {
                    e.stopPropagation();
                    if (ws && !hasVoted) {
                        hasVoted = true;
                        ws.send(JSON.stringify({ type: 'vote', target: num }));
                        document.querySelectorAll('.pw-action-area').forEach(a => a.remove());
                        if (actionCard) actionCard.innerHTML = '<p class="text-center py-6 text-xl">✅ 已投票，等待其他玩家…</p>';
                    }
                });
                area.querySelector('[data-vote-abstain]').addEventListener('click', (e) => {
                    e.stopPropagation();
                    if (ws && !hasVoted) {
                        hasVoted = true;
                        ws.send(JSON.stringify({ type: 'vote', target: -1 }));
                        document.querySelectorAll('.pw-action-area').forEach(a => a.remove());
                        if (actionCard) actionCard.innerHTML = '<p class="text-center py-6 text-xl">✅ 已弃权</p>';
                    }
                });
            });
        });
    }

    // 更新 3D 投票桌：标记已投票的人（绿色光边）
    function updateVotePlaques(votedNumbers) {
        if (window.Vote3D) Vote3D.markVoted(votedNumbers || []);
    }

    // ===== 公示容器（投票结果/白天死者/游戏结束 统一展示，停留可关闭） =====
    function showAnnounce(opts) {
        // opts: { icon, title, titleCls, sub, body, tally:{num:cnt}, list:[{text, dead}], autoCloseMs }
        // 关闭已有公示层
        const old = document.getElementById('announceOverlay');
        if (old) old.remove();
        const ov = document.createElement('div');
        ov.id = 'announceOverlay';
        let h = `<div class="ann-card">
            ${opts.icon ? `<div class="ann-icon">${opts.icon}</div>` : ''}
            <div class="ann-title ${opts.titleCls || ''}">${opts.title}</div>
            ${opts.sub ? `<div class="ann-sub">${opts.sub}</div>` : ''}
            ${opts.body ? `<div class="ann-body">${opts.body}</div>` : ''}`;
        if (opts.tally && Object.keys(opts.tally).length) {
            h += `<div class="ann-tally">`;
            for (let [num, cnt] of Object.entries(opts.tally)) {
                h += `<span>${num}号 · ${cnt}票</span>`;
            }
            h += `</div>`;
        }
        if (opts.list && opts.list.length) {
            h += `<div class="ann-list">`;
            opts.list.forEach(it => { h += `<span class="${it.dead ? 'dead' : ''}">${it.text}</span>`; });
            h += `</div>`;
        }
        h += `<button class="ann-close">确 认</button></div>`;
        ov.innerHTML = h;
        document.body.appendChild(ov);
        requestAnimationFrame(() => requestAnimationFrame(() => ov.classList.add('show')));
        ov.querySelector('.ann-close').addEventListener('click', () => {
            ov.classList.remove('show');
            setTimeout(() => ov.remove(), 350);
        });
        // 自动关闭（可配置）
        if (opts.autoCloseMs) {
            setTimeout(() => {
                if (ov.isConnected) { ov.classList.remove('show'); setTimeout(() => ov.remove(), 350); }
            }, opts.autoCloseMs);
        }
        return ov;
    }

    // 投票结果公示（取代 3D 清下桌动画）
    function showVoteResult(executedName, tally, executedNumber) {
        const tallyObj = {};
        if (tally) { for (let [num, cnt] of Object.entries(tally)) tallyObj[num] = cnt; }
        if (executedName) {
            showAnnounce({
                icon: '⚖️',
                title: `${executedName} 被处决`,
                titleCls: 'dead',
                sub: `第 ${currentDay || ''} 天 · 投票处决`,
                tally: tallyObj,
                autoCloseMs: 6000
            });
        } else {
            showAnnounce({
                icon: '🤝',
                title: '平票 · 无人被处决',
                titleCls: '',
                sub: '票数相同，今日无人出局',
                tally: tallyObj,
                autoCloseMs: 6000
            });
        }
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