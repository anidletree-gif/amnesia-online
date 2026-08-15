package com.amnesia.client.model;

import android.content.Context;
import android.content.SharedPreferences;
import com.google.gson.Gson;

/** 当前登录用户，持久化于 SharedPreferences（对应 Web 版 localStorage 'amnesia_user'） */
public class User {
    public String email;
    public String nickname;
    public String avatar; // 头像文件名，完整 URL = serverBase + "/avatars/" + avatar

    private static final String PREF = "amnesia_user";
    private static final String KEY = "user_json";

    public static void save(Context ctx, User u) {
        ctx.getSharedPreferences(PREF, Context.MODE_PRIVATE)
                .edit().putString(KEY, new Gson().toJson(u)).apply();
    }

    public static User load(Context ctx) {
        String json = ctx.getSharedPreferences(PREF, Context.MODE_PRIVATE).getString(KEY, null);
        if (json == null) return null;
        try {
            return new Gson().fromJson(json, User.class);
        } catch (Exception e) {
            return null;
        }
    }

    public static void clear(Context ctx) {
        ctx.getSharedPreferences(PREF, Context.MODE_PRIVATE).edit().remove(KEY).apply();
    }

    /** 头像完整 URL。服务器 avatar 存的是带前导斜杠的 /avatars/xxx，此处剥离防重复拼接 */
    public String avatarUrl(String serverBase) {
        if (avatar == null || avatar.isEmpty()) return null;
        String base = serverBase;
        while (base.endsWith("/")) base = base.substring(0, base.length() - 1);
        String a = avatar;
        if (a.startsWith("http://") || a.startsWith("https://")) return a; // 已是完整 URL
        if (a.startsWith("/")) a = a.substring(1);
        if (a.startsWith("avatars/")) return base + "/" + a;
        return base + "/avatars/" + a;
    }
}
