# `!EMBACKUP` 协议（v1）

行文本协议，USB Serial 115200（或板载 USB JTAG 控制台同等文本通道）。

## 会话

| 方向 | 报文 | 说明 |
| --- | --- | --- |
| PC→Dev | `!EMBACKUP HELLO <session32hex>` | 建立会话 |
| Dev→PC | `!EMBACKUP READY <session> <device_id12hex>` | 就绪 |
| PC→Dev | `!EMBACKUP PING <session>` | 心跳（约 4s） |
| PC→Dev | `!EMBACKUP PULL <session>` | 网页一键拉取备份（等同设备「备份存档」） |
| PC→Dev | `!EMBACKUP BYE <session>` | 结束 |
| Dev→PC | `!EMBACKUP HINT <utf8 text…>` | 可选提示（空格后原文） |

`device_id`：12 位小写 hex（由固件稳定导出，同机不变）。  
`firmware`：64 位小写 hex（构建指纹，追溯用）。

## 备份（设备发起）

设备仅在用户确认「备份存档」且会话有效时开始：

```
!EMBACKUP BEGIN <session> <id> <device> <firmware> <save_version> 36864 24576 <crc32>
!EMBACKUP DATA <id> <offset> <256 hex chars>   # 128 bytes
…重复直到 offset+128 == size…
!EMBACKUP END <id> <crc32>
```

PC 落盘并回读校验后：

```
!EMBACKUP ACK <session> <id>
```

失败则 `!EMBACKUP FAIL <session> <id>`。设备在超时（建议 60s）未收到 ACK 时宣告失败，**不修改**存档。

## 导入（网页发起，设备确认）

1. PC：`!EMBACKUP OFFER <session> <device> <firmware> <save_version> <size> <crc32>`（设备空闲即可，无需预开导入菜单）  
2. Dev：弹出确认并回 `!EMBACKUP OFFERED`（或 `INCOMPATIBLE` / `BUSY`）  
3. 用户确认覆盖后，设备先导出当前档（同上 BEGIN/DATA/END），PC 存为 `Ember-before-import-…emsave` 后 ACK。  
4. Dev：`!EMBACKUP UPLOAD <id>`  
5. PC：`!EMBACKUP RDATA <session> <id> <offset> <256 hex>`  
6. Dev：`!EMBACKUP NEXT <id> <next_offset>`  
7. PC：`!EMBACKUP RFIN <session> <id>`  
8. Dev 校验暂存成功：`!EMBACKUP STAGED <crc32>` 并重启。  
9. 再连接后 Dev：`!EMBACKUP RESTORED <session> <result> <crc32>`  
    - `1` 成功读档  
    - `2` 擦除后写入失败（设备无法本地回滚；请用电脑上的 `Ember-before-import-…emsave` 再导入）  
    - `3` 写入后读档失败  

## 错误

`!EMBACKUP ERROR <CODE>`，常用：`TIMEOUT` `SNAPSHOT` `OPEN_IMPORT` `BUSY` `INCOMPATIBLE` `MEMORY` `CHECKSUM` `SEQUENCE` `NO_HOST`  
细分：`ERROR STAGE <LAYOUT|FLASH|NVS|MEMORY|READ|VERSION|CONTENT|CHECKPOINT|JOURNAL>`

## 文件格式 `.emsave`

JSON，`format = "ember-nvs-backup"`，`format_version = 1`，字段见 `web/backup.mjs` 的 `envelope()`。
