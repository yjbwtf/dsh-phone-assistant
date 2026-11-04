# DSH 插件安装

插件包：`dsh-phone-bridge-0.1.0.tgz`

插件运行在 **DeepSeek Harness** 里，不是独立程序。面板可以单独用；要让微信消息进入 Agent，必须装插件。

## 前置条件

- 已安装 DeepSeek Harness（DSH）
- Node.js 22+（DSH 自带运行时也可）
- 面板已安装并能连接手机
- 知道当前 DSH 使用的 profile；Web GUI 通常是 `web`

## 找到 DSH CLI

DSH 安装目录下：

```text
<DSH 安装目录>\resources\runtime\cli\bin\dsh.cmd
```

例如：

```powershell
$dsh = "C:\Program Files\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd"
```

## 安装

在 PowerShell 里执行（把路径替换成实际 tgz 路径）：

```powershell
& $dsh plugin --profile web add "F:\Downloads\dsh-phone-bridge-0.1.0.tgz"
```

- `--profile web` 是 DSH Web GUI 的 profile；如果你使用自定义 profile，换成实际名称。
- 命令实际把包转交给该 profile 的 pnpm；安装完成后需要 **重启 DSH** 让 Host 插件加载。
- 插件只写入 DSH profile，不修改 DSH 客户端代码或安装目录。

## 验证

重启 DSH 后：

1. DSH 侧栏出现「手机助手」工作区/会话。
2. 面板/浏览器打开 <http://127.0.0.1:18642>，能看到控制台。
3. 面板「Agent」页显示会话已就绪。
4. 微信桥开启后，发一条测试消息；日志出现“微信消息已交给 Agent”。

## 配置

打开面板：

- 「设置」：确认 ADB、scrcpy、数据目录。
- 「微信桥」：管理员、目标聊天、是否群 @、监听开关。
- 「Agent」：任务通知、视觉模型、Embedding（可选）。
- 「人格」：Agent 人格提示词。
- 「技能」：复用手机操作步骤。

目标聊天名必须和微信界面显示一致。发送前会做聊天标题 OCR 校验；校验失败会抛错并拒绝发送。

微信桥启动时会自动启用并切换到 **ADBKeyboard**，默认不再切回原输入法；这样中文输入不会在“原输入法/ADBKeyboard”之间来回切。要恢复原输入法，手动在手机设置里切换，或把面板设置中的“发送后恢复原输入法”打开。

## Android 组件

插件包内含：

```text
assets/dsh-a11y.apk
assets/ADBKeyboard.apk
```

首次启动时插件会尝试通过 ADB 安装；如果失败，手动执行：

```powershell
$adb = "$env:LOCALAPPDATA\Programs\DSH Phone Assistant\runtime\adb33\adb.exe"
& $adb install -r .\assets\dsh-a11y.apk
& $adb install -r .\assets\ADBKeyboard.apk
```

然后在手机设置中启用无障碍服务和 ADBKeyboard 输入法。

`ADBKeyboard.apk` 是 GPL-2.0 第三方组件，对应源码见 Release 的 `ADBKeyboard-source.tar.gz`，说明见 [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md)。

## 更新

```powershell
& $dsh plugin --profile web add "F:\Downloads\dsh-phone-bridge-0.1.1.tgz"
```

pnpm 会用新 tarball 覆盖同版本依赖；重启 DSH。

## 卸载

```powershell
& $dsh plugin --profile web remove @local/dsh-phone-bridge
```

重启 DSH。用户数据（设置、截图、记忆）不会自动删除。

## 常见失败

- 提示找不到 `dsh.cmd`：用 DSH 安装目录下的完整路径，不要把 `dsh` 当全局命令。
- 提示 profile 不存在：换成实际 profile；不确定时看 DSH 快捷方式/启动参数。
- 装完没反应：必须重启 DSH；只刷新页面不够。
- 端口 18642 被占用：关闭旧面板/旧 DSH 进程，或改插件设置里的 `httpPort`。
- 手机未授权：先在手机上允许 USB 调试。
