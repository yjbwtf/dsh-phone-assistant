# 面板安装

## 系统要求

- Windows 10 1903+ / Windows 11，x64
- Microsoft Edge WebView2 Runtime
- Android 10+（Android 9 可能可用，未完整测试）
- 手机支持 USB 调试
- 一条能传数据的 USB 线

面板安装包是 **self-contained** 的，自带 .NET 9 运行时；不需要单独安装 .NET Desktop Runtime。

WebView2 Runtime 不捆绑。Windows 11 通常自带；Windows 10 如果缺失，从 Microsoft 官网安装：

<https://developer.microsoft.com/microsoft-edge/webview2/>

面板启动时如果缺少 WebView2 会直接报错；安装器不会自动下载。

## 安装

1. 从 Release 下载 `DSH-Phone-Assistant-Setup-0.1.0.exe`。
2. 可选：用 `SHA256SUMS.txt` 校验：

   ```powershell
   Get-FileHash .\DSH-Phone-Assistant-Setup-0.1.0.exe -Algorithm SHA256
   ```

3. 双击安装。安装器默认装到：

   ```text
   %LOCALAPPDATA%\Programs\DSH Phone Assistant
   ```

   不请求管理员权限。
4. 安装完成后勾选启动，或从开始菜单打开「DSH 手机助手」。

> 安装包目前没有商业代码签名证书，Windows SmartScreen 可能提示“未知发布者”。请确认哈希与 Release 一致后再运行。

## 手机准备

1. 设置 → 关于手机 → 连续点击版本号，开启开发者选项。
2. 开发者选项 → 打开 **USB 调试**。
3. USB 连接电脑，手机弹出“允许 USB 调试吗？”时勾选“始终允许”并确定。
4. 在电脑上验证：

   ```powershell
   & "$env:LOCALAPPDATA\Programs\DSH Phone Assistant\runtime\adb33\adb.exe" devices
   ```

   应看到设备状态为 `device`，不是 `unauthorized` 或 `offline`。

5. 面板启动后，在「控制台」点「修复连接」；状态显示手机已连接即可。
6. 首次使用无障碍/输入法时，按面板提示在手机上启用：
   - `DSH 无障碍助手`
   - `ADBKeyboard` 输入法

## 首次配置

打开面板「设置」：

- ADB 路径：默认使用安装目录下的 `runtime\adb33\adb.exe`。
- scrcpy 路径：默认使用 `runtime\scrcpy-2.7\scrcpy.exe`。
- 数据目录：默认在安装目录的 `panel-data`；只对本机可读。

打开「微信桥」：

1. 添加管理员微信号。
2. 添加目标聊天（私聊或群）。
3. 需要群消息时打开“只响应 @ 我”。
4. 打开“自动监听新消息并交给 Agent”。

> 目标聊天必须与手机上的显示名一致。发送前会截图 OCR 校验标题；校验失败会拒绝发送，不会赌当前页面。

## 卸载

从开始菜单运行「卸载 DSH 手机助手」，或运行安装目录下的：

```text
unins000.exe
```

安装器为了兼容受限注册表环境，没有写入“应用和功能”列表，所以 Windows 设置里可能看不到它；开始菜单卸载快捷方式仍然可用。

卸载会移除程序文件；`panel-data` 中的设置、截图和日志可能保留，确认不需要后再手动删除。

## 数据与隐私

- 面板只监听 `127.0.0.1:18642`，不要做端口映射到公网。
- 截图、日志和设置都在本机；不要提交到 Git。
- API Key 只保存在本机设置文件，安装包不包含 Key。
- 日志可能包含聊天截图路径或聊天文字，发 issue 前先脱敏。
