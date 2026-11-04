# Third-Party Notices

本项目采用 MIT License 发布自己的代码。下列第三方组件/运行时分发或依赖关系需要单独说明。完整许可证文本位于 `third_party/`。

| 组件 | 版本/来源 | 许可证 | 用途 | 分发方式 |
| --- | --- | --- | --- | --- |
| scrcpy | 2.7 / https://github.com/Genymobile/scrcpy | Apache-2.0 | 手机镜像、鼠标输入、H.264 服务端 | 面板安装包内置 `runtime/scrcpy-2.7` 和 `scrcpy-server-2.7.jar` |
| Android Platform Tools `adb` | 33.0.3 / https://android.googlesource.com/platform/packages/modules/adb | Apache-2.0 | USB 设备控制 | 面板安装包内置 `runtime/adb33` |
| ADBKeyboard | https://github.com/senzhk/ADBKeyBoard | **GPL-2.0** | 中文输入法注入 | 插件包内置 `assets/ADBKeyboard.apk`；GPL 对应源码见 Release 的 `ADBKeyboard-source.tar.gz` |
| Microsoft WebView2 | Evergreen Runtime / SDK 1.0.4314.35 | Microsoft Software License Terms | 面板内嵌 UI 与视频解码 | 不随安装包捆绑 Runtime；用户需安装 WebView2 Runtime |
| .NET 9 | Microsoft | MIT | WinForms 面板运行时 | 面板以 self-contained 方式包含 .NET 运行时 |
| FFmpeg | scrcpy 2.7 依赖 | LGPL-2.1-or-later / 具体以 scrcpy 分发为准 | 视频编解码 | 随 scrcpy 目录分发 |
| SDL2 | scrcpy 2.7 依赖 | zlib | scrcpy 窗口/输入 | 随 scrcpy 目录分发 |
| Windows Media OCR | Windows 10/11 系统组件 | Windows 系统许可 | 本地 OCR | 不单独分发，调用系统 API |
| OpenCV（可选） | https://opencv.org | Apache-2.0 | 模板匹配 Python 脚本 | 不捆绑 Python 包；按需安装 |
| Pillow（可选） | https://python-pillow.org | HPND | 图片预处理脚本 | 不捆绑 Python 包；按需安装 |
| Inno Setup | 6.7.3 / https://jrsoftware.org/isinfo.php | Inno Setup License（freeware） | 生成 Windows 安装包 | 构建工具，不随成品运行 |

## GPL-2.0 对应源码

`ADBKeyboard.apk` 是第三方 GPL-2.0 程序。发布包同时提供：

- 源码归档：Release 资产 `ADBKeyboard-source.tar.gz`
- 上游仓库：https://github.com/senzhk/ADBKeyBoard
- 许可证全文：`third_party/ADBKeyboard-LICENSE.txt`

ADBKeyboard 与本项目是独立程序，本项目源码仍按 MIT 发布；ADBKeyboard 的修改/再分发需遵守 GPL-2.0。

## WebView2

面板使用 Microsoft WebView2 SDK 并依赖系统 WebView2 Runtime。WebView2 SDK/Runtime 不适用 MIT；使用和再分发受 Microsoft 的许可条款约束。安装器只检查 Runtime 是否存在，不捆绑其安装程序。

## 商标

DeepSeek Harness（DSH）、WeChat/微信、Android、scrcpy、WebView2、FFmpeg、SDL 等名称和商标归各自所有者。本项目与这些项目的维护者没有隶属关系。
