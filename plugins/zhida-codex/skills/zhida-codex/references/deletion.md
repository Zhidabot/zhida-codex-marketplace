# 永久删除

永久删除独立于普通修改，不能回滚。保留精确预览后的单独确认。

1. 用搜索或单条读取工具定位目标，取得当前 UUID、`before_hash`、类型和识别名称。目标不明确时先澄清。
2. 调用 `preview_entry_deletions`，每项包含 `entry_type`、`uuid`、`before_hash` 和简短 `reason`。原因不要复制待删除正文。
3. 向用户展示项目、类型、标题或关键词及目标数量，说明永久删除不可恢复，等待用户确认这些具体目标。初始删除指令不替代这次确认；内部 `deletion_set_uuid` 由工具保留，无需用户复述。
4. 确认后用原 `deletion_set_uuid` 和 `confirm_irreversible: true` 调用 `apply_entry_deletions`。仅在返回 `status: deleted` 时报告完成。
5. 超时或处理中用 `get_entry_deletion_status` 查询；仍为 `applying` 时可重试同一删除单。失败或预览过期时重新读取目标，不能直接创建重复删除。

预览有效期为 10 分钟。删除单只保留最少审计信息，不保存被删除正文。不能对删除单调用 `rollback_change`。
