package com.amnesia.client.ui;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.graphics.Bitmap;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.text.InputFilter;
import android.text.TextUtils;
import android.view.View;
import android.widget.ArrayAdapter;
import android.widget.Button;
import android.widget.CheckBox;
import android.widget.EditText;
import android.widget.ImageView;
import android.widget.ListView;
import android.widget.RadioGroup;
import android.widget.TextView;
import android.widget.Toast;

import com.amnesia.client.R;
import com.amnesia.client.model.AmnesiaGson;
import com.amnesia.client.model.RoomInfo;
import com.amnesia.client.model.User;
import com.amnesia.client.net.AmnesiaHttp;
import com.amnesia.client.net.AmnesiaServer;
import com.amnesia.client.net.AmnesiaWs;
import com.amnesia.client.util.BitmapUtil;
import com.amnesia.client.util.SoundManager;
import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.List;

/** 大厅：创建房间 / 加入房间 / 公开房间列表 / 头像 / 改名 */
public class LobbyActivity extends Activity implements AmnesiaWs.Listener {

    private static final int REQ_PICK_AVATAR = 1001;

    private TextView tvUserNick, tvUserEmail, tvRoomEmpty;
    private ImageView imgAvatar;
    private EditText inputRoomId;
    private RadioGroup groupPreset;
    private CheckBox chkPublic;
    private Button btnCreateRoom, btnJoinRoom, btnLogout;
    private ListView listRooms;

    private User user;
    private AmnesiaWs ws;
    private String pendingAction; // "create" | "join"
    private String pendingRoomId;

    private final Handler main = new Handler(Looper.getMainLooper());
    private Runnable roomPollTask;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_lobby);

        tvUserNick = findViewById(R.id.tvUserNick);
        tvUserEmail = findViewById(R.id.tvUserEmail);
        tvRoomEmpty = findViewById(R.id.tvRoomEmpty);
        imgAvatar = findViewById(R.id.imgAvatar);
        inputRoomId = findViewById(R.id.inputRoomId);
        groupPreset = findViewById(R.id.groupPreset);
        chkPublic = findViewById(R.id.chkPublic);
        btnCreateRoom = findViewById(R.id.btnCreateRoom);
        btnJoinRoom = findViewById(R.id.btnJoinRoom);
        btnLogout = findViewById(R.id.btnLogout);
        listRooms = findViewById(R.id.listRooms);

        user = User.load(this);
        if (user == null) {
            // 未登录，回登录页
            startActivity(new Intent(this, LoginActivity.class));
            finish();
            return;
        }

        tvUserNick.setText(user.nickname != null ? user.nickname : "未命名");
        tvUserEmail.setText(user.email);
        loadAvatar();

        btnCreateRoom.setOnClickListener(v -> { SoundManager.click(this); onCreateRoom(); });
        btnJoinRoom.setOnClickListener(v -> { SoundManager.click(this); onJoinRoom(); });
        btnLogout.setOnClickListener(v -> { SoundManager.click(this); onLogout(); });
        imgAvatar.setOnClickListener(v -> { SoundManager.click(this); pickAvatar(); });
        findViewById(R.id.btnRenameNick).setOnClickListener(v -> { SoundManager.click(this); showRenameDialog(); });
        tvUserNick.setOnClickListener(v -> { SoundManager.click(this); showRenameDialog(); });
        listRooms.setOnItemClickListener((parent, view, position, id) -> {
            Object tag = listRooms.getTag();
            if (tag instanceof List) {
                List<?> list = (List<?>) tag;
                if (position >= 0 && position < list.size()) {
                    Object o = list.get(position);
                    if (o instanceof RoomInfo) joinById(((RoomInfo) o).id);
                }
            }
        });

        startRoomPolling();
    }

    // ============ 头像 ============

    /** 从服务器加载并显示当前用户头像（无头像时保持圆形占位） */
    private void loadAvatar() {
        String url = user != null ? user.avatarUrl(AmnesiaServer.get(this)) : null;
        if (url == null) {
            imgAvatar.setImageBitmap(null);
            return;
        }
        AmnesiaHttp.loadImage(url, new AmnesiaHttp.ImageCb() {
            @Override public void onOk(Bitmap bmp) {
                if (imgAvatar != null) imgAvatar.setImageBitmap(BitmapUtil.toCircle(bmp));
            }
            @Override public void onError(String msg) { /* 静默：保持占位圆形 */ }
        });
    }

    /** 系统图片选择器 */
    private void pickAvatar() {
        Intent i = new Intent(Intent.ACTION_GET_CONTENT);
        i.setType("image/*");
        startActivityForResult(i, REQ_PICK_AVATAR);
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == REQ_PICK_AVATAR && resultCode == RESULT_OK && data != null && data.getData() != null) {
            uploadAvatar(data.getData());
        }
    }

    /** 读取所选图片字节 → multipart 上传 → 更新本地用户与头像显示 */
    private void uploadAvatar(Uri uri) {
        try {
            InputStream in = getContentResolver().openInputStream(uri);
            if (in == null) { toast("无法读取所选图片"); return; }
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buf = new byte[8192];
            int n;
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
            in.close();
            byte[] bytes = out.toByteArray();
            if (bytes.length > 2 * 1024 * 1024) { toast("图片不能超过 2MB"); return; }

            String mime = getContentResolver().getType(uri);
            if (mime == null) mime = "image/jpeg";

            toast("上传中…");
            AmnesiaHttp.uploadAvatar(AmnesiaServer.get(this), user.email, bytes, mime, new AmnesiaHttp.Cb() {
                @Override public void onOk(JsonObject data) {
                    if (data.has("avatar")) {
                        user.avatar = data.get("avatar").getAsString();
                        User.save(LobbyActivity.this, user);
                        loadAvatar();
                        toast("头像已更新");
                    }
                }
                @Override public void onError(String msg) { toast(msg); }
            });
        } catch (Exception e) {
            toast("读取图片失败: " + e.getMessage());
        }
    }

    // ============ 改名字 ============

    private void showRenameDialog() {
        final EditText et = new EditText(this);
        et.setText(user.nickname == null ? "" : user.nickname);
        et.setHint("1-12位中文/字母/数字");
        et.setMaxLines(1);
        et.setFilters(new InputFilter[] { new InputFilter.LengthFilter(12) });
        et.setSelection(et.getText().length());
        new AlertDialog.Builder(this)
                .setTitle("修改昵称")
                .setView(et)
                .setPositiveButton("保存", (d, w) -> doRename(et.getText().toString().trim()))
                .setNegativeButton("取消", null)
                .show();
    }

    private void doRename(String nn) {
        if (nn.isEmpty() || !nn.matches("[\\u4e00-\\u9fa5a-zA-Z0-9]{1,12}")) {
            toast("昵称仅限中文/字母/数字，1-12位");
            return;
        }
        AmnesiaHttp.updateNickname(AmnesiaServer.get(this), user.email, nn, new AmnesiaHttp.Cb() {
            @Override public void onOk(JsonObject data) {
                user.nickname = data.has("nickname") ? data.get("nickname").getAsString() : nn;
                User.save(LobbyActivity.this, user);
                tvUserNick.setText(user.nickname);
                toast("昵称已更新");
            }
            @Override public void onError(String msg) { toast(msg); }
        });
    }

    // ============ 创建 / 加入 ============

    private void onCreateRoom() {
        // ★ 服务器 create 协议 name 字段 = 房主昵称（不是房间名，协议无房间名概念）
        String name = user != null && user.nickname != null ? user.nickname : "玩家";
        String preset = groupPreset.getCheckedRadioButtonId() == R.id.radioPreset6 ? "6人基础" : "8人进阶";
        boolean isPublic = chkPublic.isChecked();

        connectAndSend(() -> {
            if (ws != null) ws.createRoom(name, preset, isPublic);
        }, "create");
    }

    private void onJoinRoom() {
        String rid = inputRoomId.getText().toString().trim().toUpperCase();
        if (rid.length() != 6) {
            toast("请输入 6 位房间号");
            return;
        }
        connectAndSend(() -> {
            if (ws != null) ws.joinRoom(user.nickname, rid);
        }, "join");
    }

    private void joinById(String rid) {
        inputRoomId.setText(rid);
        connectAndSend(() -> {
            if (ws != null) ws.joinRoom(user.nickname, rid);
        }, "join");
    }

    private void connectAndSend(Runnable send, String action) {
        pendingAction = action;
        // 每次操作重建连接，保证干净状态
        if (ws != null) ws.close();
        ws = new AmnesiaWs();
        setBusy(true);
        ws.connect(AmnesiaServer.wsUrl(this, user.email), this);
        // 连接建立后 onConnected 中发送 pendingAction
        pendingSend = send;
    }

    private Runnable pendingSend;

    @Override
    public void onConnected(String playerId) {
        if (pendingSend != null) {
            Runnable r = pendingSend;
            pendingSend = null;
            r.run();
        }
    }

    @Override
    public void onMessage(String type, JsonObject data) {
        switch (type) {
            case "room_created":
            case "joined": {
                String roomId = data.has("roomId") ? data.get("roomId").getAsString() : "";
                String preset = data.has("preset") ? data.get("preset").getAsString() : "";
                int myNumber = data.has("yourNumber") ? data.get("yourNumber").getAsInt() : 1;
                boolean isHost = data.has("isHost") && data.get("isHost").getAsBoolean();
                setBusy(false);
                // 转移连接给游戏页
                GameActivity.incomingWs = ws;
                ws = null;
                Intent it = new Intent(this, GameActivity.class);
                it.putExtra("roomId", roomId);
                it.putExtra("preset", preset);
                it.putExtra("myNumber", myNumber);
                it.putExtra("isHost", isHost);
                startActivity(it);
                finish();
                break;
            }
            case "error": {
                setBusy(false);
                String msg = data.has("message") ? data.get("message").getAsString() : "操作失败";
                new AlertDialog.Builder(this)
                        .setTitle("提示").setMessage(msg)
                        .setPositiveButton("确定", null).show();
                break;
            }
            case "kicked_offline": {
                // 账号在其他设备登录，停止重连并回登录页
                String msg = data.has("message") ? data.get("message").getAsString() : "账号已在其他设备登录";
                if (ws != null) { ws.close(); ws = null; }
                new AlertDialog.Builder(this)
                        .setTitle("下线提醒")
                        .setMessage(msg)
                        .setCancelable(false)
                        .setPositiveButton("知道了", (d, w) -> {
                            startActivity(new Intent(this, LoginActivity.class));
                            finish();
                        })
                        .show();
                break;
            }
            default:
                break;
        }
    }

    @Override
    public void onAudio(int speakerNumber, byte[] opus) { /* 语音第三步 */ }

    @Override
    public void onDisconnected(boolean willReconnect) {
        if (willReconnect) {
            setBusy(false);
            if (pendingAction != null) {
                toast("连接断开，自动重连中…");
            }
        }
    }

    private void setBusy(boolean busy) {
        btnCreateRoom.setEnabled(!busy);
        btnJoinRoom.setEnabled(!busy);
        btnCreateRoom.setText(busy ? "连接中…" : getString(R.string.lobby_create));
        btnJoinRoom.setText(busy ? "连接中…" : getString(R.string.lobby_join));
    }

    // ============ 公开房间列表轮询 ============

    private void startRoomPolling() {
        pollRooms();
        roomPollTask = () -> {
            if (!isFinishing()) pollRooms();
            main.postDelayed(roomPollTask, 5000);
        };
        main.postDelayed(roomPollTask, 5000);
    }

    private void pollRooms() {
        AmnesiaHttp.rooms(AmnesiaServer.get(this), new AmnesiaHttp.Cb() {
            @Override public void onOk(JsonObject data) {
                List<RoomInfo> rooms = new ArrayList<>();
                if (data.has("rooms") && data.get("rooms").isJsonArray()) {
                    JsonArray arr = data.getAsJsonArray("rooms");
                    for (JsonElement e : arr) {
                        rooms.add(AmnesiaGson.gson().fromJson(e, RoomInfo.class));
                    }
                }
                renderRooms(rooms);
            }
            @Override public void onError(String msg) { /* 静默，下一轮重试 */ }
        });
    }

    private void renderRooms(List<RoomInfo> rooms) {
        tvRoomEmpty.setVisibility(rooms.isEmpty() ? View.VISIBLE : View.GONE);
        List<String> lines = new ArrayList<>();
        for (RoomInfo r : rooms) {
            lines.add(r.id + "  (" + r.players + "/" + r.max + ")  " + r.preset
                    + "  房主:" + (r.hostName == null ? "未知" : r.hostName));
        }
        ArrayAdapter<String> adapter = new ArrayAdapter<>(this,
                android.R.layout.simple_list_item_1, android.R.id.text1, lines);
        listRooms.setAdapter(adapter);
        listRooms.setTag(rooms);
    }

    // ============ 退出登录 ============

    private void onLogout() {
        new AlertDialog.Builder(this)
                .setTitle("退出登录")
                .setMessage("确定退出当前账号？")
                .setPositiveButton("退出", (d, w) -> {
                    User.clear(this);
                    if (ws != null) { ws.close(); ws = null; }
                    startActivity(new Intent(this, LoginActivity.class));
                    finish();
                })
                .setNegativeButton("取消", null)
                .show();
    }

    private void toast(String msg) {
        Toast.makeText(this, msg, Toast.LENGTH_SHORT).show();
    }

    @Override
    protected void onDestroy() {
        super.onDestroy();
        if (roomPollTask != null) main.removeCallbacks(roomPollTask);
        if (ws != null) { ws.close(); ws = null; }
    }
}