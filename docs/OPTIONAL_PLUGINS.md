# 可选插件：实时视觉 / 梗百科

这两个不是本项目内置代码，安装到 DSH 的 `desktop` profile 使用。

## dsh-see-now（实时视觉）

- 仓库：<https://github.com/SAOS-3624/dsh-see-now>
- 版本：`0.0.10`
- 许可证：Apache-2.0
- 作用：按画面变化抽帧，拼成一张图给模型；适合看电脑桌面、一起看视频。
- 抓的是**电脑屏幕**，不是手机屏幕。看手机仍用 `phone action=screenshot/vision`。

安装：

```powershell
& "<DSH安装目录>\resources\runtime\cli\bin\dsh.cmd" `
  plugin --profile desktop add dsh-see-now
```

运行依赖：

- `ffmpeg.exe`：放在 `%USERPROFILE%\.dsh\tools\ffmpeg\bin\ffmpeg.exe`，或设置 `DSH_FFMPEG_PATH`。
- 悬浮窗需要 Python + `tkinter` + `mss`：

  ```powershell
  python -m pip install mss
  ```

模型调用方式：

```text
see_now({action:"watch"})   # 正常实时看
see_now({action:"peek"})    # 取已经攒好的图
see_now({action:"status"})  # 状态
see_now({action:"stop"})    # 停止
```

`say` 只显示在电脑悬浮窗，不会自动发微信；微信回复仍由手机助手桥接发送。

手机端对应能力：不依赖 see-now，手机助手提供了 `phone action=see`，连续截图、按变化抽帧并拼成一张图，模型再用 `read_image` 看。两者一个看电脑桌面，一个看手机屏幕。


## dsh-memewiki（梗百科）

- 仓库：<https://github.com/thawline/dsh-memewiki>
- 版本：`0.1.6`
- 许可证：MIT
- 作用：6696 条本地梗/黑话词库；自动预查并注入上下文，另注册 `search_meme_wiki` 工具。

安装（尚未发布到 npm，从源码或 tarball 安装）：

```powershell
# 本地 tarball
& "<DSH安装目录>\resources\runtime\cli\bin\dsh.cmd" `
  plugin --profile desktop add "F:\path\dsh-memewiki-0.1.6.tgz"
```

配置：`~/.dsh/memewiki.json`

```json
{
  "自动思考梗": true,
  "串子开关": false,
  "串子程度": 50
}
```

设置页在 DSH → 设置 → 插件 → 梗百科。

## 与手机助手的配合

手机助手 Agent 的提示词已加了两条：

- 看电脑桌面/实时画面/视频：用 `see_now`；
- 新梗优先查 `search_meme_wiki`，需要判断冒犯风险再用手机助手自带的 `memekb`。

两个插件都装进 `desktop` profile，重启 DSH 后仍保留；不是本项目仓库的依赖。
