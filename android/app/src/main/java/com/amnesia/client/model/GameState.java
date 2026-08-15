package com.amnesia.client.model;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;

import java.util.ArrayList;
import java.util.List;

/** 客户端全量游戏状态，对应服务端 state_sync 消息 */
public class GameState {
    public String phase = "waiting";       // waiting | night | day | vote
    public int day = 0;
    public int myNumber = 0;
    public boolean isHost = false;
    public boolean alive = true;
    public boolean gameStarted = false;

    public List<PlayerInfo> players = new ArrayList<>();
    public List<FlipCard> flipCards = new ArrayList<>(); // 身份卡池（失忆者/精神分裂为空）
    public List<DeathRecord> deathRecords = new ArrayList<>();
    public List<ChatMessage> chatHistory = new ArrayList<>();

    public int currentSpeaker = 0;         // 0 = 无
    public int speakRemaining = 0;         // 发言剩余秒
    public boolean isMyTurn = false;       // 发言轮到我
    public boolean nightActive = false;    // 夜晚行动进行中（我等待行动）
    public boolean voteActive = false;     // 投票进行中
    public boolean isKill = false;         // 我的夜晚行动是暗杀还是查验（your_turn 附带）

    // 投票目标表：number -> 被投玩家号(-1 弃权)，仅服务端广播，用于显示
    public java.util.Map<Integer, Integer> votes = new java.util.LinkedHashMap<>();

    public void parse(JsonObject o) {
        if (o.has("phase")) phase = o.get("phase").getAsString();
        if (o.has("day")) day = o.get("day").getAsInt();
        if (o.has("myNumber")) myNumber = o.get("myNumber").getAsInt();
        if (o.has("isHost")) isHost = o.get("isHost").getAsBoolean();
        if (o.has("alive")) alive = o.get("alive").getAsBoolean();
        if (o.has("gameStarted")) gameStarted = o.get("gameStarted").getAsBoolean();
        if (o.has("currentSpeaker")) currentSpeaker = o.get("currentSpeaker").getAsInt();
        if (o.has("speakRemaining")) speakRemaining = o.get("speakRemaining").getAsInt();
        if (o.has("isMyTurn")) isMyTurn = o.get("isMyTurn").getAsBoolean();
        if (o.has("nightActive")) nightActive = o.get("nightActive").getAsBoolean();
        if (o.has("voteActive")) voteActive = o.get("voteActive").getAsBoolean();

        if (o.has("players") && o.get("players").isJsonArray()) {
            players = new ArrayList<>();
            for (JsonElement e : o.getAsJsonArray("players")) {
                players.add(AmnesiaGson.gson().fromJson(e, PlayerInfo.class));
            }
        }
        if (o.has("flipCards") && o.get("flipCards").isJsonArray()) {
            flipCards = new ArrayList<>();
            for (JsonElement e : o.getAsJsonArray("flipCards")) {
                flipCards.add(AmnesiaGson.gson().fromJson(e, FlipCard.class));
            }
        }
        if (o.has("deathRecords") && o.get("deathRecords").isJsonArray()) {
            deathRecords = new ArrayList<>();
            for (JsonElement e : o.getAsJsonArray("deathRecords")) {
                deathRecords.add(AmnesiaGson.gson().fromJson(e, DeathRecord.class));
            }
        }
        if (o.has("chatHistory") && o.get("chatHistory").isJsonArray()) {
            chatHistory = new ArrayList<>();
            for (JsonElement e : o.getAsJsonArray("chatHistory")) {
                chatHistory.add(AmnesiaGson.gson().fromJson(e, ChatMessage.class));
            }
        }
        if (o.has("votes") && o.get("votes").isJsonObject()) {
            votes = new java.util.LinkedHashMap<>();
            for (java.util.Map.Entry<String, JsonElement> en : o.getAsJsonObject("votes").entrySet()) {
                try {
                    votes.put(Integer.parseInt(en.getKey()), en.getValue().getAsInt());
                } catch (Exception ignored) {}
            }
        }
    }

    public PlayerInfo playerByNumber(int n) {
        for (PlayerInfo p : players) if (p.number == n) return p;
        return null;
    }

    public String playerName(int n) {
        PlayerInfo p = playerByNumber(n);
        return p != null ? p.name : ("#" + n);
    }

    /** 校验 JSON 字符串是否合法，供调试 */
    public static JsonObject parseJson(String s) {
        return JsonParser.parseString(s).getAsJsonObject();
    }
}