#!/usr/bin/env bash
# ============================================
#  失忆症Online · 一键启动脚本（本地/局域网开服）
#  用法: ./start.sh [端口]    默认端口 3000
#  例:   ./start.sh 8080
# ============================================
cd "$(dirname "$0")"
PORT="${1:-3000}"

echo "[1/4] 检查依赖..."
if [ ! -d node_modules ]; then
    npm install --no-audit --no-fund || { echo "❌ 依赖安装失败"; exit 1; }
else
    echo "    依赖已就绪"
fi

echo "[2/4] 语法自检..."
node --check server.js && node --check routes/ws.js && node --check core/game.js && node --check public/game.js || { echo "❌ 语法检查失败"; exit 1; }
echo "    ✅ 全部通过"

echo "[3/4] 启动服务器 (端口 ${PORT})..."
pkill -f 'node server.js' 2>/dev/null; sleep 0.5
PORT="$PORT" nohup node server.js > server.log 2>&1 &
sleep 1

echo "[4/4] 健康检查..."
if curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${PORT}/" | grep -q 200; then
    echo "    ✅ 服务器已启动 (PID: $!)"
else
    echo "    ⚠️ 启动异常，请查看 server.log"
fi

echo ""
echo "══════════ 访问地址 ══════════"
echo "本机:   http://localhost:${PORT}"
echo "局域网:"
hostname -I 2>/dev/null | tr ' ' '\n' | grep -E '^(192\.168|10\.|172\.(1[6-9]|2[0-9]|3[01]))' | while read ip; do
    echo "        http://${ip}:${PORT}"
done
echo "══════════════════════════════"
echo "手机/其他设备连同一Wi-Fi后，浏览器打开上面的局域网地址即可游玩"
echo "（语音测试页: http://<局域网IP>:${PORT}/rtctest.html）"
