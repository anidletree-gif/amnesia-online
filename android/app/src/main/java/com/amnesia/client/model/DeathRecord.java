package com.amnesia.client.model;

/** 死亡记录：state_sync 脱敏为 {number,name,day}；gameover 完整含 role/cause */
public class DeathRecord {
    public int number;
    public String name;
    public int day;
    public String role;   // 仅 gameover 完整版
    public String cause;  // 仅 gameover 完整版
}
