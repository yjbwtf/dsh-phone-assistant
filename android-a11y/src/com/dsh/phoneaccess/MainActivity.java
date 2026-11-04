package com.dsh.phoneaccess;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Color;
import android.os.Bundle;
import android.provider.Settings;
import android.text.InputType;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;

public class MainActivity extends Activity {
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setPadding(dp(24), dp(40), dp(24), dp(24));
        root.setBackgroundColor(Color.rgb(16, 18, 22));

        TextView title = new TextView(this);
        title.setText("DSH 无障碍助手");
        title.setTextColor(Color.WHITE);
        title.setTextSize(24);
        title.setGravity(Gravity.START);
        root.addView(title);

        TextView state = new TextView(this);
        state.setText("服务状态：" + (A11yService.instance == null ? "未启用" : "已连接"));
        state.setTextColor(A11yService.instance == null ? Color.rgb(255, 180, 80) : Color.rgb(80, 220, 150));
        state.setTextSize(15);
        state.setPadding(0, dp(12), 0, dp(16));
        root.addView(state);

        TextView body = new TextView(this);
        body.setText("用途：\n"
                + "• 读取当前屏幕的控件、文字与坐标\n"
                + "• 按文字/描述点击，或按坐标点击、滑动、长按\n"
                + "• 向输入框写入文字（支持中文）\n\n"
                + "电脑通过 ADB 连接本机 27183 端口。\n\n"
                + "启用方法：打开系统无障碍设置，找到“DSH 无障碍助手”并开启。");
        body.setTextColor(Color.rgb(210, 214, 222));
        body.setTextSize(14);
        body.setLineSpacing(0, 1.25f);
        body.setTextIsSelectable(true);
        root.addView(body);

        Button open = new Button(this);
        open.setText("打开无障碍设置");
        open.setAllCaps(false);
        open.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                startActivity(new Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS));
            }
        });
        LinearLayout.LayoutParams openParams = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, dp(52));
        openParams.topMargin = dp(24);
        root.addView(open, openParams);

        Button refresh = new Button(this);
        refresh.setText("刷新状态");
        refresh.setAllCaps(false);
        refresh.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                recreate();
            }
        });
        LinearLayout.LayoutParams refreshParams = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, dp(52));
        refreshParams.topMargin = dp(10);
        root.addView(refresh, refreshParams);

        setContentView(root);
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }
}
