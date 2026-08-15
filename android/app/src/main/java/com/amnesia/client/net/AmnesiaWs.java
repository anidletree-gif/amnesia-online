package com.amnesia.client.net;

import android.os.Handler;
import android.os.Looper;

import com.amnesia.client.model.AmnesiaGson;
import com.google.gson.JsonObject;

import java.util.concurrent.TimeUnit;

import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.WebSocket;
import okhttp3.WebSocketListener;
import okio.ByteString;

/**
 * WebSocket 封装：
 * - 连接 ws://host:3000?playerId=<email>
 * - 文本消息按 {type, ...} 分发（回调主线程）
 * - 二进制音频：前 4 字节大端发言人编号 + opus 数据
 * - 断线自动重连（指数退避 1s→2s→4s…封顶 10s）
 */
public class AmnesiaWs {
    public interface Listener {
        void onConnected(String playerId);
        void onMessage(String type, JsonObject data);
        void onAudio(int speakerNumber, byte[] opus);
        void onDisconnected(boolean willReconnect);
    }

    private static final int MAX_RETRY_DELAY_MS = 10_000;

    private final Handler main = new Handler(Looper.getMainLooper());
    private OkHttpClient client;
    private WebSocket ws;
    private String url;
    private Listener listener;
    private boolean closedByUser = false;
    private int retryDelay = 1_000;
    private Runnable reconnectTask;

    public AmnesiaWs() {
        client = new OkHttpClient.Builder()
                .connectTimeout(10, TimeUnit.SECONDS)
                .readTimeout(0, TimeUnit.MILLISECONDS)
                .pingInterval(20, TimeUnit.SECONDS)
                .build();
    }

    /** 切换监听器（如大厅 → 游戏页复用同一连接） */
    public void setListener(Listener l) {
        this.listener = l;
    }

    /** url 如 ws://192.168.2.13:3000?playerId=xxx@yyy */
    public void connect(String url, Listener l) {
        this.url = url;
        this.listener = l;
        this.closedByUser = false;
        doConnect();
    }

    private void doConnect() {
        if (closedByUser) return;
        Request req = new Request.Builder().url(url).build();
        ws = client.newWebSocket(req, new WebSocketListener() {
            @Override public void onOpen(WebSocket webSocket, Response response) {
                retryDelay = 1_000; // 重连成功，重置退避
                main.post(() -> {
                    if (listener != null) listener.onConnected(null);
                });
            }

            @Override public void onMessage(WebSocket webSocket, String text) {
                try {
                    JsonObject o = AmnesiaGson.gson().fromJson(text, JsonObject.class);
                    String type = o.has("type") ? o.get("type").getAsString() : "";
                    // ★ 被顶下线：立即停止自动重连，防止双端互相顶造成乒乓
                    if ("kicked_offline".equals(type)) {
                        closedByUser = true;
                        if (reconnectTask != null) main.removeCallbacks(reconnectTask);
                        reconnectTask = null;
                    }
                    JsonObject data = o.deepCopy();
                    data.remove("type");
                    main.post(() -> {
                        if (listener != null) listener.onMessage(type, data);
                    });
                } catch (Exception e) {
                    // 忽略无法解析的消息
                }
            }

            @Override public void onMessage(WebSocket webSocket, ByteString bytes) {
                byte[] raw = bytes.toByteArray();
                if (raw.length < 4) return;
                int speaker = ((raw[0] & 0xFF) << 24) | ((raw[1] & 0xFF) << 16)
                        | ((raw[2] & 0xFF) << 8) | (raw[3] & 0xFF);
                byte[] audio = new byte[raw.length - 4];
                System.arraycopy(raw, 4, audio, 0, audio.length);
                main.post(() -> {
                    if (listener != null) listener.onAudio(speaker, audio);
                });
            }

            @Override public void onClosed(WebSocket webSocket, int code, String reason) {
                scheduleReconnect();
            }

            @Override public void onFailure(WebSocket webSocket, Throwable t, Response response) {
                scheduleReconnect();
            }
        });
    }

    private void scheduleReconnect() {
        if (closedByUser) {
            main.post(() -> {
                if (listener != null) listener.onDisconnected(false);
            });
            return;
        }
        main.post(() -> {
            if (listener != null) listener.onDisconnected(true);
        });
        reconnectTask = () -> {
            reconnectTask = null;
            doConnect();
        };
        main.postDelayed(reconnectTask, retryDelay);
        retryDelay = Math.min(retryDelay * 2, MAX_RETRY_DELAY_MS);
    }

    /** 发送 JSON 消息 */
    public void send(JsonObject msg) {
        if (ws != null) ws.send(msg.toString());
    }

    /** 发送二进制（音频转发，前 4 字节大端编号） */
    public void sendAudio(int speakerNumber, byte[] opus) {
        if (ws == null || opus == null) return;
        byte[] buf = new byte[opus.length + 4];
        buf[0] = (byte) (speakerNumber >> 24);
        buf[1] = (byte) (speakerNumber >> 16);
        buf[2] = (byte) (speakerNumber >> 8);
        buf[3] = (byte) speakerNumber;
        System.arraycopy(opus, 0, buf, 4, opus.length);
        ws.send(ByteString.of(buf));
    }

    public void close() {
        closedByUser = true;
        if (reconnectTask != null) main.removeCallbacks(reconnectTask);
        if (ws != null) {
            ws.close(1000, "bye");
            ws = null;
        }
    }

    // ============ 协议消息快捷方法 ============

    public void createRoom(String name, String preset, boolean isPublic) {
        JsonObject m = new JsonObject();
        m.addProperty("type", "create");
        m.addProperty("name", name);
        m.addProperty("preset", preset);
        m.addProperty("isPublic", isPublic);
        send(m);
    }

    public void joinRoom(String name, String roomId) {
        JsonObject m = new JsonObject();
        m.addProperty("type", "join");
        m.addProperty("name", name);
        m.addProperty("roomId", roomId);
        send(m);
    }

    public void spectate(String roomId, String name) {
        JsonObject m = new JsonObject();
        m.addProperty("type", "spectate");
        m.addProperty("roomId", roomId);
        m.addProperty("name", name);
        send(m);
    }

    public void kick(int targetNumber) {
        JsonObject m = new JsonObject();
        m.addProperty("type", "kick");
        m.addProperty("target", targetNumber);
        send(m);
    }

    public void startGame() {
        JsonObject m = new JsonObject();
        m.addProperty("type", "start_game");
        send(m);
    }

    public void nightAction(String action, int targetNumber, String flipCard) {
        JsonObject m = new JsonObject();
        m.addProperty("type", "night_action");
        m.addProperty("action", action);
        m.addProperty("target", targetNumber);
        m.addProperty("flipCard", flipCard == null ? "" : flipCard);
        send(m);
    }

    public void endSpeak() {
        JsonObject m = new JsonObject();
        m.addProperty("type", "end_speak");
        send(m);
    }

    public void vote(int targetNumber) {
        JsonObject m = new JsonObject();
        m.addProperty("type", "vote");
        m.addProperty("target", targetNumber);
        send(m);
    }

    public void chat(String message) {
        JsonObject m = new JsonObject();
        m.addProperty("type", "chat");
        m.addProperty("message", message);
        send(m);
    }

    public void resetRoom() {
        JsonObject m = new JsonObject();
        m.addProperty("type", "reset_room");
        send(m);
    }

    public void volume(int number, int volume) {
        JsonObject m = new JsonObject();
        m.addProperty("type", "volume");
        m.addProperty("number", number);
        m.addProperty("volume", volume);
        send(m);
    }

    public void signal(int targetNumber, JsonObject signal) {
        JsonObject m = new JsonObject();
        m.addProperty("type", "signal");
        m.addProperty("targetNumber", targetNumber);
        m.add("signal", signal);
        send(m);
    }
}