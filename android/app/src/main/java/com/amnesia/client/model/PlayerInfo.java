package com.amnesia.client.model;

/** 房间内单个玩家（player_list / state_sync.players / gameover.roles 共用字段） */
public class PlayerInfo {
    public int number;      // 座位号（1 起）
    public String name;
    public boolean alive;
    public boolean connected;
    public boolean isHost;
    public boolean hasActed; // 夜晚是否已行动（服务端防泄露，等待阶段恒为 false）
    public String role;      // 仅 gameover 时下发
    public String avatar;    // 头像路径（服务器下发 /avatars/xxx，可能为 null）

    public boolean isSpectator() {
        return name != null && name.startsWith("👁️ ");
    }
}
