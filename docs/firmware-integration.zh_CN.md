# 《余烬》固件接入 USB 存档协议

本仓库的网页工具通过 USB Serial/JTAG 与设备对话。设备固件需实现 `!EMBACKUP` 行协议后，玩家才能在「存档管家」里备份 / 导入。

设计灵感来自社区开源 [PokeWalk 存档管理](https://luobata.github.io/ESP32-PokemonGo/)（`!PWBACKUP`）。本项目使用独立前缀与文件格式，**不能**与 `.pksave` 互通。

## 玩家可见菜单（建议文案）

| 菜单 | 文案 | 行为 |
| --- | --- | --- |
| 设置 | 备份存档 | 仅在已与网页建立会话时开始导出；否则提示「请先打开存档管家并连接」 |
| 设置 | 导入存档 | 进入导入模式，等待网页 `OFFER`；默认焦点在「取消」 |
| 确认框 | 确认覆盖 / 取消 | 确认后才接收载荷；取消发 `CANCELLED` |

## 线协议摘要

- 每一行以 `!EMBACKUP` 开头，以 `\n` 结束。
- 网页先发 `HELLO <session32>`，设备回 `READY <session> <device_id12>`。
- 备份：设备 `BEGIN` → 多帧 `DATA`（每帧 128 字节 hex）→ `END`；网页校验落盘后回 `ACK`。
- 导入：网页 `OFFER` → 设备 `OFFERED` → 用户确认 → 网页先备份当前档 → `ACK` 后设备 `UPLOAD` / `NEXT` → `STAGED` → 重启 → 再连时 `RESTORED <session> <1\|2\|3> <crc>`。

完整字段与错误码见 [`../tools/save-manager/PROTOCOL.md`](../tools/save-manager/PROTOCOL.md)。参考桩代码目录：[`../firmware/usb_backup_stub/`](../firmware/usb_backup_stub/)。

## 布局约定（AI Passport / ESP32-C3）

| 项 | 值 |
| --- | --- |
| NVS 偏移 | `0x9000` |
| NVS 大小 | `0x6000`（24 KiB） |
| 备份容器 | `.emsave` JSON，`format: ember-nvs-backup` |
| 芯片字段 | `esp32c3` |

导出内容应为 **NVS 分区快照**（或与快照等长的权威镜像）。导入前建议：停写 NVS、做 checkpoint、写入独立暂存区，校验通过后再提交并重启。

## 安全与提示

1. 导入默认选中取消，避免误覆盖。
2. 覆盖前由网页强制保存「before-import」备份。
3. 仅允许 `device_id` 相同的备份导入。
4. `save_version` 由固件声明；较新存档倒灌旧固件应拒绝。
5. 不要在公开渠道分享 `.emsave`。
