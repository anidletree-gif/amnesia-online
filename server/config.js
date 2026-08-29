module.exports = {
    // 服务器
    PORT: 3000,
    ALLOWED_HOST: null, // 公网域名白名单；null/留空则不限制（默认任意 Host 可访问）

    // 开放注册：true 时跳过邮箱验证码与域名白名单（本地/局域网开服免邮件，任意邮箱格式即可注册）
    OPEN_REGISTER: true,

    // SMTP 邮件（QQ邮箱）—— 部署时请替换为自己的邮箱与授权码
    SMTP_USER: 'your-mail@example.com',
    SMTP_PASS: 'your-smtp-auth-code',

    // 管理后台 —— 部署时请修改
    ADMIN_PASSWORD: 'change-me',

    // 允许注册的邮箱域名
    ALLOWED_DOMAINS: [
        'qq.com', '163.com', '126.com', 'gmail.com', 'outlook.com',
        'hotmail.com', 'sina.com', 'aliyun.com', 'foxmail.com', 'sohu.com', 'proton.me'
    ],

    // 头像
    AVATAR_MAX_SIZE: 2 * 1024 * 1024,
    AVATAR_DIR: 'public/avatars',

    // 超时
    ACTION_TIMEOUT: 600000,
    SPEAK_TIMEOUT: 180000,
    VOTE_TIMEOUT: 120000,
    HOST_DISCONNECT_TIMEOUT: 30000
};