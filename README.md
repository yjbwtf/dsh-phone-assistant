# DSH Phone Assistant

Windows 上的本地 Android 手机助手：通过 **ADB + 无障碍服务 + 截图/视觉** 操作手机，并把微信消息接入 **DeepSeek Harness（DSH）** Agent。

> 项目由两部分组成，分别安装：
>
> - **DSH 手机助手面板**：Windows 桌面控制台、手机镜像、微信桥、技能与设置。
> - **@local/dsh-phone-bridge**：DSH Host 插件，负责创建 Agent 会话、微信收发和工具注册。

当前版本：`0.1.0`（Windows x64 / Android 10+，主要测试机型 HONOR HLK-AL00 / Android 10）。

## 功能

- ADB 设备管理：状态、截图、点击、滑动、输入、按键、启动应用、shell。
- 自行构建的 Android 无障碍服务：读取普通应用节点、按文字点击、执行手势。
- 微信：通知监听、目标聊天校验、ADBKeyboard 中文输入、媒体分享。
- 手机镜像：scrcpy 2.7 + WebView2 WebCodecs 内嵌画面；失败时自动回退 SDL。
- 手机实时查看：see-now 通过手机助手的 MJPEG 源直接抽帧拼图；不再自己连续截图。
- DSH Agent：微信消息交给 Agent，回复自动回微信；任务进度通知。
- 快速确认：同一个人 DSH 会话先判断是否需要“我先看一下”，再执行任务。
- 长期记忆、可复用手机技能、表情包本地库（可选）。
- 本地控制台：设备、微信桥、Agent、记忆、技能、人格、设置。

## 下载

从 [Releases](https://github.com/yjbwtf/dsh-phone-assistant/releases) 下载：

| 资产 | 用途 |
| --- | --- |
| `DSH-Phone-Assistant-Setup-0.1.0.exe` | Windows 面板安装包 |
| `dsh-phone-bridge-0.1.0.tgz` | DSH 插件包，单独安装 |
| `ADBKeyboard-source.tar.gz` | ADBKeyboard GPL-2.0 对应源码 |
| `SHA256SUMS.txt` | 校验和 |

安装步骤：

- 面板：[docs/INSTALL_PANEL.md](docs/INSTALL_PANEL.md)
- 插件：[docs/INSTALL_PLUGIN.md](docs/INSTALL_PLUGIN.md)
- 完整部署：[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)
- 故障排查：[docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md)
- 可选插件：[docs/OPTIONAL_PLUGINS.md](docs/OPTIONAL_PLUGINS.md)

## 快速开始

1. 安装面板，启动后连接已开启 USB 调试的 Android 手机，并在手机上允许调试授权。
2. 安装 DSH 插件（需要已安装 DeepSeek Harness）：

   ```powershell
   & "C:\Program Files\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd" `
     plugin --profile web add "F:\Downloads\dsh-phone-bridge-0.1.0.tgz"
   ```

   `web` 是 DSH Web GUI 使用的 profile；如果你用的是别的 profile，替换成实际名称。安装后重启 DSH。
3. 打开面板，在「设置」确认 ADB、scrcpy 和微信目标；在「微信桥」添加管理员/目标聊天并开启监听。
4. 在手机设置中启用 `DSH 无障碍助手`，并把 `ADBKeyboard` 设为当前输入法。

面板自带 `adb`、`scrcpy 2.7` 和 H.264 服务端；插件包自带 Android APK 与 OCR 组件。

## 目录

```text
panel/            Windows 面板（.NET 9 WinForms + WebView2）
plugin/           DSH Host 插件（Node.js ESM）
android-a11y/     无障碍服务 APK 源码
docs/             安装、部署、架构、排障
installer/        Inno Setup 安装脚本
third_party/      第三方许可证与 GPL 对应源码说明
```

## 构建

面板需要 .NET 9 SDK；插件需要 Node.js 22+。

```powershell
cd panel
dotnet publish -c Release -r win-x64 --self-contained true `
  -p:PublishSingleFile=true -p:IncludeNativeLibrariesForSelfExtract=true `
  -p:EnableCompressionInSingleFile=true -o ..\dist\panel

cd ..\plugin
npm pack
```

安装包需要 Inno Setup 6：

```powershell
ISCC.exe installer\dsh-phone-assistant.iss
```

更完整的构建/发布流程见 [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)。

## 安全与隐私

- 面板和插件只监听 `127.0.0.1`，不要暴露到公网。
- 设置、截图、日志保存在本机 `panel-data/` 或用户数据目录；不要提交到 Git。
- API Key 只保存在本机设置文件；仓库和安装包不包含任何 Key。
- 微信自动化可能违反微信/腾讯的服务条款；请只操作自己的账号，自行承担风险。
- 发送消息前会校验当前聊天标题；校验失败会拒绝发送，而不是赌当前页面。

## 已知限制

- 微信屏蔽 Accessibility/UIAutomator 的聊天内容节点；界面读取依赖截图 + OCR + 视觉模型。
- 不 root 无法读取微信数据库；hook/Frida 有账号风险，本项目不提供。
- 手机镜像输入依赖 scrcpy 的鼠标模式；原生 H.264 解码失败会自动回退。
- 需要 USB 调试；不支持未授权的无线 ADB。
- 主要测试 Android 10；更高版本可能需要调整坐标/权限。

## License

本项目代码采用 **MIT License**，见 [LICENSE](LICENSE)。

第三方组件、许可证和 GPL 对应源码说明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。特别地，`ADBKeyboard.apk` 以 GPL-2.0 分发，对应的源码归档随 Release 提供。

DeepSeek Harness、WeChat、Android、scrcpy、WebView2 等名称/商标归各自所有者。
