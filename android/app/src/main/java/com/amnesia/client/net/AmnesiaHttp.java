package com.amnesia.client.net;

import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.os.Handler;
import android.os.Looper;

import com.amnesia.client.model.AmnesiaGson;
import com.amnesia.client.model.RoomInfo;
import com.amnesia.client.model.User;
import com.google.gson.JsonObject;

import java.io.IOException;
import java.util.List;
import java.util.concurrent.TimeUnit;

import okhttp3.Call;
import okhttp3.Callback;
import okhttp3.MediaType;
import okhttp3.MultipartBody;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;

/** HTTP API 封装：注册 / 登录 / 改名 / 头像上传 / 公开房间列表 / 图片下载 */
public class AmnesiaHttp {
    public static final MediaType JSON = MediaType.get("application/json; charset=utf-8");

    private static OkHttpClient client = new OkHttpClient.Builder()
            .connectTimeout(10, TimeUnit.SECONDS)
            .readTimeout(10, TimeUnit.SECONDS)
            .build();

    public interface Cb {
        void onOk(JsonObject data);
        void onError(String msg);
    }

    /** 图片下载回调（主线程） */
    public interface ImageCb {
        void onOk(Bitmap bmp);
        void onError(String msg);
    }

    private static final Handler MAIN = new Handler(Looper.getMainLooper());

    /** 统一回调到主线程 */
    private static Callback wrap(Cb cb) {
        return new Callback() {
            @Override public void onFailure(Call call, IOException e) {
                MAIN.post(() -> cb.onError("网络错误: " + e.getMessage()));
            }
            @Override public void onResponse(Call call, Response resp) {
                try {
                    String body = resp.body() != null ? resp.body().string() : "";
                    JsonObject o = AmnesiaGson.gson().fromJson(body, JsonObject.class);
                    MAIN.post(() -> {
                        if (o != null && o.has("error")) {
                            cb.onError(o.get("error").getAsString());
                        } else {
                            cb.onOk(o);
                        }
                    });
                } catch (Exception e) {
                    MAIN.post(() -> cb.onError("响应解析失败: " + e.getMessage()));
                }
            }
        };
    }

    /** POST /api/register {email,nickname,password,code} → {email,nickname,avatar} */
    public static void register(String base, String email, String nickname, String password, String code, Cb cb) {
        JsonObject body = new JsonObject();
        body.addProperty("email", email);
        body.addProperty("nickname", nickname);
        body.addProperty("password", password);
        body.addProperty("code", code == null ? "" : code);
        post(base + "/api/register", body, cb);
    }

    /** POST /api/send-code {email} → {message}（开放注册模式返回"无需验证码"，可据此探测服务器模式） */
    public static void sendCode(String base, String email, Cb cb) {
        JsonObject body = new JsonObject();
        body.addProperty("email", email);
        post(base + "/api/send-code", body, cb);
    }

    /** POST /api/login {email,password} → {email,nickname,avatar} */
    public static void login(String base, String email, String password, Cb cb) {
        JsonObject body = new JsonObject();
        body.addProperty("email", email);
        body.addProperty("password", password);
        post(base + "/api/login", body, cb);
    }

    /** GET /rooms → [{id,players,max,preset,hostName}] */
    public static void rooms(String base, Cb cb) {
        Request req = new Request.Builder().url(base + "/rooms").get().build();
        client.newCall(req).enqueue(new Callback() {
            @Override public void onFailure(Call call, IOException e) {
                MAIN.post(() -> cb.onError("网络错误: " + e.getMessage()));
            }
            @Override public void onResponse(Call call, Response resp) {
                try {
                    String body = resp.body() != null ? resp.body().string() : "[]";
                    List<RoomInfo> list = AmnesiaGson.gson().fromJson(body,
                            new com.google.gson.reflect.TypeToken<List<RoomInfo>>() {}.getType());
                    MAIN.post(() -> {
                        JsonObject o = new JsonObject();
                        o.add("rooms", AmnesiaGson.gson().toJsonTree(list));
                        cb.onOk(o);
                    });
                } catch (Exception e) {
                    MAIN.post(() -> cb.onError("响应解析失败: " + e.getMessage()));
                }
            }
        });
    }

    /** POST /api/update-nickname {email,nickname} → {email,nickname,avatar} */
    public static void updateNickname(String base, String email, String nickname, Cb cb) {
        JsonObject body = new JsonObject();
        body.addProperty("email", email);
        body.addProperty("nickname", nickname);
        post(base + "/api/update-nickname", body, cb);
    }

    /** POST /api/upload-avatar multipart(email + avatar 文件) → 完整 user 对象 */
    public static void uploadAvatar(String base, String email, byte[] imageBytes, String mime, Cb cb) {
        String ext;
        if (mime != null && mime.contains("png")) ext = "png";
        else if (mime != null && mime.contains("gif")) ext = "gif";
        else if (mime != null && mime.contains("webp")) ext = "webp";
        else ext = "jpg";
        MultipartBody body = new MultipartBody.Builder()
                .setType(MultipartBody.FORM)
                .addFormDataPart("email", email == null ? "" : email)
                .addFormDataPart("avatar", "avatar." + ext,
                        RequestBody.create(MediaType.parse(mime == null ? "image/jpeg" : mime), imageBytes))
                .build();
        Request req = new Request.Builder()
                .url(base + "/api/upload-avatar")
                .post(body)
                .build();
        client.newCall(req).enqueue(wrap(cb));
    }

    /** GET 图片 → Bitmap（用于头像渲染，回调在主线程） */
    public static void loadImage(String url, ImageCb cb) {
        Request req = new Request.Builder().url(url).get().build();
        client.newCall(req).enqueue(new Callback() {
            @Override public void onFailure(Call call, IOException e) {
                MAIN.post(() -> cb.onError("图片加载失败: " + e.getMessage()));
            }
            @Override public void onResponse(Call call, Response resp) {
                try {
                    byte[] bytes = resp.body() != null ? resp.body().bytes() : null;
                    if (bytes == null || bytes.length == 0) {
                        MAIN.post(() -> cb.onError("图片内容为空"));
                        return;
                    }
                    Bitmap bmp = BitmapFactory.decodeByteArray(bytes, 0, bytes.length);
                    MAIN.post(() -> {
                        if (bmp != null) cb.onOk(bmp);
                        else cb.onError("图片解码失败");
                    });
                } catch (Exception e) {
                    MAIN.post(() -> cb.onError("图片加载失败: " + e.getMessage()));
                }
            }
        });
    }

    private static void post(String url, JsonObject body, Cb cb) {
        Request req = new Request.Builder()
                .url(url)
                .post(RequestBody.create(JSON, body.toString()))
                .build();
        client.newCall(req).enqueue(wrap(cb));
    }

    public static String toUser(JsonObject o) {
        if (o == null || !o.has("email")) return null;
        return o.toString();
    }

    public static User parseUser(JsonObject o) {
        return AmnesiaGson.gson().fromJson(o, User.class);
    }
}