/**
 * 生成随机房间号（6位大写字母数字）
 */
function generateRoomId() {
    return Math.random().toString(36).substring(2, 8).toUpperCase();
}

/**
 * 生成随机玩家ID
 */
function generatePlayerId() {
    return Math.random().toString(36).substring(2, 10);
}

/**
 * 检查邮箱是否允许注册
 */
function isAllowedEmail(email, allowedDomains) {
    const domain = email.split('@')[1]?.toLowerCase();
    return allowedDomains.includes(domain);
}

/**
 * 验证昵称格式（1-12位，不含特殊字符）
 */
function isValidNickname(nickname) {
    return /^[\u4e00-\u9fa5a-zA-Z0-9]{1,12}$/.test(nickname);
}

/**
 * 验证密码强度（至少6位）
 */
function isValidPassword(password) {
    return password && password.length >= 6;
}

/**
 * 简单日志输出（带时间戳）
 */
function log(level, message) {
    const timestamp = new Date().toISOString();
    const prefix = {
        info: '📘',
        warn: '⚠️',
        error: '❌',
        game: '🎮'
    }[level] || '📝';
    console.log(`${prefix} [${timestamp}] ${message}`);
}

/**
 * 安全JSON解析
 */
function safeJsonParse(str, fallback = null) {
    try {
        return JSON.parse(str);
    } catch(e) {
        return fallback;
    }
}

module.exports = {
    generateRoomId,
    generatePlayerId,
    isAllowedEmail,
    isValidNickname,
    isValidPassword,
    log,
    safeJsonParse
};