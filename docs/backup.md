# D1 备份与恢复

## 导出

执行：

```bash
npm run db:backup
```

脚本调用 Wrangler 远端导出并写入 `backups/backup-<ISO time>.sql`。`backups/`/`backup-*.sql` 被 Git 忽略；备份仍可能含私人想法、任务和聊天原文，应存入加密磁盘，不要上传公开仓库。

建议在以下操作前导出：

- 应用新 migration
- 批量修改/删除数据
- 大版本 Worker 更新

## 验证备份

```bash
ls -lh backups/
head -n 20 backups/backup-*.sql
```

不要在共享终端输出完整 SQL；其中含个人数据。

## 恢复演练（推荐新数据库）

恢复是有状态写操作。先创建独立数据库验证：

```bash
npx wrangler d1 create composa-restore-test
npx wrangler d1 execute composa-restore-test --remote --file backups/<backup-file>.sql
npx wrangler d1 execute composa-restore-test --remote --command "SELECT COUNT(*) AS items FROM items"
```

导出文件通常包含 schema 与数据，不要先在空恢复库应用同一 schema migration，否则会产生对象已存在冲突。

## 生产恢复

生产恢复可能覆盖/合并现有数据，不提供“一键自动恢复”脚本。先完成以下检查：

1. 保留当前生产库的第二份导出。
2. 在 `composa-restore-test` 验证表、item 数、reminder 状态和最近记录。
3. 停止平台 webhook 或暂时撤掉 Worker route，避免恢复期间继续写入。
4. 明确选择新库切换，或在 Cloudflare 提供的恢复能力中选择时间点。
5. 更新 `wrangler.jsonc` 的 database ID、部署并运行 `/health` 与聊天验收。

优先采用“恢复到新 D1 → 验证 → 切换 binding”，这样旧库仍可回退。
