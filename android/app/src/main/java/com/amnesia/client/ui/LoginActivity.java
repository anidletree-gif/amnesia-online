package com.amnesia.client.ui;

import android.app.Activity;
import android.content.Intent;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.text.TextUtils;
import android.view.View;
import android.view.inputmethod.EditorInfo;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;

import com.amnesia.client.R;
import com.amnesia.client.model.User;
import com.amnesia.client.net.AmnesiaHttp;
import com.amnesia.client.net.AmnesiaServer;
import com.amnesia.client.util.SoundManager;

/**
 * 登录 / 注册页。
 * 服务器模式自适应：进入注册模式时探测 /api/send-code——
 * 开放注册（返回"无需验证码"）→ 隐藏验证码区；验证码模式 → 显示验证码输入 + 60s 倒计时。
 */
public class LoginActivity extends Activity {

    private EditText inputServer, inputEmail, inputNickname, inputPassword, inputCode;
    private LinearLayout codeRow;
    private TextView loginError, btnSwitchMode, tvVersion;
    private Button btnLogin, btnSendCode;

    private boolean registerMode = false;
    /** true=开放注册无需验证码；false=需要验证码；null=尚未探测 */
    private Boolean openRegister = null;

    private final Handler handler = new Handler(Looper.getMainLooper());
    private int countdown = 0;
    private boolean probing = false;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_login);

        inputServer = findViewById(R.id.inputServer);
        inputEmail = findViewById(R.id.inputEmail);
        inputNickname = findViewById(R.id.inputNickname);
        inputPassword = findViewById(R.id.inputPassword);
        inputCode = findViewById(R.id.inputCode);
        codeRow = findViewById(R.id.codeRow);
        loginError = findViewById(R.id.loginError);
        btnSwitchMode = findViewById(R.id.btnSwitchMode);
        btnLogin = findViewById(R.id.btnLogin);
        btnSendCode = findViewById(R.id.btnSendCode);
        tvVersion = findViewById(R.id.tvVersion);

        // 已保存的服务器地址优先
        inputServer.setText(AmnesiaServer.get(this));

        // 已登录用户直接进入大厅
        if (User.load(this) != null) {
            startActivity(new Intent(this, LobbyActivity.class));
            finish();
            return;
        }

        btnLogin.setOnClickListener(v -> { SoundManager.click(this); doAuth(); });
        btnSwitchMode.setOnClickListener(v -> { SoundManager.click(this); toggleMode(); });
        btnSendCode.setOnClickListener(v -> { SoundManager.click(this); requestCode(); });

        inputPassword.setOnEditorActionListener((v, actionId, event) -> {
            if (actionId == EditorInfo.IME_ACTION_DONE) { doAuth(); return true; }
            return false;
        });
    }

    private void toggleMode() {
        registerMode = !registerMode;
        inputNickname.setVisibility(registerMode ? View.VISIBLE : View.GONE);
        btnLogin.setText(registerMode ? R.string.register_btn : R.string.login_btn);
        btnSwitchMode.setText(registerMode ? R.string.switch_to_login : R.string.switch_to_register);
        if (!registerMode) {
            // 切回登录：隐藏验证码区、停止倒计时
            codeRow.setVisibility(View.GONE);
            stopCountdown();
        } else {
            // 进入注册：探测服务器模式决定验证码区显隐
            probeServerMode();
        }
        hideError();
    }

    /** 探测服务器注册模式：开放注册 → 隐藏验证码；验证码模式 → 显示验证码区 */
    private void probeServerMode() {
        String server = AmnesiaServer.normalize(inputServer.getText().toString());
        String email = inputEmail.getText().toString().trim();
        if (probing) return;
        if (TextUtils.isEmpty(email)) {
            // 邮箱未填时暂不探测，保持隐藏，提交时若服务器要求验证码会给出提示
            openRegister = null;
            codeRow.setVisibility(View.GONE);
            return;
        }
        probing = true;
        AmnesiaHttp.sendCode(server, email, new AmnesiaHttp.Cb() {
            @Override public void onOk(com.google.gson.JsonObject data) {
                probing = false;
                String msg = data.has("message") ? data.get("message").getAsString() : "";
                if (msg.contains("无需验证码") || msg.contains("开放注册")) {
                    // 开放注册模式：隐藏验证码区
                    openRegister = Boolean.TRUE;
                    codeRow.setVisibility(View.GONE);
                    stopCountdown();
                } else {
                    // 验证码模式：显示验证码区
                    openRegister = Boolean.FALSE;
                    codeRow.setVisibility(View.VISIBLE);
                }
            }
            @Override public void onError(String msg) {
                probing = false;
                openRegister = null;
                codeRow.setVisibility(View.GONE);
                showError("无法连接服务器：" + msg);
            }
        });
    }

    /** 手动获取验证码（验证码模式下点击"发送验证码"） */
    private void requestCode() {
        String server = AmnesiaServer.normalize(inputServer.getText().toString());
        String email = inputEmail.getText().toString().trim();
        if (TextUtils.isEmpty(email)) { showError("请先填写邮箱"); return; }
        if (countdown > 0) return; // 冷却中
        AmnesiaHttp.sendCode(server, email, new AmnesiaHttp.Cb() {
            @Override public void onOk(com.google.gson.JsonObject data) {
                String msg = data.has("message") ? data.get("message").getAsString() : "";
                if (msg.contains("无需验证码") || msg.contains("开放注册")) {
                    openRegister = Boolean.TRUE;
                    codeRow.setVisibility(View.GONE);
                    Toast.makeText(LoginActivity.this, R.string.open_register_hint, Toast.LENGTH_SHORT).show();
                } else {
                    openRegister = Boolean.FALSE;
                    codeRow.setVisibility(View.VISIBLE);
                    Toast.makeText(LoginActivity.this, msg, Toast.LENGTH_SHORT).show();
                    startCountdown();
                }
            }
            @Override public void onError(String msg) {
                showError(msg);
            }
        });
    }

    /** 60s 发送冷却倒计时 */
    private void startCountdown() {
        countdown = 60;
        btnSendCode.setEnabled(false);
        handler.post(tick);
    }

    private void stopCountdown() {
        countdown = 0;
        btnSendCode.setEnabled(true);
        btnSendCode.setText(R.string.send_code);
        handler.removeCallbacks(tick);
    }

    private final Runnable tick = new Runnable() {
        @Override public void run() {
            if (countdown <= 0) {
                stopCountdown();
                return;
            }
            btnSendCode.setText(getString(R.string.resend_code, countdown));
            countdown--;
            handler.postDelayed(this, 1000);
        }
    };

    private void doAuth() {
        String server = AmnesiaServer.normalize(inputServer.getText().toString());
        String email = inputEmail.getText().toString().trim();
        String password = inputPassword.getText().toString();
        String nickname = inputNickname.getText().toString().trim();
        String code = inputCode.getText().toString().trim();

        if (!android.util.Patterns.EMAIL_ADDRESS.matcher(email).matches()) {
            showError("请输入有效的邮箱地址");
            return;
        }
        if (password.length() < 6) {
            showError("密码至少 6 位");
            return;
        }
        if (registerMode && TextUtils.isEmpty(nickname)) {
            showError("注册需要设置昵称");
            return;
        }

        AmnesiaServer.save(this, server);
        setBusy(true);
        hideError();

        AmnesiaHttp.Cb cb = new AmnesiaHttp.Cb() {
            @Override public void onOk(com.google.gson.JsonObject data) {
                setBusy(false);
                User u = AmnesiaHttp.parseUser(data);
                if (u != null) {
                    User.save(LoginActivity.this, u);
                    startActivity(new Intent(LoginActivity.this, LobbyActivity.class));
                    finish();
                } else {
                    showError("响应缺少用户信息");
                }
            }
            @Override public void onError(String msg) {
                setBusy(false);
                showError(msg);
            }
        };

        if (registerMode) {
            if (Boolean.FALSE.equals(openRegister) && TextUtils.isEmpty(code)) {
                // 服务器为验证码模式但未探测成功时，先探测再提交
                if (openRegister == null) { probeServerMode(); }
                setBusy(false);
                showError("请先获取并填写验证码");
                return;
            }
            // 开放注册（openRegister=true 或未探测到）→ code 传空由服务器决定
            AmnesiaHttp.register(server, email, nickname, password,
                    Boolean.FALSE.equals(openRegister) ? code : "", cb);
        } else {
            AmnesiaHttp.login(server, email, password, cb);
        }
    }

    private void setBusy(boolean busy) {
        btnLogin.setEnabled(!busy);
        btnLogin.setText(busy ? "请稍候…" : (registerMode ? getString(R.string.register_btn) : getString(R.string.login_btn)));
    }

    private void showError(String msg) {
        loginError.setText(msg);
        loginError.setVisibility(View.VISIBLE);
    }

    private void hideError() {
        loginError.setVisibility(View.GONE);
    }

    @Override
    protected void onDestroy() {
        handler.removeCallbacks(tick);
        super.onDestroy();
    }
}
