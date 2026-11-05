#pragma once
/**
 * 《余烬》USB 存档协议 · 固件侧接入提示（桩）
 *
 * 这不是完整实现。请在游戏固件中：
 *  1) 把控制台/USB 文本行喂给协议状态机；
 *  2) 在设置菜单提供「备份存档 / 导入存档」；
 *  3) 导出 0x9000 起 0x6000 字节的 NVS 快照（或等价权威镜像）；
 *  4) 导入时使用暂存 + 校验 + 重启回执。
 *
 * 线协议见仓库 tools/save-manager/PROTOCOL.md（前缀 !EMBACKUP）。
 */
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#define EMBER_USB_BACKUP_NVS_OFFSET 0x9000u
#define EMBER_USB_BACKUP_NVS_SIZE   0x6000u

#ifdef __cplusplus
extern "C" {
#endif

typedef enum {
  EMBER_BACKUP_IDLE = 0,
  EMBER_BACKUP_NO_HOST,
  EMBER_BACKUP_SENDING,
  EMBER_BACKUP_WAIT_ACK,
  EMBER_BACKUP_DONE,
  EMBER_BACKUP_FAILED,
  EMBER_RESTORE_OFFER,
  EMBER_RESTORE_RECEIVING,
  EMBER_RESTORE_STAGED,
} ember_backup_state_t;

/** 由固件实现：向 USB 控制台写一行（须含结尾 \\n）。 */
typedef void (*ember_backup_emit_fn)(const char *line);

/** 由固件实现：填充 NVS 快照；成功返回 true。 */
typedef bool (*ember_backup_snapshot_fn)(uint8_t *out, size_t len);

void ember_backup_init(ember_backup_snapshot_fn snapshot,
                       ember_backup_emit_fn emit,
                       const char *device_id12_hex,
                       const char *firmware_sha256_hex,
                       unsigned save_version);

/** 每个从主机收到的字符；若行以 '!' 开头则由协议消费。 */
bool ember_backup_feed(char c);

void ember_backup_tick(uint32_t now_ms);

/** 仅当玩家在菜单确认「备份」时调用。 */
void ember_backup_request_export(void);

void ember_backup_set_import_mode(bool enabled);
void ember_backup_confirm_import(bool accept);

ember_backup_state_t ember_backup_state(void);

#ifdef __cplusplus
}
#endif
