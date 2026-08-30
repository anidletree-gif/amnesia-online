const http = require('http');
const WebSocket = require('ws');
const config = require('./config');
const { handleHttp } = require('./routes/http');
const { handleWs } = require('./routes/ws');
const auth = require('./core/auth');

const server = http.createServer(handleHttp);
const wss = new WebSocket.Server({ server });

wss.on('connection', handleWs);

// ★ 会话过期清理：每6小时清理一次 sessions.json，防止文件无限膨胀
try { auth.purgeExpiredSessions(); } catch(_) {}
setInterval(() => { try { auth.purgeExpiredSessions(); } catch(_) {} }, 6 * 3600 * 1000);

// ★ 心跳保活：每30秒 ping 一次，连续2个周期无响应则强制断开
//   防止断网/死机客户端占着连接不释放，避免连接数无限增长
const HEARTBEAT_INTERVAL = 30000;
const heartbeatTimer = setInterval(() => {
    wss.clients.forEach(ws => {
        if (ws.isAlive === false) {
            ws.terminate();
            return;
        }
        ws.isAlive = false;
        try { ws.ping(); } catch (_) {}
    });
}, HEARTBEAT_INTERVAL);

wss.on('close', () => clearInterval(heartbeatTimer));

// ★ 支持环境变量覆盖端口（一键启动脚本 ./start.sh 8080 用）
const PORT = process.env.PORT || config.PORT;

server.listen(PORT, () => {
    console.log(`✅ 失忆症运行在 ${PORT}`);
});