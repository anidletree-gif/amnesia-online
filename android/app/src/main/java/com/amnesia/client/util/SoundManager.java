package com.amnesia.client.util;

import android.content.Context;
import android.media.AudioAttributes;
import android.media.SoundPool;

import com.amnesia.client.R;

/**
 * 全局 UI 点击音效（tic-toc-click）
 * 懒加载 SoundPool，随用随初始化；Activity onDestroy 时可调用 release()。
 */
public class SoundManager {
    private static SoundPool pool;
    private static int clickId = 0;
    private static boolean loaded = false;

    private SoundManager() {}

    public static synchronized void init(Context ctx) {
        if (pool != null) return;
        AudioAttributes attrs = new AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_GAME)
                .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                .build();
        pool = new SoundPool.Builder()
                .setMaxStreams(4)
                .setAudioAttributes(attrs)
                .build();
        pool.setOnLoadCompleteListener((sp, sampleId, status) -> {
            if (status == 0) loaded = true;
        });
        clickId = pool.load(ctx.getApplicationContext(), R.raw.tick_click, 1);
    }

    /** 播放点击音效（未初始化则自动初始化） */
    public static synchronized void click(Context ctx) {
        if (pool == null) init(ctx);
        if (loaded && clickId != 0 && pool != null) {
            pool.play(clickId, 0.8f, 0.8f, 1, 0, 1.0f);
        }
    }

    public static synchronized void release() {
        if (pool != null) {
            pool.release();
            pool = null;
            clickId = 0;
            loaded = false;
        }
    }
}
