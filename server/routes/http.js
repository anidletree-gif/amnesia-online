const fs = require('fs');
const path = require('path');
const url = require('url');
const config = require('../config');
const { register, login, updateAvatar, updateNickname, isAllowedEmail, upload } = require('../core/auth');
const { sendVerificationCode, verifyCode } = require('../mailer');
// ★ presets.json 缺失兜底，避免启动崩溃
let presetsData = {};
try { presetsData = require('../presets.json'); } catch(e) { presetsData = {}; }

let presets = presetsData.presets || {
    '6人基础': { '凶手':1, '侦探':1, '精神病':1, '失忆者':3 },
    '8人进阶': { '凶手':1, '虚构者':1, '侦探':1, '错构者':1, '精神分裂':1, '精神病':1, '失忆者':2 }
};
let activePreset = presetsData.active || '8人进阶';

function getAdminPassword() {
    try {
        const pwdFile = path.join(__dirname, '..', 'admin_password.txt');
        return fs.readFileSync(pwdFile, 'utf8').trim();
    } catch(e) {
        return config.ADMIN_PASSWORD || 'admin123';
    }
}

function handleHttp(req, res) {
    const reqHost = req.headers.host?.split(':')[0];
    const isLocal = reqHost === '127.0.0.1' || reqHost === 'localhost' || req.socket?.localAddress === '127.0.0.1';
    // ★ 局域网 IP 段放行（本地/局域网开服）：192.168.x / 10.x / 172.16-31.x
    const isLAN = /^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(reqHost || '');
    const hostAllowed = !config.ALLOWED_HOST || reqHost === config.ALLOWED_HOST || isLocal || isLAN;

    if (!hostAllowed) {
        res.writeHead(403);
        res.end('Forbidden');
        return;
    }

    const parsedUrl = url.parse(req.url, true);
    const pathname = parsedUrl.pathname;

    // 管理面板
    if (pathname === '/admin') {
        const auth = req.headers.authorization;
        if (!auth || !auth.startsWith('Basic ')) {
            res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Admin"' });
            res.end('Unauthorized');
            return;
        }
        const cred = Buffer.from(auth.slice(6), 'base64').toString().split(':');
        if (cred[1] !== getAdminPassword()) {
            res.writeHead(403);
            res.end('Forbidden');
            return;
        }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>管理面板</title><style>body{background:#121212;color:#eee;font-family:sans-serif;padding:20px} textarea{width:100%;height:300px;background:#1e1e1e;color:#fff} button{background:#5f7e6b;padding:10px 20px;border-radius:30px;color:#fff;border:none;margin:5px;}</style></head><body><h1>板子配置</h1><p>当前激活: <span id="activeName">${activePreset}</span></p><textarea id="presetsJson">${JSON.stringify(presets, null, 2)}</textarea><br><button onclick="savePresets()">保存</button><button onclick="setActive()">设为默认</button><script>async function savePresets(){try{const p=JSON.parse(document.getElementById('presetsJson').value);await fetch('/admin/presets',{method:'POST',body:JSON.stringify({presets:p,active:'${activePreset}'})});alert('保存成功');}catch(e){alert('JSON错误');}} async function setActive(){const n=prompt('预设名称');if(n){await fetch('/admin/presets',{method:'POST',body:JSON.stringify({presets:${JSON.stringify(presets)},active:n})});location.reload();}}</script></body></html>`);
        return;
    }

    // 预设API
    if (pathname === '/admin/presets' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ presets, active: activePreset }));
        return;
    }
    if (pathname === '/admin/presets' && req.method === 'POST') {
        let body = '';
        req.on('data', c => body += c);
        req.on('end', () => {
            try {
                const d = JSON.parse(body);
                if (d.presets) presets = d.presets;
                if (d.active) activePreset = d.active;
                fs.writeFileSync(path.join(__dirname, '..', 'presets.json'), JSON.stringify({ presets, active: activePreset }, null, 2));
                res.writeHead(200);
                res.end('OK');
            } catch(e) {
                res.writeHead(400);
                res.end('Invalid JSON');
            }
        });
        return;
    }

    // 发送验证码（含冷却）
    if (pathname === '/api/send-code' && req.method === 'POST') {
        let body = '';
        req.on('data', c => body += c);
        req.on('end', () => {
            try {
                const { email } = JSON.parse(body);
                // ★ 开放注册模式：不发邮件、不校验域名，直接提示无需验证码
                if (config.OPEN_REGISTER) {
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ message: '开放注册模式，无需验证码' }));
                    return;
                }
                if (!isAllowedEmail(email)) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: '只支持主流邮箱注册' }));
                    return;
                }
                const result = sendVerificationCode(email);
                if (result === null) {
                    res.writeHead(429, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: '发送过于频繁，请60秒后再试' }));
                    return;
                }
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ message: '验证码已发送' }));
            } catch(e) {
                res.writeHead(400);
                res.end(JSON.stringify({ error: e.message }));
            }
        });
        return;
    }

    // 注册
    if (pathname === '/api/register' && req.method === 'POST') {
        let body = '';
        req.on('data', c => body += c);
        req.on('end', () => {
            try {
                const { email, nickname, password, code } = JSON.parse(body);
                // ★ 开放注册模式：跳过验证码校验
                if (!config.OPEN_REGISTER && !verifyCode(email, code)) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: '验证码错误或已过期' }));
                    return;
                }
                register(email, nickname, password, (err, user) => {
                    if (err) {
                        res.writeHead(400, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ error: err }));
                    } else {
                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify(user));
                    }
                });
            } catch(e) {
                res.writeHead(400);
                res.end(JSON.stringify({ error: e.message }));
            }
        });
        return;
    }

    // 登录
    if (pathname === '/api/login' && req.method === 'POST') {
        let body = '';
        req.on('data', c => body += c);
        req.on('end', () => {
            try {
                const { email, password } = JSON.parse(body);
                login(email, password, (err, user) => {
                    if (err) {
                        res.writeHead(400, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ error: err }));
                    } else {
                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify(user));
                    }
                });
            } catch(e) {
                res.writeHead(400);
                res.end(JSON.stringify({ error: e.message }));
            }
        });
        return;
    }

    // 头像上传
    if (pathname === '/api/upload-avatar' && req.method === 'POST') {
        upload.single('avatar')(req, res, (err) => {
            if (err) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: err.message }));
                return;
            }
            const email = req.body.email;
            if (!email) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: '缺少用户标识' }));
                return;
            }
            const avatarPath = '/avatars/' + req.file.filename;
            updateAvatar(email, avatarPath, (err, user) => {
                if (err) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: err }));
                } else {
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify(user));
                }
            });
        });
        return;
    }

    // 修改昵称
    if (pathname === '/api/update-nickname' && req.method === 'POST') {
        let body = '';
        req.on('data', c => body += c);
        req.on('end', () => {
            try {
                const { email, nickname } = JSON.parse(body);
                updateNickname(email, nickname, (err, user) => {
                    if (err) {
                        res.writeHead(400, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ error: err }));
                    } else {
                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify(user));
                    }
                });
            } catch(e) {
                res.writeHead(400);
                res.end(JSON.stringify({ error: e.message }));
            }
        });
        return;
    }

    // 房间列表
    if (pathname === '/rooms') {
        const rooms = require('../core/game').getPublicRooms();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(rooms));
        return;
    }

    // 静态文件（★ 防路径遍历：过滤 .. 并校验最终路径必须落在 public 目录内）
    const publicDir = path.join(__dirname, '..', 'public');
    let safePath = decodeURIComponent(pathname === '/' ? '/index.html' : pathname);
    // 过滤掉所有 .. 段，防止读取 public 之外的文件（如 config.js）
    safePath = safePath.split('/').filter(seg => seg !== '..' && seg !== '.').join('/');
    const filePath = path.join(publicDir, safePath);
    if (filePath !== publicDir && !filePath.startsWith(publicDir + path.sep)) {
        res.writeHead(403);
        res.end('Forbidden');
        return;
    }
    const ext = path.extname(filePath).toLowerCase();
    const mime = {
        '.html': 'text/html; charset=utf-8',
        '.js': 'text/javascript',
        '.css': 'text/css',
        '.json': 'application/json',
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.svg': 'image/svg+xml',
        '.ico': 'image/x-icon',
        '.wav': 'audio/wav',
        '.mp3': 'audio/mpeg',
        '.opus': 'audio/opus'
    };

    fs.readFile(filePath, (err, data) => {
        if (err) {
            res.writeHead(404);
            res.end('Not found');
        } else {
            res.writeHead(200, { 'Content-Type': mime[ext] || 'application/octet-stream' });
            res.end(data);
        }
    });
}

module.exports = { handleHttp };