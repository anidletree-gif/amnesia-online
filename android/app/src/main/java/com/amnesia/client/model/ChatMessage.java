package com.amnesia.client.model;

/** 聊天消息（服务端 chat / state_sync.chatHistory 均为 {type,from,message}） */
public class ChatMessage {
    public String type;    // "chat"
    public String from;    // 发送者名，含系统消息
    public String message;

    public boolean isSystem() {
        return from != null && (from.startsWith("系统") || from.startsWith("ℹ️") || from.startsWith("⚙️"));
    }
}
