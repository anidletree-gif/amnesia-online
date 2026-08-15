package com.amnesia.client.ui;

import android.app.Activity;
import android.app.AlertDialog;
import android.app.Dialog;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.text.SpannableString;
import android.text.SpannableStringBuilder;
import android.text.Spanned;
import android.text.TextUtils;
import android.text.style.ForegroundColorSpan;
import android.text.style.StyleSpan;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.view.inputmethod.EditorInfo;
import android.widget.Button;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.GridLayout;
import android.widget.HorizontalScrollView;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;

import com.amnesia.client.R;
import com.amnesia.client.model.AmnesiaGson;
import com.amnesia.client.model.ChatMessage;
import com.amnesia.client.model.FlipCard;
import com.amnesia.client.model.GameState;
import com.amnesia.client.model.PlayerInfo;
import com.amnesia.client.net.AmnesiaHttp;
import com.amnesia.client.net.AmnesiaServer;
import com.amnesia.client.net.AmnesiaWs;
import com.amnesia.client.util.BitmapUtil;
import com.amnesia.client.util.SoundManager;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;

import java.util.ArrayList;
import java.util.List;

/** 游戏主界面：房间等待 / 夜晚行动 / 白天发言 / 投票 / 结算 */
public class GameActivity extends Activity implements AmnesiaWs.Listener {

    /** 大厅转移的 WebSocket 连接 */
    public static AmnesiaWs incomingWs;

    // Views
    private TextView tvRoomInfo, tvPhaseInfo, tvStatus, tvMyCards, chatLog;
    private GridLayout playerGrid;
    private LinearLayout actionCard;
    private TextView tvActionTitle;
    private FrameLayout actionArea;
    private EditText inputChat;
    private Button btnSend, btnRules, btnLeave, btnStart;
    private ScrollView chatScroll;

    // 游戏状态
    private AmnesiaWs ws;
    private String roomId = "";
    private String preset = "";
    private int myNumber = 0;
    private boolean isHost = false;
    private boolean isSpectator = false;
    private boolean isDead = false;
    private String phase = "waiting"; // waiting | night | day | vote | gameover
    private int day = 0;
    private final List<PlayerInfo> players = new ArrayList<>();
    private final List<FlipCard> flipCards = new ArrayList<>();
    private int currentSpeaker = 0;
    private int speakRemaining = 0;
    private boolean canSpeak = false;
    private boolean hasVoted = false;
    private boolean nightSubmitted = false;
    private final List<String> myRecords = new ArrayList<>();

    private final Handler main = new Handler(Looper.getMainLooper());
    private Runnable speakTick;

    private static final int C_TEXT = 0xFFD4C9B8;
    private static final int C_SEC = 0xFFA69B8A;
    private static final int C_GOLD = 0xFFB89A7A;
    private static final int C_BLUE = 0xFF8ECAE6;
    private static final int C_RED = 0xFFE06060;
    private static final int C_GREEN = 0xFF5F7E6B;

    // ==================== 生命周期 ====================

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_game);

        tvRoomInfo = findViewById(R.id.tvRoomInfo);
        tvPhaseInfo = findViewById(R.id.tvPhaseInfo);
        tvStatus = findViewById(R.id.tvStatus);
        tvMyCards = findViewById(R.id.tvMyCards);
        chatLog = findViewById(R.id.chatLog);
        playerGrid = findViewById(R.id.playerGrid);
        actionArea = findViewById(R.id.actionArea);
        inputChat = findViewById(R.id.inputChat);
        btnSend = findViewById(R.id.btnSend);
        btnRules = findViewById(R.id.btnRules);
        btnLeave = findViewById(R.id.btnLeave);
        chatScroll = findViewById(R.id.chatScroll);
        btnStart = findViewById(R.id.btnStart);
        actionCard = findViewById(R.id.actionCard);
        tvActionTitle = findViewById(R.id.tvActionTitle);

        ws = incomingWs;
        incomingWs = null;
        if (ws == null) {
            toast("连接已失效，请重新进入房间");
            goLobby();
            return;
        }
        ws.setListener(this);

        roomId = getIntent().getStringExtra("roomId");
        preset = getIntent().getStringExtra("preset");
        myNumber = getIntent().getIntExtra("myNumber", 0);
        isHost = getIntent().getBooleanExtra("isHost", false);

        tvRoomInfo.setText("档案 " + roomId + (TextUtils.isEmpty(preset) ? "" : " · " + preset));

        btnSend.setOnClickListener(v -> { SoundManager.click(this); sendChat(); });
        inputChat.setOnEditorActionListener((v, actionId, event) -> {
            if (actionId == EditorInfo.IME_ACTION_SEND) { sendChat(); return true; }
            return false;
        });
        btnRules.setOnClickListener(v -> { SoundManager.click(this); showRules(); });
        btnLeave.setOnClickListener(v -> { SoundManager.click(this); confirmLeave(); });
        btnStart.setOnClickListener(v -> {
            SoundManager.click(this);
            if (ws != null) ws.startGame();
        });

        updateAll();
    }

    @Override
    protected void onDestroy() {
        super.onDestroy();
        if (speakTick != null) main.removeCallbacks(speakTick);
        if (ws != null) ws.setListener(null); // 防止回调已销毁页面
    }

    private void goLobby() {
        Intent it = new Intent(this, LobbyActivity.class);
        it.addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP);
        startActivity(it);
        finish();
    }

    // ==================== 消息分发 ====================

    @Override
    public void onConnected(String playerId) {
        tvStatus.setText("已连接");
    }

    @Override
    public void onMessage(String type, JsonObject data) {
        switch (type) {
            case "error":
                toast(data.has("message") ? data.get("message").getAsString() : "操作失败");
                break;

            case "player_list":
                players.clear();
                if (data.has("players") && data.get("players").isJsonArray()) {
                    for (JsonElement e : data.getAsJsonArray("players")) {
                        players.add(AmnesiaGson.gson().fromJson(e, PlayerInfo.class));
                    }
                }
                syncSelf();
                renderPlayers();
                updateActionArea();
                break;

            case "spectator_joined":
                isSpectator = true;
                if (data.has("roomId")) roomId = data.get("roomId").getAsString();
                if (data.has("preset")) preset = data.get("preset").getAsString();
                players.clear();
                if (data.has("players") && data.get("players").isJsonArray()) {
                    for (JsonElement e : data.getAsJsonArray("players")) {
                        players.add(AmnesiaGson.gson().fromJson(e, PlayerInfo.class));
                    }
                }
                tvRoomInfo.setText("档案 " + roomId + (TextUtils.isEmpty(preset) ? "" : " · " + preset));
                tvStatus.setText("👁️ 观战中");
                tvPhaseInfo.setText("观战中");
                renderPlayers();
                updateActionArea();
                break;

            case "game_in_progress":
                toast("游戏进行中，无法加入");
                break;

            case "game_started":
                addChatLog("🎲 档案激活", true);
                chatLog.setText("");
                addChatLog("🎲 档案激活", true);
                renderPlayers();
                break;

            case "phase":
                onPhase(data);
                break;

            case "your_turn":
                if (!isSpectator) {
                    nightSubmitted = false;
                    tvStatus.setText("🌙 你的回合 · 请行动");
                    showNightActions();
                }
                break;

            case "check_result": {
                String target = data.has("targetName") ? data.get("targetName").getAsString() : ("#" + data.get("targetNumber").getAsInt());
                String result = data.has("result") ? data.get("result").getAsString() : "";
                int d = data.has("day") ? data.get("day").getAsInt() : day;
                addChatLog("🔍 第" + d + "夜：查验 " + target + " 为 " + result, true);
                toast("🔍 " + result);
                break;
            }

            case "speak_start": {
                int speaker = data.has("speaker") ? data.get("speaker").getAsInt() : 0;
                int maxTime = data.has("maxTime") ? data.get("maxTime").getAsInt() : 120;
                if (currentSpeaker == speaker) {
                    speakRemaining = maxTime;
                    updateSpeakUI();
                } else {
                    currentSpeaker = speaker;
                    speakRemaining = maxTime;
                    canSpeak = (speaker == myNumber);
                    phase = "day";
                    updateAll();
                    startSpeakTicker();
                }
                break;
            }

            case "speak_end":
                stopSpeakTicker();
                currentSpeaker = 0;
                canSpeak = false;
                updateActionArea();
                updateStatus();
                break;

            case "vote_start":
                phase = "vote";
                hasVoted = false;
                updateAll();
                break;

            case "vote_timeout":
                if (data.has("message")) addChatLog(data.get("message").getAsString(), true);
                break;

            case "executed": {
                StringBuilder sb = new StringBuilder("投票结果：");
                if (data.has("tally") && data.get("tally").isJsonObject()) {
                    for (java.util.Map.Entry<String, JsonElement> en : data.getAsJsonObject("tally").entrySet()) {
                        sb.append(en.getKey()).append("号:").append(en.getValue().getAsInt()).append("票 ");
                    }
                }
                addChatLog(sb.toString(), true);
                if (data.has("name")) addChatLog("⚖️ " + data.get("name").getAsString() + " 被处决", true);
                break;
            }

            case "no_execution": {
                StringBuilder sb = new StringBuilder("投票结果：");
                if (data.has("tally") && data.get("tally").isJsonObject()) {
                    for (java.util.Map.Entry<String, JsonElement> en : data.getAsJsonObject("tally").entrySet()) {
                        sb.append(en.getKey()).append("号:").append(en.getValue().getAsInt()).append("票 ");
                    }
                }
                addChatLog(sb.toString(), true);
                addChatLog("⚖️ 今日无人被处决", true);
                break;
            }

            case "gameover":
                onGameOver(data);
                break;

            case "room_reset":
                phase = "waiting";
                day = 0;
                isDead = false;
                hasVoted = false;
                nightSubmitted = false;
                myRecords.clear();
                stopSpeakTicker();
                currentSpeaker = 0;
                canSpeak = false;
                chatLog.setText("");
                addChatLog("🔄 房间已重置", true);
                updateAll();
                break;

            case "chat": {
                String from = data.has("from") ? data.get("from").getAsString() : "";
                String msg = data.has("message") ? data.get("message").getAsString() : "";
                addChatLog(from + ": " + msg, isSystemMsg(from));
                break;
            }

            case "kicked":
                new AlertDialog.Builder(this)
                        .setTitle("提示")
                        .setMessage(data.has("message") ? data.get("message").getAsString() : "你已被移出房间")
                        .setCancelable(false)
                        .setPositiveButton("确定", (d, w) -> goLobby())
                        .show();
                break;

            case "room_dissolved": {
                // 房主离开，房间解散
                if (ws != null) { ws.close(); ws = null; }
                new AlertDialog.Builder(this)
                        .setTitle("房间解散")
                        .setMessage(data.has("message") ? data.get("message").getAsString() : "房主已离开，房间解散")
                        .setCancelable(false)
                        .setPositiveButton("返回大厅", (d, w) -> goLobby())
                        .show();
                break;
            }

            case "kicked_offline": {
                // 账号在其他设备登录：停止重连并回登录页
                String msg = data.has("message") ? data.get("message").getAsString() : "账号已在其他设备登录";
                if (ws != null) { ws.close(); ws = null; }
                new AlertDialog.Builder(this)
                        .setTitle("下线提醒")
                        .setMessage(msg)
                        .setCancelable(false)
                        .setPositiveButton("知道了", (d, w) -> {
                            Intent it = new Intent(this, LoginActivity.class);
                            it.addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP);
                            startActivity(it);
                            finish();
                        })
                        .show();
                break;
            }

            case "state_sync":
                onStateSync(data);
                break;

            default:
                // volume / signal / connected 等暂不处理（语音第三步）
                break;
        }
    }

    @Override
    public void onAudio(int speakerNumber, byte[] opus) {
        // 语音第三步：opus 解码播放
    }

    @Override
    public void onDisconnected(boolean willReconnect) {
        if (willReconnect) {
            tvStatus.setText("⚠️ 连接断开，自动重连中…");
        }
    }

    // ==================== 阶段处理 ====================

    private void onPhase(JsonObject data) {
        String p = data.has("phase") ? data.get("phase").getAsString() : "waiting";
        int d = data.has("day") ? data.get("day").getAsInt() : day;

        switch (p) {
            case "waiting":
                phase = "waiting";
                stopSpeakTicker();
                currentSpeaker = 0;
                canSpeak = false;
                break;
            case "night":
                phase = "night";
                day = d;
                nightSubmitted = false;
                stopSpeakTicker();
                currentSpeaker = 0;
                canSpeak = false;
                break;
            case "day":
                phase = "day";
                day = d;
                if (data.has("killedNames")) addChatLog("🌅 死者: " + data.get("killedNames").getAsString(), true);
                if (data.has("currentSpeaker") && !data.get("currentSpeaker").isJsonNull()
                        && data.get("currentSpeaker").getAsInt() > 0) {
                    currentSpeaker = data.get("currentSpeaker").getAsInt();
                    speakRemaining = data.has("speakRemaining") ? data.get("speakRemaining").getAsInt() : 120;
                    canSpeak = (currentSpeaker == myNumber);
                    startSpeakTicker();
                } else {
                    currentSpeaker = 0;
                    canSpeak = false;
                }
                break;
            case "vote":
                phase = "vote";
                day = d;
                hasVoted = false;
                stopSpeakTicker();
                currentSpeaker = 0;
                canSpeak = false;
                break;
            default:
                break;
        }
        updateAll();
    }

    private void onStateSync(JsonObject data) {
        GameState st = new GameState();
        st.parse(data);

        phase = st.phase;
        day = st.day;
        myNumber = st.myNumber;
        isHost = st.isHost;
        isDead = !st.alive;
        currentSpeaker = st.currentSpeaker;
        speakRemaining = st.speakRemaining;
        canSpeak = st.isMyTurn && "day".equals(st.phase);

        players.clear();
        players.addAll(st.players);
        flipCards.clear();
        flipCards.addAll(st.flipCards);

        // 自己的行动历史
        myRecords.clear();
        if (data.has("nightActions") && data.get("nightActions").isJsonArray()) {
            for (JsonElement e : data.getAsJsonArray("nightActions")) {
                JsonObject o = e.getAsJsonObject();
                String action = o.has("action") ? o.get("action").getAsString() : "";
                int target = o.has("target") ? o.get("target").getAsInt() : 0;
                String flip = o.has("flipCard") && !o.get("flipCard").isJsonNull()
                        ? o.get("flipCard").getAsString() : "";
                String rec = ("kill".equals(action) ? "🗡️ 暗杀 " : "🔍 查验 ") + target + "号"
                        + (TextUtils.isEmpty(flip) ? "" : " · 翻牌:" + flip);
                myRecords.add(rec);
            }
        }
        nightSubmitted = !myRecords.isEmpty();

        // 聊天历史
        chatLog.setText("");
        for (ChatMessage cm : st.chatHistory) {
            addChatLog(cm.from + ": " + cm.message, cm.isSystem());
        }

        updateAll();

        // 重连恢复行动/投票界面
        if ("night".equals(phase) && st.nightActive && st.isMyTurn && !nightSubmitted) {
            showNightActions();
        }
        if ("vote".equals(phase) && st.voteActive && !hasVoted) {
            showVoteOptions();
        }
        if ("day".equals(phase) && canSpeak) {
            startSpeakTicker();
        }
    }

    private void onGameOver(JsonObject data) {
        phase = "gameover";
        setActionCard(true);
        stopSpeakTicker();
        currentSpeaker = 0;
        canSpeak = false;
        updateAll();

        String winner = data.has("winner") ? data.get("winner").getAsString() : "未知阵营";
        List<PlayerInfo> roles = new ArrayList<>();
        if (data.has("roles") && data.get("roles").isJsonArray()) {
            for (JsonElement e : data.getAsJsonArray("roles")) {
                roles.add(AmnesiaGson.gson().fromJson(e, PlayerInfo.class));
            }
        }

        LinearLayout panel = new LinearLayout(this);
        panel.setOrientation(LinearLayout.VERTICAL);
        panel.setPadding(dp(12), dp(10), dp(12), dp(10));

        TextView tWin = new TextView(this);
        tWin.setText(winner + " 胜利");
        tWin.setTextColor(C_GOLD);
        tWin.setTextSize(18);
        tWin.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
        tWin.setGravity(Gravity.CENTER);
        panel.addView(tWin);

        TextView tRoles = new TextView(this);
        StringBuilder sb = new StringBuilder();
        java.util.Collections.sort(roles, (a, b) -> a.number - b.number);
        for (PlayerInfo r : roles) {
            sb.append(r.number).append("号 ").append(r.name).append(": ")
              .append(r.role == null ? "?" : r.role)
              .append(r.alive ? "" : " ☠️").append("\n");
        }
        tRoles.setText(sb.toString());
        tRoles.setTextColor(C_TEXT);
        tRoles.setTextSize(14);
        tRoles.setPadding(0, dp(10), 0, dp(4));
        panel.addView(tRoles);

        if (isHost) {
            Button btnReset = new Button(this);
            btnReset.setText(R.string.game_reset);
            btnReset.setBackgroundResource(R.drawable.memory_btn_selector);
            btnReset.setAllCaps(false);
            btnReset.setStateListAnimator(null);
            btnReset.setTextColor(C_TEXT);
            btnReset.setOnClickListener(v -> {
                if (ws != null) ws.resetRoom();
            });
            panel.addView(btnReset, new LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT, dp(46)));
        }

        actionArea.removeAllViews();
        actionArea.addView(panel, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
    }

    // ==================== 渲染 ====================

    private void updateAll() {
        renderPlayers();
        updateStatus();
        updateMyCards();
        updateStartButton();
        updateActionArea();
    }

    private void syncSelf() {
        for (PlayerInfo p : players) {
            if (p.number == myNumber) {
                isHost = p.isHost;
                isDead = !p.alive;
                break;
            }
        }
    }

    private void updateStatus() {
        String phaseText;
        switch (phase) {
            case "night": phaseText = "🌙 第" + day + "夜"; break;
            case "day": phaseText = "☀️ 第" + day + "天"; break;
            case "vote": phaseText = "🗳️ 投票阶段"; break;
            case "gameover": phaseText = "游戏结束"; break;
            default: phaseText = "等待开始"; break;
        }
        tvPhaseInfo.setText(phaseText);
        if (isSpectator) {
            tvStatus.setText("👁️ 观战中");
        } else if (phase.equals("waiting")) {
            if (isHost) {
                int need = preset != null && preset.contains("6") ? 6 : 8;
                int missing = need - players.size();
                tvStatus.setText(missing > 0
                        ? "还需 " + missing + " 名玩家（" + players.size() + "/" + need + "）"
                        : "玩家已就绪，可以开始");
            } else {
                tvStatus.setText("等待房主开始游戏…");
            }
        } else if (!"gameover".equals(phase)) {
            tvStatus.setText(phaseText + (isDead ? " · 你已死亡" : ""));
        }
    }

    private void updateMyCards() {
        StringBuilder sb = new StringBuilder();
        sb.append("你: ").append(myNumber).append("号 · ")
          .append(isDead ? "☠️ 已死亡" : "⚡ 存活")
          .append(isHost ? " · 👑 房主" : "");
        if (!myRecords.isEmpty()) {
            sb.append("\n行动记录:");
            for (String r : myRecords) sb.append("\n · ").append(r);
        }
        tvMyCards.setText(sb.toString());
    }

    /** 开始按钮：仅房主等待阶段可见，人数足够才可点击（对齐网页端 startGameBtn） */
    private void updateStartButton() {
        if (!isSpectator && phase.equals("waiting") && isHost) {
            int need = preset != null && preset.contains("6") ? 6 : 8;
            boolean ready = players.size() >= need;
            btnStart.setVisibility(View.VISIBLE);
            btnStart.setEnabled(ready);
            btnStart.setText(ready ? "✧建立档案" : "等待其他人员…");
        } else {
            btnStart.setVisibility(View.GONE);
        }
    }

    /** 行动卡标题（对齐网页端 actionCard 各阶段标题） */
    private void setActionTitle(String t) {
        if (tvActionTitle != null) tvActionTitle.setText(t);
    }

    /** 行动卡显隐（waiting 隐藏，夜晚/白天/投票/结算显示） */
    private void setActionCard(boolean show) {
        if (actionCard != null) {
            actionCard.setVisibility(show ? View.VISIBLE : View.GONE);
        }
    }

    /** 玩家徽章网格（3 列，对齐网页端 grid-cols-3） */
    private void renderPlayers() {
        playerGrid.removeAllViews();
        if (players.isEmpty()) return;

        for (PlayerInfo p : players) {
            playerGrid.addView(buildBadge(p));
        }
    }

    private View buildBadge(final PlayerInfo p) {
        LinearLayout badge = new LinearLayout(this);
        badge.setOrientation(LinearLayout.VERTICAL);
        badge.setGravity(Gravity.CENTER);
        badge.setPadding(dp(4), dp(6), dp(4), dp(6));

        GradientDrawable bg = new GradientDrawable();
        bg.setCornerRadii(new float[]{dp(2), dp(18), dp(2), dp(18), dp(2), dp(18), dp(2), dp(18)});
        if (p.number == myNumber) {
            bg.setColor(0xFF262420);
            bg.setStroke(dp(2), C_GOLD);
        } else if (!p.connected) {
            bg.setColor(0xFF2A2218);
            bg.setStroke(dp(1), 0xFFA07030);
        } else if (!p.alive) {
            bg.setColor(0xFF201C1C);
            bg.setStroke(dp(1), 0xFF604040);
        } else if (phase.equals("day") && currentSpeaker == p.number) {
            bg.setColor(0xFF1E2426);
            bg.setStroke(dp(2), C_BLUE);
        } else {
            bg.setColor(0xFF1E1C1A);
            bg.setStroke(dp(1), 0xFF3A352E);
        }
        badge.setBackground(bg);

        // 行1：圆形头像 + "X号 名字 👑" 横排居中（对齐网页端 player-badge 内层 flex 行）
        LinearLayout row1 = new LinearLayout(this);
        row1.setOrientation(LinearLayout.HORIZONTAL);
        row1.setGravity(Gravity.CENTER);

        ImageView tAvatar = new ImageView(this);
        int as = dp(28);
        LinearLayout.LayoutParams alp = new LinearLayout.LayoutParams(as, as);
        tAvatar.setLayoutParams(alp);
        tAvatar.setScaleType(ImageView.ScaleType.CENTER_CROP);
        tAvatar.setBackgroundResource(R.drawable.avatar_ring);
        row1.addView(tAvatar);
        loadPlayerAvatar(p, tAvatar);

        TextView tNoName = new TextView(this);
        tNoName.setText(p.number + "号 " + (p.name == null ? "?" : p.name)
                + (p.isHost ? " 👑" : ""));
        tNoName.setTextColor(p.number == myNumber ? C_GOLD : C_TEXT);
        tNoName.setTextSize(12);
        tNoName.setMaxLines(1);
        tNoName.setEllipsize(TextUtils.TruncateAt.END);
        LinearLayout.LayoutParams nlp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        nlp.leftMargin = dp(4);
        tNoName.setLayoutParams(nlp);
        row1.addView(tNoName);

        badge.addView(row1);

        // 音量条（对齐网页端 player-volume-bar，静态占位）
        View volBar = new View(this);
        GradientDrawable volBg = new GradientDrawable();
        volBg.setCornerRadius(dp(1));
        volBg.setColor(0xFF3A352E);
        volBar.setBackground(volBg);
        LinearLayout.LayoutParams vlp = new LinearLayout.LayoutParams(dp(44), dp(3));
        vlp.topMargin = dp(6);
        vlp.bottomMargin = dp(6);
        volBar.setLayoutParams(vlp);
        badge.addView(volBar);

        TextView tState = new TextView(this);
        String state;
        int stateColor;
        if (p.number == myNumber) { state = "⚡ 我"; stateColor = C_GOLD; }
        else if (p.isHost) { state = "👑 房主"; stateColor = C_GOLD; }
        else if (!p.connected) { state = "⚠️ 离线"; stateColor = 0xFFA07030; }
        else if (!p.alive) { state = "☠️ 死亡"; stateColor = 0xFF604040; }
        else if ("night".equals(phase) && p.hasActed) { state = "✓ 已行动"; stateColor = C_GREEN; }
        else if ("day".equals(phase) && currentSpeaker == p.number) { state = "🎙️ 发言中"; stateColor = C_BLUE; }
        else { state = "⚡"; stateColor = C_SEC; }
        tState.setText(state);
        tState.setTextColor(stateColor);
        tState.setTextSize(10);
        badge.addView(tState);

        // 3 列均分网格参数（对齐网页端 grid-cols-3）
        GridLayout.LayoutParams lp = new GridLayout.LayoutParams();
        lp.width = 0;
        lp.height = dp(104);
        lp.columnSpec = GridLayout.spec(GridLayout.UNDEFINED, 1f);
        lp.setMargins(dp(4), dp(4), dp(4), dp(4));
        badge.setLayoutParams(lp);

        // 等待阶段房主可踢人
        if (phase.equals("waiting") && isHost && p.number != myNumber) {
            badge.setOnClickListener(v -> {
                new AlertDialog.Builder(this)
                        .setTitle("踢出 " + p.number + "号 " + p.name)
                        .setMessage("确定将该玩家移出房间？")
                        .setPositiveButton("踢出", (d, wh) -> {
                            if (ws != null) ws.kick(p.number);
                        })
                        .setNegativeButton("取消", null)
                        .show();
            });
        }
        return badge;
    }

    /** 异步加载玩家头像并圆形显示（无头像时保持圆形占位） */
    private void loadPlayerAvatar(final PlayerInfo p, final ImageView iv) {
        String url = avatarUrl(p.avatar);
        if (url == null) return;
        AmnesiaHttp.loadImage(url, new AmnesiaHttp.ImageCb() {
            @Override public void onOk(Bitmap bmp) {
                iv.setImageBitmap(BitmapUtil.toCircle(bmp));
            }
            @Override public void onError(String msg) { /* 静默：保持占位圆形 */ }
        });
    }

    /** 服务器 avatar 路径 → 完整 URL（剥离前导斜杠防重复拼接） */
    private String avatarUrl(String avatar) {
        if (avatar == null || avatar.isEmpty()) return null;
        if (avatar.startsWith("http://") || avatar.startsWith("https://")) return avatar;
        String base = AmnesiaServer.get(this);
        String a = avatar.startsWith("/") ? avatar.substring(1) : avatar;
        return base + "/" + a;
    }

    // ==================== 行动面板 ====================

    private void updateActionArea() {
        actionArea.removeAllViews();
        if (isSpectator) {
            setActionCard(true);
            setActionTitle("👁️ 观战");
            addPanelText("👁️ 观战中 · 等待游戏开始");
            return;
        }
        switch (phase) {
            case "waiting":
                // 等待阶段：行动卡隐藏；开始按钮由 btnStart 常驻（updateStartButton 控制）
                setActionCard(false);
                break;
            case "night":
                setActionCard(true);
                setActionTitle("🌙 夜晚行动");
                addPanelText(nightSubmitted ? "✅ 已提交，等待夜晚结算…" : "🌙 夜幕降临…等待他人行动");
                break;
            case "day":
                setActionCard(true);
                setActionTitle("☀️ 白天发言");
                if (canSpeak && currentSpeaker == myNumber) {
                    updateSpeakUI();
                } else if (currentSpeaker != 0) {
                    addPanelText("☀️ " + currentSpeaker + "号 " + playerName(currentSpeaker) + " 正在发言…");
                } else {
                    addPanelText("☀️ 准备发言…");
                }
                break;
            case "vote":
                setActionCard(true);
                setActionTitle("🗳️ 投票处决");
                showVoteOptions();
                break;
            case "gameover":
                setActionTitle("🏁 档案结算");
                // 面板已在 onGameOver 构建
                break;
            default:
                break;
        }
    }

    private void addPanelText(String text) {
        TextView t = new TextView(this);
        t.setText(text);
        t.setTextColor(C_SEC);
        t.setTextSize(14);
        t.setGravity(Gravity.CENTER);
        t.setPadding(dp(8), dp(12), dp(8), dp(12));
        actionArea.addView(t, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
    }

    /** 白天发言面板：倒计时 + 结束发言 */
    private void updateSpeakUI() {
        if (!phase.equals("day") || !canSpeak || currentSpeaker != myNumber) return;
        actionArea.removeAllViews();
        LinearLayout row = new LinearLayout(this);
        row.setOrientation(LinearLayout.HORIZONTAL);
        row.setGravity(Gravity.CENTER_VERTICAL);

        TextView t = new TextView(this);
        t.setText("🎙️ 你的发言 · 剩余 " + Math.max(0, speakRemaining) + " 秒");
        t.setTextColor(C_BLUE);
        t.setTextSize(14);
        row.addView(t, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1));

        Button btnEnd = new Button(this);
        btnEnd.setText(R.string.game_speak);
        btnEnd.setBackgroundResource(R.drawable.memory_btn_selector);
        btnEnd.setAllCaps(false);
        btnEnd.setStateListAnimator(null);
        btnEnd.setTextColor(C_TEXT);
        btnEnd.setOnClickListener(v -> {
            SoundManager.click(this);
            if (ws != null) ws.endSpeak();
        });
        row.addView(btnEnd, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, dp(40)));

        actionArea.addView(row, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
    }

    private void startSpeakTicker() {
        stopSpeakTicker();
        speakTick = () -> {
            if (!phase.equals("day") || currentSpeaker == 0) return;
            speakRemaining--;
            if (speakRemaining <= 0) {
                stopSpeakTicker();
                if (canSpeak && ws != null) ws.endSpeak();
                currentSpeaker = 0;
                canSpeak = false;
                updateActionArea();
                updateStatus();
                return;
            }
            if (canSpeak && currentSpeaker == myNumber) updateSpeakUI();
            main.postDelayed(speakTick, 1000);
        };
        main.postDelayed(speakTick, 1000);
    }

    private void stopSpeakTicker() {
        if (speakTick != null) main.removeCallbacks(speakTick);
        speakTick = null;
    }

    /** 夜晚行动弹窗：暗杀/查验 → 目标 → 翻牌 → 提交 */
    private void showNightActions() {
        if (isDead) return;
        final Dialog dlg = new Dialog(this);
        dlg.requestWindowFeature(Window.FEATURE_NO_TITLE);
        dlg.setCancelable(false);

        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setPadding(dp(20), dp(16), dp(20), dp(16));

        TextView title = new TextView(this);
        title.setText("⚡ 你的回合 · 第" + day + "夜");
        title.setTextColor(C_GOLD);
        title.setTextSize(18);
        title.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
        title.setGravity(Gravity.CENTER);
        root.addView(title);

        // 行动类型选择
        LinearLayout actRow = new LinearLayout(this);
        actRow.setOrientation(LinearLayout.HORIZONTAL);
        actRow.setGravity(Gravity.CENTER);
        final Button btnKill = actionTypeButton("🗡️ 暗杀");
        final Button btnCheck = actionTypeButton("🔍 查验");
        actRow.addView(btnKill, new LinearLayout.LayoutParams(0, dp(56), 1));
        actRow.addView(btnCheck, new LinearLayout.LayoutParams(0, dp(56), 1));
        root.addView(actRow, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        // 目标区（选择行动后显示）
        final LinearLayout targetArea = new LinearLayout(this);
        targetArea.setOrientation(LinearLayout.VERTICAL);
        targetArea.setVisibility(View.GONE);
        final TextView tTargetTitle = new TextView(this);
        tTargetTitle.setText("👉 选择目标");
        tTargetTitle.setTextColor(C_TEXT);
        tTargetTitle.setTextSize(14);
        tTargetTitle.setPadding(0, dp(12), 0, dp(4));
        targetArea.addView(tTargetTitle);
        final GridLayout targetGrid = new GridLayout(this);
        targetGrid.setColumnCount(2);
        targetArea.addView(targetGrid);
        root.addView(targetArea);

        // 翻牌区
        TextView tFlipTitle = new TextView(this);
        tFlipTitle.setText("🃏 翻牌（可选）");
        tFlipTitle.setTextColor(C_TEXT);
        tFlipTitle.setTextSize(14);
        tFlipTitle.setPadding(0, dp(12), 0, dp(4));
        root.addView(tFlipTitle);

        HorizontalScrollView flipScroll = new HorizontalScrollView(this);
        flipScroll.setHorizontalScrollBarEnabled(false);
        LinearLayout flipRow = new LinearLayout(this);
        flipRow.setOrientation(LinearLayout.HORIZONTAL);
        flipScroll.addView(flipRow);
        root.addView(flipScroll, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        final Button submit = new Button(this);
        submit.setText("提 交");
        submit.setBackgroundResource(R.drawable.memory_btn_selector);
        submit.setAllCaps(false);
        submit.setStateListAnimator(null);
        submit.setTextColor(C_TEXT);
        submit.setEnabled(false);
        root.addView(submit, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, dp(46)));

        // 状态
        final String[] selAct = {null};
        final int[] selTarget = {-1};
        final String[] selFlip = {"__NONE__"}; // "__NONE__"=不翻牌 null=未选

        Runnable upd = () -> submit.setEnabled(selAct[0] != null && selTarget[0] > 0 && !selFlip[0].equals("__UNSET__"));

        btnKill.setOnClickListener(v -> {
            selAct[0] = "kill";
            btnKill.setSelected(true); btnCheck.setSelected(false);
            targetArea.setVisibility(View.VISIBLE);
            upd.run();
        });
        btnCheck.setOnClickListener(v -> {
            selAct[0] = "check";
            btnCheck.setSelected(true); btnKill.setSelected(false);
            targetArea.setVisibility(View.VISIBLE);
            upd.run();
        });

        // 目标：存活玩家（排除自己）
        for (PlayerInfo p : players) {
            if (!p.alive || p.number == myNumber) continue;
            final Button b = new Button(this);
            b.setText(p.number + "号 " + p.name);
            b.setBackgroundResource(R.drawable.player_badge_bg);
            b.setAllCaps(false);
            b.setStateListAnimator(null);
            b.setTextColor(C_TEXT);
            b.setTextSize(12);
            b.setPadding(dp(2), dp(4), dp(2), dp(4));
            b.setOnClickListener(v -> {
                selTarget[0] = p.number;
                for (int i = 0; i < targetGrid.getChildCount(); i++) {
                    targetGrid.getChildAt(i).setSelected(false);
                }
                b.setSelected(true);
                upd.run();
            });
            GridLayout.LayoutParams lp = new GridLayout.LayoutParams();
            lp.width = 0;
            lp.height = dp(40);
            lp.setMargins(dp(2), dp(2), dp(2), dp(2));
            targetGrid.addView(b, lp);
        }

        // 翻牌卡
        selFlip[0] = "__UNSET__";
        for (final FlipCard c : flipCards) {
            if (c == null || c.role == null) continue;
            final Button card = flipCardButton(c);
            card.setOnClickListener(v -> {
                selectFlip(flipRow, card);
                selFlip[0] = c.role;
                upd.run();
            });
            flipRow.addView(card);
        }
        final Button noneCard = flipCardButton("🚫", "不翻牌");
        noneCard.setOnClickListener(v -> {
            selectFlip(flipRow, noneCard);
            selFlip[0] = "__NONE__";
            upd.run();
        });
        flipRow.addView(noneCard);

        submit.setOnClickListener(v -> {
            if (selAct[0] == null || selTarget[0] <= 0 || selFlip[0].equals("__UNSET__")) return;
            String flip = selFlip[0].equals("__NONE__") ? null : selFlip[0];
            if (ws != null) ws.nightAction(selAct[0], selTarget[0], flip);
            nightSubmitted = true;
            dlg.dismiss();
            updateActionArea();
        });

        dlg.setContentView(root);
        if (dlg.getWindow() != null) {
            dlg.getWindow().setBackgroundDrawableResource(R.drawable.night_panel_bg);
        }
        dlg.show();
    }

    private Button actionTypeButton(String text) {
        Button b = new Button(this);
        b.setText(text);
        b.setBackgroundResource(R.drawable.memory_btn_selector);
        b.setAllCaps(false);
        b.setStateListAnimator(null);
        b.setTextColor(C_TEXT);
        b.setTextSize(14);
        return b;
    }

    private Button flipCardButton(FlipCard c) {
        String icon = iconOf(c.role);
        return flipCardButton(icon, c.name);
    }

    private Button flipCardButton(String icon, String name) {
        Button b = new Button(this);
        b.setText(icon + "\n" + name);
        b.setBackgroundResource(R.drawable.player_badge_bg);
        b.setAllCaps(false);
        b.setStateListAnimator(null);
        b.setTextColor(C_TEXT);
        b.setTextSize(11);
        b.setGravity(Gravity.CENTER);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(dp(72), dp(84));
        lp.setMargins(dp(4), 0, dp(4), 0);
        b.setLayoutParams(lp);
        return b;
    }

    private void selectFlip(LinearLayout row, Button selected) {
        for (int i = 0; i < row.getChildCount(); i++) {
            row.getChildAt(i).setSelected(false);
        }
        selected.setSelected(true);
    }

    private String iconOf(String role) {
        if (role == null) return "🃏";
        switch (role) {
            case "凶手": return "🗡️";
            case "虚构者": return "🎭";
            case "侦探": return "🔍";
            case "错构者": return "🧩";
            case "精神病": return "🎪";
            case "人格分裂": return "👥";
            default: return "🃏";
        }
    }

    /** 投票面板：存活玩家 + 弃权 */
    private void showVoteOptions() {
        if (hasVoted) {
            addPanelText("已投票");
            return;
        }
        LinearLayout panel = new LinearLayout(this);
        panel.setOrientation(LinearLayout.VERTICAL);

        TextView title = new TextView(this);
        title.setText("🗳️ 投票处决");
        title.setTextColor(C_GOLD);
        title.setTextSize(15);
        title.setGravity(Gravity.CENTER);
        title.setPadding(0, dp(4), 0, dp(6));
        panel.addView(title);

        LinearLayout grid = new LinearLayout(this);
        grid.setOrientation(LinearLayout.VERTICAL);
        panel.addView(grid);

        LinearLayout row = null;
        int idx = 0;
        for (final PlayerInfo p : players) {
            if (!p.alive) continue;
            if (idx % 2 == 0) {
                row = new LinearLayout(this);
                row.setOrientation(LinearLayout.HORIZONTAL);
                grid.addView(row);
            }
            Button b = new Button(this);
            b.setText(p.number + "号 " + p.name);
            b.setBackgroundResource(R.drawable.player_badge_bg);
            b.setAllCaps(false);
            b.setStateListAnimator(null);
            b.setTextColor(C_TEXT);
            b.setTextSize(12);
            b.setOnClickListener(v -> {
                if (ws != null) ws.vote(p.number);
                hasVoted = true;
                addPanelText("已投票");
            });
            row.addView(b, new LinearLayout.LayoutParams(0, dp(42), 1));
            idx++;
        }
        if (row == null || idx % 2 != 0) {
            // 补一行放弃权
            if (row == null) {
                row = new LinearLayout(this);
                row.setOrientation(LinearLayout.HORIZONTAL);
                grid.addView(row);
            }
        }
        Button abstain = new Button(this);
        abstain.setText("🚫 弃权");
        abstain.setBackgroundResource(R.drawable.memory_btn_danger_selector);
        abstain.setAllCaps(false);
        abstain.setStateListAnimator(null);
        abstain.setTextColor(0xFFECC0C0);
        abstain.setTextSize(12);
        abstain.setOnClickListener(v -> {
            if (ws != null) ws.vote(-1);
            hasVoted = true;
            addPanelText("已投票（弃权）");
        });
        // 弃权按钮单独一行占满
        grid.addView(abstain, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, dp(42)));

        actionArea.removeAllViews();
        actionArea.addView(panel, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
    }

    // ==================== 聊天 ====================

    private void sendChat() {
        String msg = inputChat.getText().toString().trim();
        if (TextUtils.isEmpty(msg)) return;
        boolean allowed = phase.equals("waiting") || phase.equals("gameover")
                || (phase.equals("day") && canSpeak) || isSpectator;
        if (!allowed) {
            toast("当前阶段不能发言");
            return;
        }
        if (ws != null) ws.chat(msg);
        inputChat.setText("");
    }

    private void addChatLog(String line, boolean system) {
        if (TextUtils.isEmpty(line)) return;
        SpannableStringBuilder sb = new SpannableStringBuilder(chatLog.getText());
        int start = sb.length();
        sb.append(line).append("\n");
        SpannableString sp = new SpannableString(sb.subSequence(start, sb.length()));
        // 重新构建：直接在 sb 上设置 span
        sb.setSpan(new ForegroundColorSpan(system ? C_BLUE : C_TEXT), start, start + line.length(),
                Spanned.SPAN_EXCLUSIVE_EXCLUSIVE);
        if (system) {
            sb.setSpan(new StyleSpan(Typeface.BOLD), start, start + line.length(),
                    Spanned.SPAN_EXCLUSIVE_EXCLUSIVE);
        }
        chatLog.setText(sb);
        chatScroll.post(() -> chatScroll.fullScroll(View.FOCUS_DOWN));
    }

    private boolean isSystemMsg(String from) {
        return from != null && (from.startsWith("系统") || from.startsWith("ℹ️") || from.startsWith("⚙️"));
    }

    // ==================== 规则 / 离开 ====================

    private void showRules() {
        String rules =
                "🌙 夜晚：所有玩家按号码顺序依次行动，必须选择【暗杀】或【查验】，并可选择翻开一张身份牌（可选）。被暗杀的玩家仍可执行自己的夜晚行动。天亮时统一公布死者名单，不公布死因和身份。\n\n" +
                "☀️ 白天：天亮公布死者后，存活玩家按号码顺序轮流发言（可撒谎），每人一轮。发言结束后匿名投票，票数最高者出局，不公布身份；平票则无人出局。\n\n" +
                "🏆 胜负：凶手阵营（凶手+虚构者）消灭所有好人阵营角色；好人阵营消灭所有凶手阵营角色；精神病或人格分裂存活至场上仅剩 2 人时单独胜利。\n\n" +
                "角色能力：\n" +
                "· 凶手：暗杀有效；查验固定「非凶手」；仅翻到凶手牌存活\n" +
                "· 虚构者：真凶存活时暗杀无效、翻任意牌死亡；真凶出局后觉醒，暗杀有效\n" +
                "· 侦探：查验真实结果\n" +
                "· 错构者：第一夜查验固定「非凶手」；此后若上一轮选暗杀则出「是凶手」\n" +
                "· 精神分裂：查验固定「是凶手」；翻任意牌立即死亡\n" +
                "· 精神病：翻任意牌都不会死；存活至 2 人时独赢\n" +
                "· 失忆者：查验固定「非凶手」；翻任意牌立即死亡\n" +
                "· 人格分裂：每晚随机复制一名存活角色的能力\n\n" +
                "💡 翻牌是高风险的身份验证：只有翻开自己真实身份对应的牌才能存活，否则天亮死亡；不翻牌是安全选项。";
        new AlertDialog.Builder(this)
                .setTitle("游戏规则")
                .setMessage(rules)
                .setPositiveButton("知道了", null)
                .show();
    }

    private void confirmLeave() {
        new AlertDialog.Builder(this)
                .setTitle("离开房间")
                .setMessage("确定离开当前房间？")
                .setPositiveButton("离开", (d, w) -> leaveRoom())
                .setNegativeButton("取消", null)
                .show();
    }

    private void leaveRoom() {
        stopSpeakTicker();
        if (ws != null) { ws.close(); ws = null; }
        goLobby();
    }

    // ==================== 工具 ====================

    private String playerName(int n) {
        for (PlayerInfo p : players) if (p.number == n) return p.name;
        return "#" + n;
    }

    private int dp(int v) {
        return Math.round(v * getResources().getDisplayMetrics().density);
    }

    private void toast(String msg) {
        Toast.makeText(this, msg, Toast.LENGTH_SHORT).show();
    }
}