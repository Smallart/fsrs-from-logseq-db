# 维护指南

部署上线后的日常维护：更新、备份、恢复、排障。

## 1. 日常更新

```bash
# 服务器上
cd /opt/fsrs && docker compose pull && docker compose up -d
docker compose logs -f app    # 确认迁移成功 + Ready
```

## 2. 数据备份（关键）

### 2.1 什么必须备份

| 数据 | 放哪 | 丢了能恢复吗 |
|---|---|---|
| 笔记/卡片内容 | DB `notes`/`cards` | ✅ 能——从 Logseq 重新同步 |
| **FSRS 复习状态**（due/reps/lapses/revlog） | DB `revlog`/`cards` | ❌ 不能——Logseq 里没有 |
| Deck 配置（fsrs 参数/每日上限/分类） | DB `decks`/`note_decks` | ❌ 不能 |
| Logseq PAT + graphId | DB `config` | ⚠ 含密钥，备份要当敏感文件 |

**结论**：内容能重同步，但**复习进度和 deck 配置只有 DB 有**——必须定期备份。

### 2.2 手动备份

```bash
cd /opt/fsrs
docker exec fsrs-postgres pg_dump -U fsrs -Fc fsrs > fsrs_$(date +%Y%m%d_%H%M).dump
```

- `-Fc` 自定义压缩格式，恢复用 `pg_restore`（推荐）
- 想导出明文 SQL：`docker exec fsrs-postgres pg_dump -U fsrs fsrs > fsrs.sql`

### 2.3 自动每日备份（cron）

**脚本 `/opt/fsrs/backup.sh`**：

```bash
#!/usr/bin/env bash
set -euo pipefail
mkdir -p /opt/fsrs/backups
docker exec fsrs-postgres pg_dump -U fsrs -Fc fsrs > /opt/fsrs/backups/fsrs_$(date +%F_%H%M).dump
# 只保留最近 7 天
find /opt/fsrs/backups -name '*.dump' -mtime +7 -delete
```

```bash
chmod +x /opt/fsrs/backup.sh
( crontab -l 2>/dev/null; echo "0 4 * * * /opt/fsrs/backup.sh >> /opt/fsrs/backups/backup.log 2>&1" ) | crontab -
crontab -l    # 确认已加
```

### 2.4 异地备份（服务器单点是风险）

```bash
# 手动拉回本地
scp <用户>@<服务器IP>:/opt/fsrs/backups/fsrs_xxx.dump D:\backups\

# 或 rclone 同步到 S3/Backblaze/OneDrive（可再加进 cron）
rclone copy /opt/fsrs/backups remote:fsrs-backups
```

### 2.5 备份敏感性

- 备份含 `config` 表的 **Logseq PAT**——别放公共网盘，建议 `gpg -c fsrs_xxx.dump` 加密后再上传
- 不想把 PAT 打进备份：`pg_dump -U fsrs -Fc -T config fsrs > ...`（恢复后需重新输入 PAT）

## 3. 数据恢复

```bash
cd /opt/fsrs
docker compose stop app                          # 停 app，避免恢复时写入
docker exec -i fsrs-postgres pg_restore -U fsrs -d fsrs --clean --if-exists < fsrs_xxx.dump
docker compose start app
```

> `--clean --if-exists` = 覆盖式恢复（先删现有对象再重建）。明文 `.sql` 的话把 `pg_restore` 换成 `psql -U fsrs -d fsrs`。

## 4. 日志与排障

### 4.1 常用命令

```bash
docker compose logs -f app          # 看 app 日志
docker compose logs postgres        # 看数据库日志
docker compose ps                   # 容器状态
docker volume ls                    # 数据卷
```

### 4.2 常见问题

| 现象 | 原因 / 处理 |
|---|---|
| `docker compose pull` 报 401 | 私有镜像未登录 → 阶段 6.5 的 `docker login ghcr.io` |
| app 启动即退出，日志见 `tsx --env-file=.env` 报错 | 容器内缺 `.env` → 确认 Dockerfile 有 `RUN : > /app/.env` |
| 连接 postgres 失败 | 等 postgres healthcheck 变 healthy 再起 app；或 `docker compose up -d postgres` 先 |
| 迁移报错 | 看迁移日志具体表/列；确认镜像是最新（`docker compose pull`） |
| 登录失败 | 检查 `APP_PASSWORD` / `SESSION_SECRET` 是否与 `.env` 一致 |
| 同步失败 401/403 | Logseq PAT 失效 → 全局设置重新配 token |
| 同步 500，日志见 `logseq_uuid` 唯一约束冲突 | 已知 bug：Logseq 删掉后恢复的卡片会撞唯一索引。恢复方式：手动到数据库把该 `notes` 行 `deleted=false`，或等代码修复 |
| 端口被占 | `docker compose down && docker compose up -d`，或改 `ports` 映射 |

### 4.3 重置数据（危险）

```bash
# 删除数据卷（会清空所有复习进度 + deck，内容可从 Logseq 重同步）
docker compose down
docker volume rm fsrs_postgres_data
docker compose up -d
```

## 5. 建议的运维周期

1. ✅ cron 每天 4 点 `pg_dump` 到 `/opt/fsrs/backups`（保留 7 天）
2. ✅ 每周拉一份到本地或云端（可选加密）
3. ✅ 内容可从 Logseq 重同步，所以**只要保住最近的 `.dump`，复习进度就安全**
