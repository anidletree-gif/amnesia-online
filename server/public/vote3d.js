/* ============================================================
 * 失忆症 Online · 3D 验票桌 v2 —— three.js 竖屏精修版
 * ------------------------------------------------------------
 * 设计目标：
 *   1) 竖版（纵向）椭圆长桌，手机竖屏优先，任何宽高比自动取景
 *   2) 精细质感：程序化木纹、软阴影、ACES 调色、烛光呼吸
 *   3) 交互：点选立牌 → 金环 + 上浮 + 落锤脉冲；已投票者脚边绿晶脉动
 *   4) 结算：被处决者立牌按倒在桌面、尘埃四溅、镜头微震、横幅揭示
 *   5) 资源完备回收（geometry/material/texture/timer），可反复开关
 * 对外 API（与 game.js 契约保持不变）：
 *   Vote3D.open(players, onConfirm)
 *   Vote3D.markVoted(numbers)
 *   Vote3D.reveal(executedNumber, name, tally)
 * ============================================================ */
(function () {
    "use strict";
    if (!window.THREE) { console.warn('[Vote3D] three.js 未加载，使用降级 UI'); return; }

    /* ===== 尺寸常量（纵向长 → 竖版桌） ===== */
    var DESK_A = 3.05, DESK_B = 3.52;    // 桌面椭圆：横向半径 / 纵向半径
    var SEAT_A = 2.40, SEAT_B = 3.10;    // 席位椭圆
    var PLAQUE_W = 1.05, PLAQUE_H = 1.42;
    var CAM_RATIO = 0.38;                // 相机水平偏移 / 高度
    var LOOK_AT = new THREE.Vector3(0, 0, 0.35);

    var COL = {
        gold: 0xd9c390,
        goldBright: 0xffd97a,
        green: 0x39b268,
        candle: 0xffb46a
    };

    /* ===== 运行状态 ===== */
    var container = null, canvas = null, renderer = null;
    var scene = null, camera = null;
    var plaques = [], plaqueGroups = [], marks = [], particles = [];
    var selected = null, confirmCb = null, opened = false;
    var rafId = null, clock = null, raycaster = null, pointerV = null;
    var timers = [];
    var pendingVoted = null;             // 场景未建时暂存已投票名单
    var baseCamY = 10, baseCamZ = 3.8, introK = 1, shakeT = 0;
    var candleLight = null;
    var _v = null;                       // 复用向量

    /* ===== 缓动 ===== */
    function easeOutCubic(k) { return 1 - Math.pow(1 - k, 3); }
    function easeInQuad(k) { return k * k; }
    function easeOutBack(k) { var c = 1.70158; return 1 + (c + 1) * Math.pow(k - 1, 3) + c * Math.pow(k - 1, 2); }

    function schedule(fn, ms) {
        var t = setTimeout(fn, ms);
        timers.push(t);
        return t;
    }
    function clearTimers() { timers.forEach(clearTimeout); timers = []; }

    function animateVal(from, to, dur, ease, onUpdate, onDone) {
        var t0 = performance.now();
        function step(now) {
            var k = Math.min(1, (now - t0) / dur);
            onUpdate(from + (to - from) * ease(k));
            if (k < 1) requestAnimationFrame(step); else if (onDone) onDone();
        }
        requestAnimationFrame(step);
    }

    /* ============================================================
     * DOM 覆盖层
     * ============================================================ */
    function ensureContainer() {
        if (container) return container;
        container = document.createElement('div');
        container.id = 'vote3dContainer';

        var style = document.createElement('style');
        style.textContent = [
            '#vote3dContainer{position:fixed;inset:0;z-index:10000;display:none;',
            'background:radial-gradient(ellipse at 50% 34%,#11161c 0%,#07090d 55%,#030405 100%);',
            'font-family:Georgia,"Times New Roman","Songti SC","SimSun",serif;}',
            '#vote3dContainer canvas{position:absolute;inset:0;width:100%;height:100%;display:block;}',
            '.v3d-vignette{position:absolute;inset:0;pointer-events:none;',
            'box-shadow:inset 0 0 140px 46px rgba(0,0,0,.82);}',
            '.v3d-top{position:absolute;top:calc(12px + env(safe-area-inset-top));left:0;right:0;',
            'text-align:center;pointer-events:none;user-select:none;}',
            '.v3d-eyebrow{font-size:10px;letter-spacing:6px;color:#6f6250;opacity:.85;}',
            '.v3d-title{font-size:26px;letter-spacing:14px;text-indent:14px;color:#e6d5ab;margin-top:6px;',
            'text-shadow:0 0 22px rgba(217,195,144,.35),0 2px 8px rgba(0,0,0,.8);}',
            '.v3d-rule{width:120px;height:1px;margin:10px auto 0;',
            'background:linear-gradient(90deg,transparent,#8a744e 30%,#c8ab72 50%,#8a744e 70%,transparent);}',
            '.v3d-hint{font-size:12px;letter-spacing:3px;color:#9c8d75;margin-top:10px;min-height:18px;',
            'text-shadow:0 1px 4px rgba(0,0,0,.9);transition:color .3s;}',
            '.v3d-close{position:absolute;top:calc(10px + env(safe-area-inset-top));right:14px;width:44px;height:44px;',
            'display:flex;align-items:center;justify-content:center;background:none;border:none;color:#7a6c56;',
            'font-size:22px;cursor:pointer;z-index:6;}',
            '.v3d-close:active{color:#c8ab72;}',
            '.v3d-btnwrap{position:absolute;left:0;right:0;bottom:calc(30px + env(safe-area-inset-bottom));',
            'display:flex;justify-content:center;pointer-events:none;}',
            '.v3d-confirm{pointer-events:auto;padding:15px 58px;border-radius:12px;border:1px solid #6a5836;',
            'background:linear-gradient(160deg,#2e2a20,#171410);color:#d9c390;font-family:inherit;',
            'font-size:16px;letter-spacing:6px;text-indent:6px;cursor:pointer;opacity:0;visibility:hidden;',
            'transform:translateY(16px);transition:opacity .35s,transform .35s,visibility .35s,border-color .35s,box-shadow .35s;',
            'box-shadow:0 10px 26px rgba(0,0,0,.6);}',
            '.v3d-confirm.show{opacity:1;visibility:visible;transform:none;border-color:#a8894e;',
            'box-shadow:0 10px 30px rgba(0,0,0,.6),0 0 22px rgba(217,195,144,.22);}',
            '.v3d-confirm:active{transform:scale(.96);}',
            '.v3d-result{position:absolute;top:15%;left:8%;right:8%;text-align:center;pointer-events:none;',
            'opacity:0;transform:translateY(10px) scale(.96);transition:opacity .55s,transform .55s;}',
            '.v3d-result.show{opacity:1;transform:none;}',
            '.v3d-result-main{font-size:clamp(26px,7vw,44px);letter-spacing:8px;text-indent:8px;color:#ffd97a;',
            'text-shadow:0 0 34px rgba(255,217,122,.45),0 3px 10px rgba(0,0,0,.9);}',
            '.v3d-result-sub{font-size:13px;letter-spacing:4px;color:#b0a18a;margin-top:12px;}',
            '.v3d-result-tally{font-size:12px;letter-spacing:1px;color:#7d7060;margin-top:10px;}'
        ].join('');
        document.head.appendChild(style);

        container.innerHTML =
            '<canvas id="vote3dCanvas"></canvas>' +
            '<div class="v3d-vignette"></div>' +
            '<div class="v3d-top">' +
            '  <div class="v3d-eyebrow">AMNESIA · ONLINE</div>' +
            '  <div class="v3d-title">验 票</div>' +
            '  <div class="v3d-rule"></div>' +
            '  <div class="v3d-hint" id="vote3dHint"></div>' +
            '</div>' +
            '<button class="v3d-close" id="vote3dCancel">✕</button>' +
            '<div class="v3d-btnwrap"><button class="v3d-confirm" id="vote3dConfirm">落 锤 定 案</button></div>' +
            '<div class="v3d-result" id="vote3dResult">' +
            '  <div class="v3d-result-main" id="vote3dResultMain"></div>' +
            '  <div class="v3d-result-sub" id="vote3dResultSub"></div>' +
            '  <div class="v3d-result-tally" id="vote3dResultTally"></div>' +
            '</div>';

        document.body.appendChild(container);
        canvas = container.querySelector('#vote3dCanvas');
        return container;
    }

    /* ============================================================
     * 程序化纹理
     * ============================================================ */
    function rr(ctx, x, y, w, h, r) {   // 圆角矩形路径（兼容旧 WebView）
        ctx.beginPath();
        ctx.moveTo(x + r, y);
        ctx.arcTo(x + w, y, x + w, y + h, r);
        ctx.arcTo(x + w, y + h, x, y + h, r);
        ctx.arcTo(x, y + h, x, y, r);
        ctx.arcTo(x, y, x + w, y, r);
        ctx.closePath();
    }

    function makeWoodTexture() {
        var c = document.createElement('canvas');
        c.width = c.height = 512;
        var x = c.getContext('2d');
        var g = x.createLinearGradient(0, 0, 0, 512);
        g.addColorStop(0, '#654a2b'); g.addColorStop(.5, '#584027'); g.addColorStop(1, '#4b3620');
        x.fillStyle = g; x.fillRect(0, 0, 512, 512);

        var i, sx;
        // 板条接缝
        for (i = 0; i < 9; i++) {
            x.fillStyle = 'rgba(' + (30 + Math.random() * 40 | 0) + ',' + (22 + Math.random() * 24 | 0) + ',12,' + (0.10 + Math.random() * 0.15).toFixed(2) + ')';
            x.fillRect(i * 57 + Math.random() * 6, 0, 2.5, 512);
        }
        // 深色木丝
        x.strokeStyle = 'rgba(26,16,7,0.16)';
        for (i = 0; i < 46; i++) {
            x.lineWidth = 0.6 + Math.random() * 1.5;
            sx = Math.random() * 512;
            x.beginPath();
            x.moveTo(sx, -10);
            x.bezierCurveTo(sx + (Math.random() * 44 - 22), 170, sx + (Math.random() * 44 - 22), 340, sx + (Math.random() * 38 - 19), 522);
            x.stroke();
        }
        // 亮色木丝
        x.strokeStyle = 'rgba(196,156,98,0.10)';
        for (i = 0; i < 24; i++) {
            x.lineWidth = 0.5 + Math.random();
            sx = Math.random() * 512;
            x.beginPath();
            x.moveTo(sx, -10);
            x.bezierCurveTo(sx + (Math.random() * 40 - 20), 180, sx + (Math.random() * 40 - 20), 350, sx + (Math.random() * 32 - 16), 522);
            x.stroke();
        }
        // 结疤年轮
        for (i = 0; i < 3; i++) {
            var kx = Math.random() * 512, ky = Math.random() * 512, rot = Math.random() * 0.6;
            for (var r0 = 17; r0 > 2; r0 -= 3.2) {
                x.beginPath();
                x.ellipse(kx, ky, r0 * 1.75, r0, rot, 0, Math.PI * 2);
                x.strokeStyle = 'rgba(28,17,7,' + (0.05 + (17 - r0) * 0.008).toFixed(3) + ')';
                x.lineWidth = 1.6;
                x.stroke();
            }
        }
        var tex = new THREE.CanvasTexture(c);
        tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
        tex.repeat.set(1.3, 1.5);
        tex.anisotropy = 4;
        return tex;
    }

    // 点状粒子贴图（径向渐变）
    function makeDotTexture() {
        var c = document.createElement('canvas');
        c.width = c.height = 64;
        var x = c.getContext('2d');
        var g = x.createRadialGradient(32, 32, 2, 32, 32, 30);
        g.addColorStop(0, 'rgba(255,232,180,1)');
        g.addColorStop(0.45, 'rgba(224,184,110,.55)');
        g.addColorStop(1, 'rgba(200,160,90,0)');
        x.fillStyle = g;
        x.fillRect(0, 0, 64, 64);
        return new THREE.CanvasTexture(c);
    }

    /* 号码牌贴图：木牌框内 —— 眉题 / 大号码 / 头像 / 名字 */
    function makePlaqueTexture(player) {
        var cw = 256, ch = 352;
        var cv = document.createElement('canvas');
        cv.width = cw; cv.height = ch;
        var ctx = cv.getContext('2d');
        var tex = new THREE.CanvasTexture(cv);
        tex.minFilter = THREE.LinearFilter;
        tex.anisotropy = 4;

        function drawAll() {
            ctx.clearRect(0, 0, cw, ch);
            // 牌面底
            var bg = ctx.createLinearGradient(0, 0, 0, ch);
            bg.addColorStop(0, '#4e3b22');
            bg.addColorStop(.55, '#3a2c17');
            bg.addColorStop(1, '#221809');
            rr(ctx, 4, 4, cw - 8, ch - 8, 20);
            ctx.fillStyle = bg;
            ctx.fill();
            // 金描边 + 内线
            ctx.strokeStyle = 'rgba(228,200,150,.8)'; ctx.lineWidth = 5; ctx.stroke();
            ctx.strokeStyle = 'rgba(228,200,150,.20)'; ctx.lineWidth = 1.5;
            rr(ctx, 16, 16, cw - 32, ch - 32, 13); ctx.stroke();
            // 眉题
            ctx.textAlign = 'center';
            ctx.fillStyle = 'rgba(214,188,138,.55)';
            ctx.font = '17px Georgia,serif';
            ctx.fillText('失 忆 症', cw / 2, 42);
            // 大号码
            ctx.fillStyle = '#f2e7cd';
            ctx.font = '900 118px Georgia,"Times New Roman",serif';
            ctx.shadowColor = 'rgba(242,231,205,.4)';
            ctx.shadowBlur = 20;
            ctx.fillText(String(player.number), cw / 2, 158);
            ctx.shadowBlur = 0;
            // 头像
            var ax = cw / 2, ay = 232, ar = 50;
            ctx.save();
            ctx.beginPath(); ctx.arc(ax, ay, ar, 0, Math.PI * 2);
            ctx.fillStyle = '#171009'; ctx.fill();
            ctx.strokeStyle = 'rgba(220,192,142,.75)'; ctx.lineWidth = 4; ctx.stroke();
            ctx.clip();
            if (player.avatar) {
                var img = new Image();
                img.onload = function () {
                    ctx.save();
                    ctx.beginPath(); ctx.arc(ax, ay, ar, 0, Math.PI * 2); ctx.clip();
                    ctx.drawImage(img, ax - ar, ay - ar, ar * 2, ar * 2);
                    ctx.restore();
                    tex.needsUpdate = true;     // 异步图到位后重传纹理
                };
                img.onerror = function () { tex.needsUpdate = true; };
                img.src = player.avatar;
            } else {
                ctx.fillStyle = 'rgba(150,140,118,.5)';
                ctx.beginPath(); ctx.arc(ax, ay - 14, 17, 0, Math.PI * 2); ctx.fill();
                ctx.beginPath(); ctx.ellipse(ax, ay + 26, 28, 22, 0, 0, Math.PI * 2); ctx.fill();
            }
            ctx.restore();
            // 名字（超长截断）
            var name = String(player.name || '');
            ctx.font = 'bold 33px "PingFang SC","Microsoft YaHei",sans-serif';
            while (ctx.measureText(name).width > cw - 36 && name.length > 1) name = name.slice(0, -1);
            if (name !== String(player.name || '')) name += '…';
            ctx.fillStyle = '#dcc9a2';
            ctx.fillText(name, cw / 2, 318);
            // 底部饰线 + 菱形
            ctx.strokeStyle = 'rgba(214,188,138,.4)'; ctx.lineWidth = 1.5;
            ctx.beginPath(); ctx.moveTo(78, 334); ctx.lineTo(178, 334); ctx.stroke();
            ctx.save();
            ctx.translate(cw / 2, 334); ctx.rotate(Math.PI / 4);
            ctx.fillStyle = 'rgba(217,195,144,.6)';
            ctx.fillRect(-3.4, -3.4, 6.8, 6.8);
            ctx.restore();
        }

        drawAll();
        return tex;
    }

    /* ============================================================
     * 场景构建
     * ============================================================ */
    function buildDesk(sceneRef) {
        var wood = makeWoodTexture();
        var topMat = new THREE.MeshStandardMaterial({ map: wood, roughness: 0.55, metalness: 0.05 });
        var sideMat = new THREE.MeshStandardMaterial({ color: 0x38281a, roughness: 0.72, metalness: 0.04 });

        // 椭圆桌面（竖长）：Shape → Extrude → 平放
        var shape = new THREE.Shape();
        shape.absellipse(0, 0, DESK_A, DESK_B, 0, Math.PI * 2, false, 0);
        var geo = new THREE.ExtrudeGeometry(shape, {
            depth: 0.15, curveSegments: 56,
            bevelEnabled: true, bevelThickness: 0.09, bevelSize: 0.09, bevelSegments: 3
        });
        geo.rotateX(-Math.PI / 2);
        geo.translate(0, 0.24, 0);
        var desk = new THREE.Mesh(geo, [topMat, sideMat]);
        desk.receiveShadow = true;
        sceneRef.add(desk);

        // 桌沿金线（椭圆适配的 Torus）
        var rimGeo = new THREE.TorusGeometry(1, 0.016, 10, 96);
        var rimLine = new THREE.Mesh(rimGeo, new THREE.MeshBasicMaterial({ color: 0x8a744e, transparent: true, opacity: 0.5 }));
        rimLine.scale.set(DESK_A + 0.02, DESK_B + 0.02, 1);
        rimLine.rotation.x = Math.PI / 2;
        rimLine.position.y = 0.245;
        sceneRef.add(rimLine);

        // 桌面刻环装饰
        var deco = new THREE.Mesh(
            new THREE.RingGeometry(0.98, 1.0, 72),
            new THREE.MeshBasicMaterial({ color: 0x2a1d0e, transparent: true, opacity: 0.6, side: THREE.DoubleSide })
        );
        deco.rotation.x = -Math.PI / 2;
        deco.position.y = 0.252;
        deco.scale.set(DESK_A * 0.62, DESK_B * 0.62, 1);
        sceneRef.add(deco);

        // 中心徽记：双环 + 菱形
        var mk = new THREE.MeshBasicMaterial({ color: 0xd9c390, transparent: true, opacity: 0.75, side: THREE.DoubleSide });
        var c1 = new THREE.Mesh(new THREE.RingGeometry(0.10, 0.115, 40), mk);
        c1.rotation.x = -Math.PI / 2; c1.position.y = 0.252; c1.scale.set(1.3, 1.85, 1);
        var c2 = new THREE.Mesh(new THREE.RingGeometry(0.16, 0.168, 48), mk);
        c2.rotation.x = -Math.PI / 2; c2.position.y = 0.252; c2.scale.set(1.3, 1.85, 1);
        var diamond = new THREE.Mesh(new THREE.PlaneGeometry(0.09, 0.09), mk);
        diamond.rotation.x = -Math.PI / 2; diamond.rotation.z = Math.PI / 4;
        diamond.position.y = 0.253; diamond.scale.set(1.3, 1.85, 1);
        sceneRef.add(c1); sceneRef.add(c2); sceneRef.add(diamond);
    }

    function seatPos(i, total) {
        // 偶数席：t=30°,90°…（近端正中留空）；奇数席：0° 在远端正中
        var t0 = (total % 2 === 0) ? Math.PI / total : 0;
        var ang = t0 + i * 2 * Math.PI / total;
        return { x: Math.sin(ang) * SEAT_A, z: -Math.cos(ang) * SEAT_B, ang: ang };
    }

    function makePlaque(p, i, total, sceneRef) {
        var pos = seatPos(i, total);
        var group = new THREE.Group();
        group.position.set(pos.x, 0, pos.z);

        // 支架（铜柱）
        var stem = new THREE.Mesh(
            new THREE.CylinderGeometry(0.028, 0.05, 0.16, 12),
            new THREE.MeshStandardMaterial({ color: 0x6a5636, roughness: 0.35, metalness: 0.65 })
        );
        stem.position.y = 0.08;
        stem.castShadow = true;
        group.add(stem);

        // 牌框 + 牌面
        var frameMat = new THREE.MeshStandardMaterial({ color: 0x45311d, roughness: 0.62, metalness: 0.06 });
        var frame = new THREE.Mesh(
            new THREE.BoxGeometry(PLAQUE_W + 0.09, PLAQUE_H + 0.09, 0.055),
            frameMat
        );
        frame.position.y = 0.14 + PLAQUE_H / 2;
        frame.castShadow = true;

        var faceMat = new THREE.MeshStandardMaterial({
            map: makePlaqueTexture(p),
            roughness: 0.6, metalness: 0.05,
            emissive: new THREE.Color(0x8a6a1e), emissiveIntensity: 0
        });
        var face = new THREE.Mesh(new THREE.BoxGeometry(PLAQUE_W, PLAQUE_H, 0.062), faceMat);
        face.position.y = frame.position.y;
        face.position.z = 0.008;
        face.castShadow = true;
        group.add(frame); group.add(face);

        // 牌朝桌心，再向后微仰 8° 便于俯视读牌
        group.rotation.order = 'YXZ';
        group.rotation.y = Math.atan2(-pos.x, -pos.z);
        group.rotation.x = -0.14;

        // 选中金环（桌面）
        var ring = new THREE.Mesh(
            new THREE.RingGeometry(PLAQUE_W * 0.5, PLAQUE_W * 0.62, 40),
            new THREE.MeshBasicMaterial({ color: COL.goldBright, side: THREE.DoubleSide, transparent: true, opacity: 0 })
        );
        ring.rotation.x = -Math.PI / 2;
        ring.position.set(pos.x, 0.26, pos.z);
        sceneRef.add(ring);

        group.userData = {
            number: p.number, name: p.name,
            ring: ring, faceMat: faceMat,
            baseY: 0, lifted: false
        };
        sceneRef.add(group);
        plaques.push({ group: group, player: p, pos: pos, ring: ring });
        plaqueGroups.push(group);
        return group;
    }

    function buildLights(sceneRef) {
        sceneRef.add(new THREE.AmbientLight(0x46525e, 0.85));
        var key = new THREE.DirectionalLight(0xfff0d8, 1.05);
        key.position.set(3.6, 9.5, 4.2);
        key.castShadow = true;
        key.shadow.mapSize.set(1024, 1024);
        key.shadow.camera.left = -5.2; key.shadow.camera.right = 5.2;
        key.shadow.camera.top = 5.2; key.shadow.camera.bottom = -5.2;
        key.shadow.camera.far = 24;
        key.shadow.bias = -0.0009;
        sceneRef.add(key);
        var rim = new THREE.DirectionalLight(0x7d9dd8, 0.32);
        rim.position.set(-5, 6.5, -4.5);
        sceneRef.add(rim);
        candleLight = new THREE.PointLight(COL.candle, 0.55, 9.5, 2);
        candleLight.position.set(0, 2.7, 1.4);
        sceneRef.add(candleLight);
    }

    /* ============================================================
     * 相机自动取景（任意宽高比 → 全桌入画）
     * ============================================================ */
    function computeFit() {
        var pts = [];
        plaques.forEach(function (pl) {
            pts.push(new THREE.Vector3(pl.pos.x, PLAQUE_H + 0.25, pl.pos.z));
        });
        pts.push(new THREE.Vector3(DESK_A + 0.12, 0, 0));
        pts.push(new THREE.Vector3(-DESK_A - 0.12, 0, 0));
        pts.push(new THREE.Vector3(0, 0, DESK_B + 0.12));
        pts.push(new THREE.Vector3(0, 0, -DESK_B - 0.12));

        var probe = new THREE.PerspectiveCamera(50, camera.aspect, 0.1, 100);
        var ok = function (H) {
            probe.position.set(0, H, H * CAM_RATIO);
            probe.lookAt(LOOK_AT);
            probe.updateProjectionMatrix();
            probe.updateMatrixWorld(true);
            for (var i = 0; i < pts.length; i++) {
                _v.copy(pts[i]).project(probe);
                if (_v.x < -0.90 || _v.x > 0.90 || _v.y < -0.83 || _v.y > 0.79) return false;
            }
            return true;
        };
        var lo = 5, hi = 32;
        for (var it = 0; it < 22; it++) {
            var mid = (lo + hi) / 2;
            if (ok(mid)) lo = mid; else hi = mid;
        }
        return { y: lo, z: lo * CAM_RATIO };
    }

    /* ============================================================
     * 粒子 / 脉冲环
     * ============================================================ */
    function burst(x, z) {
        if (!scene) return;
        for (var i = 0; i < 18; i++) {
            var m = new THREE.Mesh(
                new THREE.PlaneGeometry(0.16, 0.16),
                new THREE.MeshBasicMaterial({
                    map: dotTex, transparent: true, opacity: 0.95,
                    blending: THREE.AdditiveBlending, depthWrite: false
                })
            );
            m.position.set(x, 0.35, z);
            m.rotation.x = -Math.PI / 2 * (0.4 + Math.random() * 0.6);
            scene.add(m);
            var a = Math.random() * Math.PI * 2, sp = 0.9 + Math.random() * 1.7;
            particles.push({
                m: m, age: 0, life: 0.85 + Math.random() * 0.4,
                vx: Math.cos(a) * sp * 0.55, vy: 1.6 + Math.random() * 1.5, vz: Math.sin(a) * sp * 0.55
            });
        }
    }

    function pulseRing(x, z) {
        if (!scene) return;
        var r = new THREE.Mesh(
            new THREE.RingGeometry(0.4, 0.47, 44),
            new THREE.MeshBasicMaterial({ color: COL.goldBright, transparent: true, opacity: 0.9, side: THREE.DoubleSide, depthWrite: false })
        );
        r.rotation.x = -Math.PI / 2;
        r.position.set(x, 0.27, z);
        scene.add(r);
        animateVal(0, 1, 620, easeOutCubic, function (k) {
            r.scale.setScalar(1 + k * 2.3);
            r.material.opacity = 0.9 * (1 - k);
        }, function () {
            scene.remove(r); r.geometry.dispose(); r.material.dispose();
        });
    }

    /* ============================================================
     * 渲染循环
     * ============================================================ */
    var dotTex = null;
    function animate() {
        rafId = requestAnimationFrame(animate);
        var dt = Math.min(clock.getDelta(), 0.05);
        var t = clock.getElapsedTime();

        // 入场推镜
        if (introK < 1) {
            introK = Math.min(1, introK + dt / 1.15);
            var e = easeOutCubic(introK);
            camera.position.y = baseCamY * (1.75 - 0.75 * e);
            camera.position.z = baseCamZ * (1.6 - 0.6 * e);
        }
        // 落锤微震
        if (shakeT > 0) {
            shakeT -= dt;
            var k = Math.max(0, shakeT) / 0.32;
            camera.position.x = (Math.random() - 0.5) * 0.06 * k;
            camera.position.y += (Math.random() - 0.5) * 0.05 * k;
        } else if (camera) {
            camera.position.x = 0;
        }
        camera.lookAt(LOOK_AT);

        // 烛光呼吸
        if (candleLight) candleLight.intensity = 0.52 + Math.sin(t * 7.3) * 0.06 + Math.sin(t * 13.7) * 0.045;

        // 选中金环脉动
        plaques.forEach(function (pl) {
            var isSel = (pl.group === selected);
            pl.ring.material.opacity = isSel ? (0.7 + Math.sin(t * 5) * 0.28) : pl.ring.material.opacity * 0.9;
        });

        // 已投票绿晶脉动
        marks.forEach(function (mk) {
            mk.mesh.rotation.y += dt * 13;
            mk.mesh.material.emissiveIntensity = 0.55 + Math.sin(t * 2.6 + mk.phase) * 0.35;
            mk.mesh.position.y = 0.11 + Math.sin(t * 2.6 + mk.phase) * 0.02;
        });

        // 粒子
        for (var i = particles.length - 1; i >= 0; i--) {
            var p = particles[i];
            p.age += dt;
            if (p.age >= p.life || !scene) {
                scene.remove(p.m); p.m.geometry.dispose(); p.m.material.dispose();
                particles.splice(i, 1);
                continue;
            }
            p.vy -= 5.4 * dt;
            p.m.position.x += p.vx * dt;
            p.m.position.y += p.vy * dt;
            p.m.position.z += p.vz * dt;
            if (p.m.position.y < 0.02) { p.m.position.y = 0.02; p.vy *= -0.35; p.vx *= 0.7; p.vz *= 0.7; }
            var fade = 1 - p.age / p.life;
            p.m.material.opacity = 0.95 * fade;
            p.m.scale.setScalar(0.6 + fade * 0.7);
        }

        renderer.render(scene, camera);
    }

    /* ============================================================
     * 交互
     * ============================================================ */
    function setHint(txt, bright) {
        var h = document.getElementById('vote3dHint');
        if (h) { h.textContent = txt; h.style.color = bright ? '#e6d5ab' : '#9c8d75'; }
    }

    function selectPlaque(group) {
        if (!opened || selected === group) return;
        if (selected) {
            selected.userData.faceMat.emissiveIntensity = 0;
            selected.userData.ring.material.opacity = 0;
            var old = selected;
            animateVal(old.position.y, 0, 260, easeOutCubic, function (v) { old.position.y = v; });
        }
        selected = group;
        group.userData.faceMat.emissiveIntensity = 0.5;
        animateVal(group.position.y, 0.15, 300, easeOutBack, function (v) { group.position.y = v; });
        var btn = document.getElementById('vote3dConfirm');
        if (btn) btn.classList.add('show');
        setHint(group.userData.number + '号 · ' + group.userData.name + ' —— 落锤确认', true);
    }

    function onPointer(e) {
        if (!opened || !raycaster) return;
        var rect = canvas.getBoundingClientRect();
        pointerV.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
        pointerV.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
        raycaster.setFromCamera(pointerV, camera);
        var hits = raycaster.intersectObjects(plaqueGroups, true);
        if (hits.length) {
            var g = hits[0].object;
            while (g && plaqueGroups.indexOf(g) === -1) g = g.parent;
            if (g) selectPlaque(g);
        }
    }

    function onResize() {
        if (!container || container.style.display === 'none' || !renderer || !camera) return;
        var w = window.innerWidth, h = window.innerHeight;
        renderer.setSize(w, h, false);
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
        var fit = computeFit();
        baseCamY = fit.y; baseCamZ = fit.z;
        camera.position.set(0, baseCamY, baseCamZ);
    }

    /* ============================================================
     * 资源回收
     * ============================================================ */
    function disposeScene() {
        if (!scene) return;
        scene.traverse(function (o) {
            if (o.geometry) o.geometry.dispose();
            if (o.material) {
                var mats = Array.isArray(o.material) ? o.material : [o.material];
                mats.forEach(function (mt) {
                    if (mt.map) mt.map.dispose();
                    mt.dispose();
                });
            }
        });
        scene = null;
    }

    function close() {
        opened = false;
        clearTimers();
        if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
        particles.forEach(function (p) { if (scene) scene.remove(p.m); });
        particles = [];
        plaques = []; plaqueGroups = []; marks = [];
        selected = null; confirmCb = null;
        disposeScene();
        if (container) container.style.display = 'none';
    }

    /* ============================================================
     * 对外 API
     * ============================================================ */
    window.Vote3D = {
        /* 打开验票桌：playerList=[{number,name,avatar}], onConfirm(number) */
        open: function (playerList, onConfirm) {
            ensureContainer();
            clearTimers();
            container.style.display = 'block';
            opened = true;
            confirmCb = onConfirm;
            selected = null;
            introK = 0; shakeT = 0;

            setHint('俯身 · 点选桌上的号码牌', false);
            var btn = document.getElementById('vote3dConfirm');
            if (btn) btn.classList.remove('show');
            var res = document.getElementById('vote3dResult');
            if (res) res.classList.remove('show');

            // 渲染器只建一次；场景每次重建
            if (!renderer) {
                renderer = new THREE.WebGLRenderer({ canvas: canvas, antialias: true });
                renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
                renderer.outputEncoding = THREE.sRGBEncoding;
                renderer.toneMapping = THREE.ACESFilmicToneMapping;
                renderer.toneMappingExposure = 1.08;
                renderer.shadowMap.enabled = true;
                renderer.shadowMap.type = THREE.PCFSoftShadowMap;
            }
            renderer.setSize(window.innerWidth, window.innerHeight, false);

            if (!dotTex) dotTex = makeDotTexture();
            if (!raycaster) { raycaster = new THREE.Raycaster(); pointerV = new THREE.Vector2(); _v = new THREE.Vector3(); }
            if (!clock) clock = new THREE.Clock();

            scene = new THREE.Scene();
            scene.fog = new THREE.FogExp2(0x05070a, 0.028);
            camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.1, 100);
            camera.position.set(0, 18, 7);

            buildLights(scene);
            buildDesk(scene);

            // 立牌错峰弹出
            var total = playerList.length;
            playerList.forEach(function (p, i) {
                var g = makePlaque(p, i, total, scene);
                g.scale.setScalar(0.01);
                schedule(function () {
                    animateVal(0.01, 1, 520, easeOutBack, function (v) { g.scale.setScalar(v); });
                }, 160 + i * 70);
            });

            // 自动取景
            var fit = computeFit();
            baseCamY = fit.y; baseCamZ = fit.z;
            camera.position.set(0, baseCamY * 1.75, baseCamZ * 1.6);

            // 先于 open 到达的已投票名单在此冲销
            if (pendingVoted) { this.markVoted(pendingVoted); pendingVoted = null; }

            // 事件（覆盖式绑定，防重复）
            canvas.onpointerdown = onPointer;
            document.getElementById('vote3dCancel').onclick = function () { close(); };
            document.getElementById('vote3dConfirm').onclick = function () {
                if (!opened || !selected || !confirmCb) return;
                var g = selected, num = g.userData.number;
                opened = false;
                g.userData.faceMat.emissiveIntensity = 0.9;
                pulseRing(g.position.x, g.position.z);
                setHint('已落锤 · 静候他人', true);
                btn.classList.remove('show');
                var cb = confirmCb; confirmCb = null;
                schedule(function () { cb(num); }, 240);
            };
            window.removeEventListener('resize', onResize);
            window.addEventListener('resize', onResize);

            if (!rafId) animate();
        },

        /* 标记已投票玩家：牌脚亮起绿色晶石 */
        markVoted: function (numbers) {
            var list = numbers || [];
            if (!scene) { pendingVoted = list.slice(); return; }
            list.forEach(function (num) {
                var hit = plaques.find(function (pl) { return pl.player.number === num; });
                if (!hit || hit.marked) return;
                hit.marked = true;
                var dx = -hit.pos.x, dz = -hit.pos.z;
                var len = Math.sqrt(dx * dx + dz * dz) || 1;
                var gem = new THREE.Mesh(
                    new THREE.OctahedronGeometry(0.105),
                    new THREE.MeshStandardMaterial({
                        color: COL.green, emissive: new THREE.Color(0x1d7a42),
                        roughness: 0.3, metalness: 0.15, emissiveIntensity: 0.6
                    })
                );
                gem.position.set(hit.pos.x + dx / len * 0.34, 0.11, hit.pos.z + dz / len * 0.34);
                scene.add(gem);
                marks.push({ mesh: gem, phase: Math.random() * 6.28 });
            });
        },

        /* 结算：被处决者立牌按倒桌面 → 尘埃 → 镜头微震 → 横幅揭示 */
        reveal: function (executedNumber, name, tally) {
            if (!scene) return;
            opened = false;
            var res = document.getElementById('vote3dResult');
            var main = document.getElementById('vote3dResultMain');
            var sub = document.getElementById('vote3dResultSub');
            var tal = document.getElementById('vote3dResultTally');
            if (!res) return;

            var tallyTxt = '';
            if (tally) {
                var parts = [];
                Object.keys(tally).forEach(function (n) { parts.push(n + '号 ' + tally[n] + '票'); });
                tallyTxt = parts.join(' · ');
            }

            var hit = (executedNumber != null && executedNumber !== -1)
                ? plaques.find(function (pl) { return pl.player.number === executedNumber; })
                : null;

            if (!hit) {
                main.textContent = '平 票';
                main.style.color = '#c8a08a';
                sub.textContent = '无人被处决 · 长夜继续';
                tal.textContent = tallyTxt;
                res.classList.add('show');
                schedule(function () { res.classList.remove('show'); schedule(close, 520); }, 2200);
                return;
            }

            var g = hit.group;
            // 其余立牌微光熄灭
            plaques.forEach(function (pl) {
                if (pl !== hit) pl.group.userData.faceMat.emissiveIntensity = 0;
            });

            schedule(function () {
                var dirX = -hit.pos.x, dirZ = -hit.pos.z;
                var len = Math.sqrt(dirX * dirX + dirZ * dirZ) || 1;
                dirX /= len; dirZ /= len;
                // 按倒（顶朝桌心扣下）+ 朝桌心滑
                animateVal(0, 1, 640, easeInQuad, function (k) {
                    g.rotation.x = -0.14 + 1.66 * k;
                    g.position.x = hit.pos.x + dirX * 0.62 * k;
                    g.position.z = hit.pos.z + dirZ * 0.62 * k;
                    g.position.y = -0.05 * k;
                }, function () {
                    burst(g.position.x, g.position.z);
                    shakeT = 0.32;
                });
            }, 300);

            schedule(function () {
                main.textContent = '⚖ ' + (name || (executedNumber + '号')) + ' 被处决';
                main.style.color = '#ffd97a';
                sub.textContent = '号码牌已清离桌面';
                tal.textContent = tallyTxt;
                res.classList.add('show');
            }, 1250);

            schedule(function () {
                res.classList.remove('show');
                schedule(close, 520);
            }, 3400);
        }
    };
})();