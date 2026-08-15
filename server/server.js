const http = require('http');
const WebSocket = require('ws');
const config = require('./config');
const { handleHttp } = require('./routes/http');
const { handleWs } = require('./routes/ws');

const server = http.createServer(handleHttp);
const wss = new WebSocket.Server({ server });

wss.on('connection', handleWs);

// ★ 支持环境变量覆盖端口（一键启动脚本 ./start.sh 8080 用）
const PORT = process.env.PORT || config.PORT;

server.listen(PORT, () => {
    console.log(`✅ 失忆症运行在 ${PORT}`);
});