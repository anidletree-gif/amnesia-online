package com.amnesia.client.util;

import android.graphics.Bitmap;
import android.graphics.BitmapShader;
import android.graphics.Canvas;
import android.graphics.Paint;
import android.graphics.Shader;

/** 图片工具：圆形裁剪（用于圆形头像渲染） */
public class BitmapUtil {

    /** 将任意尺寸图片居中裁剪为圆形（带抗锯齿） */
    public static Bitmap toCircle(Bitmap src) {
        if (src == null) return null;
        int s = Math.min(src.getWidth(), src.getHeight());
        Bitmap out = Bitmap.createBitmap(s, s, Bitmap.Config.ARGB_8888);
        Canvas canvas = new Canvas(out);
        Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
        paint.setShader(new BitmapShader(src, Shader.TileMode.CLAMP, Shader.TileMode.CLAMP));
        canvas.drawCircle(s / 2f, s / 2f, s / 2f, paint);
        return out;
    }
}
