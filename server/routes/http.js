const fs = require('fs');
const path = require('path');
const url = require('url');
const config = require('../config');
const { register, login, updateAvatar, updateNickname, updateSignature, updateTags, updateMarks, changePassword, resetPasswordByEmail, isAllowedEmail, getUser, upload, getAllUsers, adminDeleteUser, adminResetPassword, verifySession, isAdminLogin, createSession } = require('../core/auth');
const { sendVerificationCode, verifyCode } = require('../mailer');
const gameCore = require('../core/game');
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

// ★ admin 鉴权：从 query 或 Authorization Bearer 取 token，验证为管理员会话则返回 true
function isAdminRequest(req) {
    const qToken = req._parsedUrl?.query?.token || url.parse(req.url, true).query.token;
    let token = qToken;
    const auth = req.headers.authorization || '';
    if (!token && auth.startsWith('Bearer ')) token = auth.slice(7);
    if (!token) return false;
    const s = verifySession(token);
    return !!(s && s.isAdmin);
}

// ★ 普通用户鉴权：从 Authorization Bearer 或 query 取 token，返回会话或 null
function readToken(req) {
    const auth = req.headers.authorization || '';
    if (auth.startsWith('Bearer ')) return auth.slice(7);
    return url.parse(req.url, true).query.token || '';
}

// ★ 校验 token 且会话邮箱与请求目标邮箱一致，防冒充
function requireUserAuth(req, res, email) {
    const token = readToken(req);
    if (!token) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: '未登录' }));
        return null;
    }
    const s = verifySession(token);
    if (!s) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: '登录已失效，请重新登录' }));
        return null;
    }
    if (email && s.email !== email) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: '无权操作' }));
        return null;
    }
    return s;
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

    // 管理面板（★ token 会话鉴权，未登录一律 404 不暴露后台存在）
    if (pathname === '/admin') {
        if (!isAdminRequest(req)) {
            res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end('Not Found');
            return;
        }
        const adminHtmlPath = path.join(__dirname, '..', 'public', 'admin.html');
        fs.readFile(adminHtmlPath, (err, data) => {
            if (err) {
                res.writeHead(404);
                res.end('Not Found');
                return;
            }
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(data);
        });
        return;
    }

    // ★ 后台API：全部以 /admin/ 开头且非 /admin/presets(GET供前端板子详情用) 的接口都需要管理员鉴权
    if (pathname.startsWith('/admin/') && !(pathname === '/admin/presets' && req.method === 'GET')) {
        if (!isAdminRequest(req)) {
            res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end('Not Found');
            return;
        }
    }

    // ★ 后台API：统计
    if (pathname === '/admin/stats' && req.method === 'GET') {
        const users = getAllUsers();
        const rooms = gameCore.getAllRooms();
        const inGamePlayers = rooms.reduce((sum, r) => sum + r.playerCount, 0);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ totalUsers: users.length, activeRooms: rooms.filter(r => r.gameStarted).length, inGamePlayers, presets: Object.keys(presets).length }));
        return;
    }

    // ★ 后台API：全部房间
    if (pathname === '/admin/rooms' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(gameCore.getAllRooms()));
        return;
    }

    // ★ 后台API：全部用户
    if (pathname === '/admin/users' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(getAllUsers()));
        return;
    }

    // ★ 后台API：删除用户
    if (pathname === '/admin/users/delete' && req.method === 'POST') {
        let body = '';
        req.on('data', c => body += c);
        req.on('end', () => {
            try {
                const { email } = JSON.parse(body);
                const err = adminDeleteUser(email);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(err ? JSON.stringify({ ok: false, error: err }) : JSON.stringify({ ok: true }));
            } catch(e) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: e.message })); }
        });
        return;
    }

    // ★ 后台API：重置密码
    if (pathname === '/admin/users/reset' && req.method === 'POST') {
        let body = '';
        req.on('data', c => body += c);
        req.on('end', () => {
            try {
                const { email, password } = JSON.parse(body);
                const err = adminResetPassword(email, password);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(err ? JSON.stringify({ ok: false, error: err }) : JSON.stringify({ ok: true }));
            } catch(e) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: e.message })); }
        });
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

    // ★ 前端配置接口：让页面自动感知 OPEN_REGISTER 等开关（验证码栏显示/隐藏）
    if (pathname === '/api/config' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            openRegister: !!config.OPEN_REGISTER
        }));
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

    // 登录（管理员也是 users.json 里的真实用户，统一走 login，role 区分权限）
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

    // 获取用户最新信息（主页头像同步，避免 localStorage 缓存旧头像）
    if (pathname === '/api/me' && req.method === 'GET') {
        try {
            const email = new URL(req.url, 'http://x').searchParams.get('email') || '';
            if (!requireUserAuth(req, res, email)) return;
            const u = getUser(email);
            if (u) {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ email: u.email, nickname: u.nickname, avatar: u.avatar }));
            } else {
                res.writeHead(404, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: '用户不存在' }));
            }
        } catch(e) {
            res.writeHead(400);
            res.end(JSON.stringify({ error: e.message }));
        }
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
            if (!requireUserAuth(req, res, email)) return;
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
                if (!requireUserAuth(req, res, email)) return;
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

    // 修改密码
    if (pathname === '/api/change-password' && req.method === 'POST') {
        let body = '';
        req.on('data', c => body += c);
        req.on('end', () => {
            try {
                const { email, oldPassword, newPassword } = JSON.parse(body);
                if (!requireUserAuth(req, res, email)) return;
                changePassword(email, oldPassword, newPassword, (err) => {
                    if (err) {
                        res.writeHead(400, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ error: err }));
                    } else {
                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ ok: true }));
                    }
                });
            } catch(e) {
                res.writeHead(400);
                res.end(JSON.stringify({ error: e.message }));
            }
        });
        return;
    }

    // 更新个性签名
    if (pathname === '/api/update-signature' && req.method === 'POST') {
        let body = '';
        req.on('data', c => body += c);
        req.on('end', () => {
            try {
                const { email, signature } = JSON.parse(body);
                if (!requireUserAuth(req, res, email)) return;
                updateSignature(email, signature, (err, user) => {
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

    // 更新自定义标记（对局贴标签，与个人标签独立）
    if (pathname === '/api/update-marks' && req.method === 'POST') {
        let body = '';
        req.on('data', c => body += c);
        req.on('end', () => {
            try {
                const { email, marks } = JSON.parse(body);
                if (!requireUserAuth(req, res, email)) return;
                updateMarks(email, marks, (err, user) => {
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

    // 更新个人标签
    if (pathname === '/api/update-tags' && req.method === 'POST') {
        let body = '';
        req.on('data', c => body += c);
        req.on('end', () => {
            try {
                const { email, tags } = JSON.parse(body);
                if (!requireUserAuth(req, res, email)) return;
                updateTags(email, tags, (err, user) => {
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

    // 找回密码（邮箱验证码重置，不校验旧密码）
    if (pathname === '/api/reset-password' && req.method === 'POST') {
        let body = '';
        req.on('data', c => body += c);
        req.on('end', () => {
            try {
                const { email, code, newPassword } = JSON.parse(body);
                resetPasswordByEmail(email, code, newPassword, (err) => {
                    if (err) {
                        res.writeHead(400, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ error: err }));
                    } else {
                        res.writeHead(200, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ ok: true }));
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
            const mimeType = mime[ext] || 'application/octet-stream';
            // ★ 强制 HTML/JS/CSS/JSON 每次校验，避免前端更新后浏览器用旧缓存
            const cacheable = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.ico', '.wav', '.mp3', '.opus'].includes(ext);
            const headers = { 'Content-Type': mimeType };
            if (!cacheable) headers['Cache-Control'] = 'no-cache, no-store, must-revalidate';
            res.writeHead(200, headers);
            res.end(data);
        }
    });
}

module.exports = { handleHttp };