const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const config = require('../config');
const { verifyCode } = require('../mailer');

const USERS_FILE = path.join(__dirname, '..', 'users.json');
const SESSIONS_FILE = path.join(__dirname, '..', 'sessions.json');
const ROLE_ADMIN = 0; // 管理员
const ROLE_USER = 1;  // 普通用户

// ★ 内存缓存：启动时读一次盘，之后所有读写走内存，避免每请求同步读盘（高并发瓶颈）
let usersCache = null;

// 加载用户数据库（首次调用读盘，之后返回内存缓存）
function loadUsers() {
    if (usersCache) return usersCache;
    try {
        if (fs.existsSync(USERS_FILE)) {
            usersCache = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
            return usersCache;
        }
    } catch(e) {
        console.error('加载用户数据失败:', e.message);
    }
    usersCache = {};
    return usersCache;
}

// 保存用户数据库（同步更新缓存 + 落盘）
function saveUsers(users) {
    usersCache = users; // ★ 先更新缓存，保证内存与磁盘一致
    try {
        fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
    } catch(e) {
        console.error('保存用户数据失败:', e.message);
    }
}

// 检查邮箱是否允许注册
function isAllowedEmail(email) {
    const domain = email.split('@')[1]?.toLowerCase();
    return config.ALLOWED_DOMAINS.includes(domain);
}

// 头像上传配置
const MIME_EXT = {
    'image/jpeg': '.jpg',
    'image/png': '.png',
    'image/gif': '.gif',
    'image/webp': '.webp'
};

const avatarStorage = multer.diskStorage({
    destination: (req, file, cb) => {
        const dir = path.join(__dirname, '..', config.AVATAR_DIR);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        cb(null, dir);
    },
    filename: (req, file, cb) => {
        // ★ 扩展名由 mimetype 白名单派生，绝不信赖 originalname（防伪造 .html/.js 等）
        const ext = MIME_EXT[file.mimetype] || '.jpg';
        const uniqueName = Date.now() + '-' + Math.round(Math.random() * 1E9) + ext;
        cb(null, uniqueName);
    }
});

const upload = multer({
    storage: avatarStorage,
    limits: { fileSize: config.AVATAR_MAX_SIZE },
    fileFilter: (req, file, cb) => {
        // ★ 严格白名单，仅允许真实图片 mimetype
        if (MIME_EXT[file.mimetype]) {
            cb(null, true);
        } else {
            cb(new Error('只允许上传 JPG/PNG/GIF/WEBP 图片'));
        }
    }
});

// ★ 确保管理员账号存在于 users.json（权限组 0=管理员，1=普通用户）
function ensureAdminUser() {
    const users = loadUsers();
    if (!users[config.ADMIN_USER]) {
        users[config.ADMIN_USER] = {
            email: config.ADMIN_USER,
            nickname: '管理员',
            password: bcrypt.hashSync(config.ADMIN_PASSWORD, 10),
            avatar: null,
            signature: '',
            verified: true,
            tags: [],
            marks: [],
            role: ROLE_ADMIN,
            createdAt: new Date().toISOString()
        };
        saveUsers(users);
    } else if (users[config.ADMIN_USER].role !== ROLE_ADMIN) {
        users[config.ADMIN_USER].role = ROLE_ADMIN;
        saveUsers(users);
    }
}

// 注册
function register(email, nickname, password, callback) {
    const users = loadUsers();

    if (!config.OPEN_REGISTER && !isAllowedEmail(email)) return callback('只支持主流邮箱注册'); // ★ 开放注册模式跳过域名白名单
    if (users[email]) return callback('该邮箱已注册');
    if (Object.values(users).some(u => u.nickname === nickname)) return callback('昵称已被使用');
    if (password.length < 6) return callback('密码至少6位');
    if (nickname.length < 1 || nickname.length > 12) return callback('昵称长度1-12位');

    const hashedPassword = bcrypt.hashSync(password, 10);
    users[email] = {
        email,
        nickname,
        password: hashedPassword,
        avatar: null,
        signature: '',
        verified: true,
        tags: [],
        marks: [],
        role: ROLE_USER,
        createdAt: new Date().toISOString()
    };

    saveUsers(users);
    callback(null, { email, nickname, avatar: null, role: ROLE_USER, token: createSession(email, ROLE_USER) });
}

// 登录
function login(email, password, callback) {
    const users = loadUsers();

    const user = users[email];
    if (!user) return callback('邮箱未注册');
    if (!bcrypt.compareSync(password, user.password)) return callback('密码错误');

    const role = (user.role === ROLE_ADMIN) ? ROLE_ADMIN : ROLE_USER;
    callback(null, {
        email: user.email,
        nickname: user.nickname,
        avatar: user.avatar,
        signature: user.signature || '',
        tags: user.tags || [],
        marks: user.marks || [],
        role,
        isAdmin: role === ROLE_ADMIN,
        token: createSession(email, role)
    });
}

// 更新个人标签（数组，每个 1-8 字，最多 8 个，展示在个人资料）
function updateTags(email, tags, callback) {
    const users = loadUsers();
    const user = users[email];
    if (!user) return callback('用户不存在');
    const list = Array.isArray(tags) ? tags.filter(t => typeof t === 'string' && t.trim()).map(t => t.trim().slice(0, 8)).slice(0, 8) : [];
    user.tags = list;
    saveUsers(users);
    callback(null, { email: user.email, nickname: user.nickname, avatar: user.avatar, tags: list, marks: user.marks || [] });
}

// 更新自定义标记（对局里给玩家贴的标签，与个人标签完全独立；每个 1-6 字，最多 12 个）
function updateMarks(email, marks, callback) {
    const users = loadUsers();
    const user = users[email];
    if (!user) return callback('用户不存在');
    const list = Array.isArray(marks) ? marks.filter(m => typeof m === 'string' && m.trim()).map(m => m.trim().slice(0, 6)).slice(0, 12) : [];
    user.marks = list;
    saveUsers(users);
    callback(null, { email: user.email, nickname: user.nickname, avatar: user.avatar, tags: user.tags || [], marks: list });
}

// 找回密码：通过邮箱验证码重置（不校验旧密码）
function resetPasswordByEmail(email, code, newPassword, callback) {
    const users = loadUsers();
    const user = users[email];
    if (!user) return callback('用户不存在');
    if (!verifyCode(email, code)) return callback('验证码错误或已过期');
    if (!newPassword || newPassword.length < 6) return callback('新密码至少6位');
    user.password = bcrypt.hashSync(newPassword, 10);
    saveUsers(users);
    callback(null);
}

// ★ 会话管理：登录/注册后发 token，验证身份（防邮箱冒充）；持久化到 sessions.json，重启不失效
const SESSION_TTL = 30 * 24 * 3600 * 1000; // 30天
let sessionsCache = null;

function loadSessions() {
    if (sessionsCache) return sessionsCache;
    try {
        if (fs.existsSync(SESSIONS_FILE)) {
            sessionsCache = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
            return sessionsCache;
        }
    } catch(e) {}
    sessionsCache = {};
    return sessionsCache;
}
function saveSessions() {
    try { fs.writeFileSync(SESSIONS_FILE, JSON.stringify(sessionsCache || {}, null, 2)); } catch(e) {}
}

function createSession(email, role) {
    const token = require('crypto').randomBytes(24).toString('hex');
    const s = loadSessions();
    s[token] = { email, role: (role === ROLE_ADMIN ? ROLE_ADMIN : ROLE_USER), expires: Date.now() + SESSION_TTL };
    saveSessions();
    return token;
}

function verifySession(token) {
    if (!token) return null;
    const s = loadSessions();
    const rec = s[token];
    if (!rec) return null;
    if (rec.expires < Date.now()) { delete s[token]; saveSessions(); return null; }
    return { email: rec.email, role: rec.role, isAdmin: rec.role === ROLE_ADMIN };
}

function revokeSession(token) {
    if (!token) return;
    const s = loadSessions();
    delete s[token];
    saveSessions();
}

// ★ 清理过期会话（定时调用，防止 sessions.json 无限膨胀）
function purgeExpiredSessions() {
    const s = loadSessions();
    const now = Date.now();
    let changed = false;
    for (const token of Object.keys(s)) {
        if (!s[token] || s[token].expires < now) {
            delete s[token];
            changed = true;
        }
    }
    if (changed) saveSessions();
    return changed;
}

// ★ 是否为管理员账号（与 config 对照）
function isAdminLogin(email, password) {
    return email === config.ADMIN_USER && password === config.ADMIN_PASSWORD;
}

// 获取用户最新信息（邮箱精确匹配，主页头像用实时数据，避免 localStorage 缓存旧值）
function getUser(email) {
    const u = loadUsers()[email];
    if (!u) return null;
    return { email: u.email, nickname: u.nickname, avatar: u.avatar, signature: u.signature || '', tags: u.tags || [], marks: u.marks || [], role: (u.role === ROLE_ADMIN ? ROLE_ADMIN : ROLE_USER) };
}

// 更新头像
function updateAvatar(email, avatarPath, callback) {
    const users = loadUsers();
    if (!users[email]) return callback('用户不存在');

    // 删除旧头像文件
    if (users[email].avatar) {
        const oldPath = path.join(__dirname, '..', 'public', users[email].avatar);
        if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
    }

    users[email].avatar = avatarPath;
    saveUsers(users);
    callback(null, users[email]);
}

// 更新昵称（1-12位中文/字母/数字，全站唯一）
function updateNickname(email, nickname, callback) {
    const users = loadUsers();
    const user = users[email];
    if (!user) return callback('用户不存在');
    nickname = (nickname || '').trim();
    if (!/^[\u4e00-\u9fa5a-zA-Z0-9]{1,12}$/.test(nickname)) return callback('昵称仅限中文/字母/数字，1-12位');
    if (Object.values(users).some(u => u.email !== email && u.nickname === nickname)) return callback('昵称已被使用');
    user.nickname = nickname;
    saveUsers(users);
    callback(null, { email: user.email, nickname: user.nickname, avatar: user.avatar, signature: user.signature || '', tags: user.tags || [] });
}

// 更新个性签名（最多 50 字）
function updateSignature(email, signature, callback) {
    const users = loadUsers();
    const user = users[email];
    if (!user) return callback('用户不存在');
    user.signature = (signature || '').trim().slice(0, 50);
    saveUsers(users);
    callback(null, { email: user.email, nickname: user.nickname, avatar: user.avatar, signature: user.signature, tags: user.tags || [] });
}

// 修改密码（校验旧密码，更新为新密码）
function changePassword(email, oldPassword, newPassword, callback) {
    const users = loadUsers();
    const user = users[email];
    if (!user) return callback('用户不存在');
    if (!bcrypt.compareSync(oldPassword, user.password)) return callback('原密码错误');
    if (!newPassword || newPassword.length < 6) return callback('新密码至少6位');
    user.password = bcrypt.hashSync(newPassword, 10);
    saveUsers(users);
    callback(null);
}

// ★ 后台管理：获取全部用户（不含密码哈希，避免泄露）
function getAllUsers() {
    const users = loadUsers();
    const list = [];
    for (const [email, u] of Object.entries(users)) {
        list.push({
            email: u.email,
            nickname: u.nickname,
            avatar: u.avatar,
            hasAvatar: !!u.avatar,
            role: (u.role === ROLE_ADMIN ? ROLE_ADMIN : ROLE_USER),
            createdAt: u.createdAt || ''
        });
    }
    list.sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''));
    return list;
}

// ★ 后台管理：删除用户
function adminDeleteUser(email) {
    const users = loadUsers();
    if (!users[email]) return '用户不存在';
    delete users[email];
    saveUsers(users);
    return null; // null = 成功
}

// ★ 后台管理：重置密码（清空为指定新密码）
function adminResetPassword(email, newPassword) {
    const users = loadUsers();
    if (!users[email]) return '用户不存在';
    if (!newPassword || newPassword.length < 6) return '新密码至少6位';
    users[email].password = bcrypt.hashSync(newPassword, 10);
    saveUsers(users);
    return null;
}

// ★ 模块加载时确保管理员账号存在
ensureAdminUser();

module.exports = {
    loadUsers,
    saveUsers,
    register,
    login,
    getUser,
    updateAvatar,
    updateNickname,
    updateSignature,
    updateTags,
    updateMarks,
    changePassword,
    resetPasswordByEmail,
    upload,
    isAllowedEmail,
    getAllUsers,
    adminDeleteUser,
    adminResetPassword,
    createSession,
    verifySession,
    revokeSession,
    purgeExpiredSessions,
    isAdminLogin
};