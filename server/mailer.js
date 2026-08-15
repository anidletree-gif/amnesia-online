const nodemailer = require('nodemailer');
const config = require('./config');

const verificationCodes = new Map();
const sendCooldown = new Map(); // 冷却记录

const transporter = nodemailer.createTransport({
    host: 'smtp.qq.com',
    port: 465,
    secure: true,
    auth: {
        user: config.SMTP_USER,
        pass: config.SMTP_PASS
    }
});

function sendVerificationCode(toEmail) {
    // 检查冷却时间（60秒）
    const lastSend = sendCooldown.get(toEmail);
    if (lastSend && Date.now() - lastSend < 60000) {
        return null; // 被限制
    }

    const code = Math.floor(100000 + Math.random() * 900000).toString();

    const mailOptions = {
        from: `失忆症官方 <${config.SMTP_USER}>`,
        to: toEmail,
        subject: '【失忆症】你的注册验证码',
        html: `
            <div style="max-width:500px;margin:0 auto;padding:30px;background:#0c1210;color:#d4c9b8;border-radius:8px;">
                <h2 style="color:#b89a7a;">◈ 失忆症 · 档案激活 ◈</h2>
                <p style="font-size:16px;">你的注册验证码为：</p>
                <h1 style="color:#e3dbcd;text-align:center;letter-spacing:10px;font-size:36px;margin:20px 0;">${code}</h1>
                <p style="color:#a69b8a;">该验证码在5分钟内有效，请勿告知他人。</p>
                <hr style="border-color:#7a6a58;margin:20px 0;">
                <p style="color:#8b7a6b;font-size:12px;">如非本人操作，请忽略此邮件。</p>
            </div>
        `
    };

    transporter.sendMail(mailOptions, (err, info) => {
        if (err) console.error('邮件发送失败:', err);
    });

    verificationCodes.set(toEmail, { code, expires: Date.now() + 5 * 60 * 1000 });
    sendCooldown.set(toEmail, Date.now());
    return code;
}

function verifyCode(email, code) {
    const record = verificationCodes.get(email);
    if (!record) return false;
    if (Date.now() > record.expires) {
        verificationCodes.delete(email);
        return false;
    }
    return record.code === code;
}

module.exports = { sendVerificationCode, verifyCode };