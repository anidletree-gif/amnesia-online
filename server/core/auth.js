const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const config = require('../config');

const USERS_FILE = path.join(__dirname, '..', 'users.json');

// 加载用户数据库
function loadUsers() {
    try {
        if (fs.existsSync(USERS_FILE)) {
            return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
        }
    } catch(e) {
        console.error('加载用户数据失败:', e.message);
    }
    return {};
}

// 保存用户数据库
function saveUsers(users) {
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
        verified: true,
        createdAt: new Date().toISOString()
    };

    saveUsers(users);
    callback(null, { email, nickname, avatar: null });
}

// 登录
function login(email, password, callback) {
    const users = loadUsers();
    const user = users[email];

    if (!user) return callback('邮箱未注册');
    if (!bcrypt.compareSync(password, user.password)) return callback('密码错误');

    callback(null, {
        email: user.email,
        nickname: user.nickname,
        avatar: user.avatar
    });
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
    callback(null, { email: user.email, nickname: user.nickname, avatar: user.avatar });
}

module.exports = {
    loadUsers,
    saveUsers,
    register,
    login,
    updateAvatar,
    updateNickname,
    upload,
    isAllowedEmail
};