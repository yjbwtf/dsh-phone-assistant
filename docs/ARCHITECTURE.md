# 架构

## 组件

### Windows 面板

`panel/` 是 .NET 9 WinForms + WebView2 应用：

- 启动本地 HTTP 控制台，默认 `127.0.0.1:18642`。
- 通过 ADB 与手机通信。
- 启动 scrcpy 2.7 作为镜像/输入后端。
- 直接读取 scrcpy-server 的 H.264 流，通过 WebView2 的 WebCodecs 画到 canvas；失败回退 SDL 子窗口。
- 内嵌插件 UI 资源，打包为单个 exe。

### DSH 插件

`plugin/` 是 DSH Host 插件（Node.js ESM）：

- 创建/恢复「手机助手」DSH 会话。
- 注册 `phone`、`wechat`、`phone_skill`、`memory`、`meme` 等工具。
- 微信桥循环：通知 → 去重 → 管理员过滤 → 快速确认 → Agent → 回复。
- 任务进度和最终结果上报。
- 微信发送前校验目标聊天标题。

### Android 无障碍服务

`android-a11y/` 是自行构建的 AccessibilityService：

- 通过本地 socket + `adb forward` 与电脑通信。
- 读取普通应用的节点树、执行点击/输入/手势。
- 微信节点被屏蔽，所以微信场景使用通知 + 截图/OCR/视觉。

## 数据流

```text
微信通知
  → 插件 WeChatBridge
  → 管理员/目标过滤
  → 同一 DSH 会话判断是否需要快速确认
  → 需要：发一句确认
  → Agent 执行（phone / phone_skill / memory ...）
  → 回复文本
  → 发送前 OCR 校验聊天标题
  → 发回微信
```

## 镜像链路

```text
scrcpy-server (Android, H.264)
  → adb forward / local socket
  → NativeMirror.cs 解析 12 字节头
  → WebView2 postMessage
  → WebCodecs VideoDecoder
  → canvas
```

鼠标事件从 canvas 转发给隐藏的 scrcpy 窗口：

- 左键/拖动：触摸/拖动
- 右键：返回
- 中键：主页
- hover：手机端光标
- C# 80ms 看门狗：鼠标在窗口外松开时补发 `up`

## 记忆/技能

- 普通记忆：SQLite + BM25/字符 n-gram + 可选 Embedding。
- 技能：手机操作步骤序列（0-1 坐标、参数占位符），保存在 `phone_skills` 表。
- 微信桥/Agent 的人格和设置都存本机；不入库到仓库。

## 安全边界

- 控制台和插件只监听本机。
- 发送前标题校验失败会拒绝发送。
- 不提供微信数据库读取、root 或 hook。
- API Key 只存本机；日志可能包含截图路径，发布前脱敏。
