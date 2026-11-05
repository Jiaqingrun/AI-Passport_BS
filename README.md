# AI-Passport_BS · 余烬存档管家

为 FoloToy **AI Passport** 社区游戏《**余烬**》提供的本机存档 **备份 / 迁移 / 覆盖前保护** 工具。

灵感来自网友开源的 [PokeWalk 存档管理](https://luobata.github.io/ESP32-PokemonGo/)（USB 连接 → 设备确认 → 文件只落在你的电脑）。本仓库面向《余烬》：独立协议 `!EMBACKUP`、独立后缀 `.emsave`，并加强了分步操作提示与失败说明。

> 仓库地址：[Jiaqingrun/AI-Passport_BS](https://github.com/Jiaqingrun/AI-Passport_BS)

## 玩家怎么用（最短路径）

1. 安装 **桌面版 Chrome 或 Edge**（需 Web Serial）。
2. 本机启动工具（任选其一）：
   - **推荐开发/离线：**
     ```bash
     python3 tools/save-manager/server.py
     ```
     打开 [http://localhost:8765/](http://localhost:8765/)
   - 或下载页面上的 **EmberSaveManager.zip**，解压后同样运行 `server.py`。
3. 按页面四步操作：
   1. 选择私人备份目录  
   2. 连接 AI Passport（USB JTAG/serial）  
   3. 在设备：**设置 → 备份存档 → 确认**  
   4. （可选）导入：设备先开「导入存档」→ 本页选 `.emsave` → 发送 → 设备确认覆盖  

详细提示、刷机前检查清单见页面正文与 [docs/player-guide.zh_CN.md](docs/player-guide.zh_CN.md)。

## 重要提示

| 场景 | 该怎么做 |
| --- | --- |
| 安装社区「完整包」前 | **先备份**；完整包常会清空 NVS |
| 页面显示「校验通过」 | 只说明文件完整，**不等于已导入** |
| 导入中途拔线 | 保留原备份；重新连接核对；不要开新档覆盖 |
| 换另一台 Passport | 不能导入（绑定 `device_id`） |
| 与 PokeWalk `.pksave` | **不互通** |

固件需实现 USB 协议后，备份/导入才会真正工作。接入说明：[docs/firmware-integration.zh_CN.md](docs/firmware-integration.zh_CN.md)。协议原文：[tools/save-manager/PROTOCOL.md](tools/save-manager/PROTOCOL.md)。

## 开发者

```bash
# 本地页
python3 tools/save-manager/server.py --port 8765

# 只读检查备份文件
python3 tools/save-manager/inspect_emsave.py path/to/file.emsave

# 编解码自检
node tools/save-manager/selftest.mjs
```

静态页可部署到 GitHub Pages（工作流：`.github/workflows/pages.yml`）。Pages 为 HTTPS，可直接 Web Serial；若只有 HTTP 入口，请引导用户下载 ZIP 在 localhost 使用。

## 目录

```
tools/save-manager/     网页 + 本地 server + 协议说明
docs/                   玩家指南、固件接入
firmware/usb_backup_stub/  固件侧接入提示头文件（非完整实现）
```

## 隐私

`.emsave` 含 NVS 原始数据，可能包含设备侧其它键值。请保存在私人目录，勿提交到 Git，勿公开分享。页面无上传接口；关闭标签页即断开 USB。

## 许可

MIT · Copyright (c) 2026 Jiaqingrun  
参考实现思想致谢：[Luobata/ESP32-PokemonGo](https://github.com/luobata/ESP32-PokemonGo) 存档工具。
