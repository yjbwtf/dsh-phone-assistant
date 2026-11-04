# 部署流程

本文按“从零到能用”的顺序说明面板、插件、手机和微信的部署。

## 1. 拓扑

```text
Android 手机
├─ USB 调试 / ADB
├─ DSH 无障碍助手 APK  127.0.0.1:27183（adb forward）
├─ ADBKeyboard（中文输入）
└─ scrcpy-server（H.264 视频 / 鼠标输入）

Windows
├─ DSH 手机助手面板
│  ├─ runtime/adb33
│  ├─ runtime/scrcpy-2.7
│  └─ panel-data（设置、截图、日志）
└─ DeepSeek Harness
   └─ @local/dsh-phone-bridge
      ├─ 18642 本地 HTTP 控制台
      ├─ 微信桥
      └─ DSH Agent 会话
```

所有监听都应在 `127.0.0.1`。不要把 18642 暴露到公网，也不要把 ADB 端口映射到公网。

## 2. 安装顺序

1. **安装面板**：[INSTALL_PANEL.md](INSTALL_PANEL.md)
2. **准备手机**：USB 调试授权、无障碍、ADBKeyboard
3. **安装插件**：[INSTALL_PLUGIN.md](INSTALL_PLUGIN.md)
4. **重启 DSH**
5. **配置微信桥**：管理员、目标聊天、监听开关
6. **发送测试消息**，确认 Agent 收到并回复

## 3. 面板配置

在「设置」确认：

| 配置 | 说明 |
| --- | --- |
| ADB 路径 | 安装目录 `runtime\adb33\adb.exe` |
| scrcpy 路径 | 安装目录 `runtime\scrcpy-2.7\scrcpy.exe` |
| 数据目录 | 默认安装目录下 `panel-data` |
| 监听端口 | 默认 `18642`，只监听本机 |

在「微信桥」确认：

| 配置 | 说明 |
| --- | --- |
| 管理员 | 只有这些联系人/群成员可以下指令 |
| 目标聊天 | 要监听和回复的私聊/群；名称必须与微信界面一致 |
| 只响应 @ 我 | 群聊建议开启 |
| 直达置顶聊天 | 只在你把自己的私聊置顶时使用 |
| 自动监听 | 开启后才会把消息交给 Agent |

## 4. 微信发送安全

发送流程：

1. 打开目标聊天。
2. 截图 + OCR 读取顶部聊天标题。
3. 标题不匹配：拒绝发送，清空缓存。
4. 标题匹配：输入并发送。

快捷确认、Agent 最终回复、技能里的打开聊天都走同一入口。不要把
`directPrimaryChat` 当成万能：置顶变化后仍应保留标题校验。

## 5. 模型与密钥

可选配置（面板 → Agent）：

- 视觉模型：OpenAI 兼容接口，用于识别截图/表情。
- Embedding：OpenAI 兼容接口，用于长期记忆语义检索。
- 不配置也能用；会退化为本地 OCR/关键词检索。

密钥只保存在本机设置文件，不写入仓库、不写入安装包。公网 issue 里不要贴 Key。

## 6. 远程使用

不建议把 ADB 或 18642 暴露到公网。需要远程时，优先用：

- 受控的远程桌面（RDP/向日葵等）操作这台 Windows；
- 或 SSH 隧道，并且只绑定 localhost；
- 不要在路由器上做 18642/5555 端口映射。

## 7. 更新

- 面板：运行新安装包覆盖安装；`panel-data` 保留。
- 插件：`dsh plugin --profile <profile> add <new.tgz>`，重启 DSH。
- 升级前备份 `panel-data\settings.json` 和记忆数据库。

## 8. 构建发行物

仓库根目录：

```powershell
# 面板
cd panel
dotnet publish -c Release -r win-x64 --self-contained true `
  -p:PublishSingleFile=true -p:IncludeNativeLibrariesForSelfExtract=true `
  -p:EnableCompressionInSingleFile=true -o ..\dist\panel

# 插件
cd ..\plugin
npm pack --pack-destination ..\dist

# 安装包
cd ..\installer
ISCC.exe dsh-phone-assistant.iss
```

`installer/dsh-phone-assistant.iss` 期望：

```text
dist/panel/DSH手机助手面板.exe
dist/panel/runtime/adb33/**
dist/panel/runtime/scrcpy-2.7/**
dist/panel/runtime/scrcpy-server-2.7.jar
```

## 9. 发布检查

- [ ] 仓库没有 `settings.json`、`panel-data`、截图、Key
- [ ] `.tgz` 能通过 `dsh plugin add` 安装
- [ ] 安装包能在干净 Windows 上启动
- [ ] 手机未连接时面板不崩
- [ ] 微信标题校验失败时不发送
- [ ] `SHA256SUMS.txt` 与资产一致
- [ ] `THIRD_PARTY_NOTICES.md` 已更新
