package com.amnesia.client.model;

import com.google.gson.Gson;

/** 统一 Gson 实例 */
public final class AmnesiaGson {
    private static final Gson INSTANCE = new Gson();

    public static Gson gson() {
        return INSTANCE;
    }

    private AmnesiaGson() {}
}