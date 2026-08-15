package com.amnesia.client.net;

import android.content.Context;
import android.content.SharedPreferences;

/** 服务器地址工具：持久化 http 基址，并提供 ws 地址构造 */
public class AmnesiaServer {
    public static final String PREF = "amnesia_server";
    public static final String KEY = "server";
    public static final String DEFAULT = "http://192.168.2.13:3000";

    public static String get(Context ctx) {
        String s = ctx.getSharedPreferences(PREF, Context.MODE_PRIVATE).getString(KEY, null);
        return s == null || s.trim().isEmpty() ? DEFAULT : s.trim();
    }

    public static void save(Context ctx, String s) {
        ctx.getSharedPreferences(PREF, Context.MODE_PRIVATE)
                .edit().putString(KEY, normalize(s)).apply();
    }

    /** 规范化：补 http:// 前缀、去尾部斜杠 */
    public static String normalize(String s) {
        if (s == null) return DEFAULT;
        s = s.trim();
        if (s.isEmpty()) return DEFAULT;
        if (!s.startsWith("http://") && !s.startsWith("https://")) s = "http://" + s;
        while (s.endsWith("/")) s = s.substring(0, s.length() - 1);
        return s;
    }

    /** ws://host:port?playerId=<email>（服务器地址支持 http/https → ws/wss） */
    public static String wsUrl(Context ctx, String email) {
        String base = get(ctx);
        String ws = base.startsWith("https://") ? "wss://" : "ws://";
        ws += base.substring(base.indexOf("://") + 3);
        return ws + "?playerId=" + (email == null ? "" : email);
    }
}
