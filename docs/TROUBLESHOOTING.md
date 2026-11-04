# 故障排查

## 面板

### 启动提示缺少 WebView2

安装 Microsoft Edge WebView2 Runtime：

<https://developer.microsoft.com/microsoft-edge/webview2/>

安装后重启面板。

### 手机一直 offline / unauthorized

1. 换一根支持数据传输的 USB 线。
2. 手机开发者选项里撤销 USB 调试授权，再重新插线授权。
3. 检查：

   ```powershell
   & "$env:LOCALAPPDATA\Programs\DSH Phone Assistant\runtime\adb33\adb.exe" kill-server
   & "$env:LOCALAPPDATA\Programs\DSH Phone Assistant\runtime\adb33\adb.exe" devices
   ```

4. 不要同时运行其他会抢占 ADB 的工具（手机助手、QtScrcpy 等）。

### 面板能连手机，但画面黑屏

- 先看 `panel-data\panel.log` 是否有 `native mirror` 或 `scrcpy` 错误。
- 关闭其他 scrcpy/投屏窗口后重启面板。
- 在设置里确认 scrcpy 路径指向 `runtime\scrcpy-2.7\scrcpy.exe`。
- 原生解码失败会自动回退 SDL；如果都失败，用「截屏」按钮先确认 ADB 截图正常。

### 鼠标拖动粘住

已加两层兜底：canvas 全局 pointerup 和 C# 鼠标按键看门狗。仍有问题时：

- 切到其他页签再切回，会强制发 `up`；
- 重启面板；
- 确认鼠标不是在远程桌面/虚拟机捕获模式里。

### 控制台端口被占用

关闭旧面板或旧 DSH 进程；或改设置里的 `httpPort`。默认 `18642`。

## 插件

### 装完没有「手机助手」

- 必须重启 DSH，不是只刷新页面。
- 确认 profile 正确：`dsh plugin --profile <profile> add ...`
- 看 DSH 日志/插件管理器是否报版本或依赖错误。

### `dsh` 不是命令

用完整路径：

```powershell
& "C:\Program Files\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd" plugin --profile web add ...
```

### 微信消息不触发

- 面板「微信桥」是否开启监听。
- 目标聊天名是否和微信界面完全一致。
- 发送者是否在管理员列表。
- 群聊是否开启“只响应 @ 我”。
- 手机是否在微信聊天页/桌面；通知是否被系统屏蔽。

### 发错聊天/拒绝发送

发送前会 OCR 校验标题。出现“标题校验失败”说明当前页面和目标不一致，这是保护，不是 bug：

1. 回到微信聊天列表；
2. 确认目标聊天名称；
3. 重新发送；
4. 如果经常误判，检查是否使用了免打扰/折叠聊天或改了备注。

不要为了“能发出去”关闭校验。

## Android

### 无障碍服务反复断开

- 华为/荣耀需要在电池优化里允许后台运行。
- 重新打开无障碍服务开关。
- 面板控制台会尝试恢复；仍失败时重启手机和无障碍服务。

### 中文输入失败

- 确认 ADBKeyboard 已安装并启用：

  ```powershell
  adb shell ime list -s
  adb shell ime enable com.android.adbkeyboard/.AdbIME
  adb shell ime set com.android.adbkeyboard/.AdbIME
  ```

- 发送后恢复原输入法；如果没恢复，在面板设置里打开“发送后恢复输入法”。

## 日志与隐私

- 面板：`panel-data\panel.log`
- DSH：DSH 自己的日志
- 截图：`panel-data\screenshots`

日志和截图可能包含聊天内容。发 issue 前请打码/删除隐私信息，不要上传 `settings.json` 或任何 API Key。
