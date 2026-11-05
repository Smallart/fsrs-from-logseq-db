# 部署指南

把源码推上 GitHub，Actions 自动构建 Docker 镜像推到 ghcr.io，VPS 拉镜像运行。

## 1. 架构总览

```
本地 git push ──▶ GitHub 仓库 ──▶ GitHub Actions（build + push 镜像）
                                       │
                                       ▼
                        ghcr.io/<用户名>/fsrs-from-logseq-db:latest
                                       │  docker compose pull
                                       ▼
                    VPS：fsrs-app 容器（Next.js + FSRS）
                        fsrs-postgres 容器（数据卷 postgres_data）
```

- 源码上传 GitHub；镜像推 ghcr.io；**镜像内无任何密钥**
- 密钥（数据库密码、登录密码、session 密钥、Logseq token）全部在服务器 `.env`，运行时注入
- app 容器启动时自动执行数据库迁移

## 2. 前置准备

| 位置 | 需要 |
|---|---|
| 本地 | `git`，一个 GitHub 账号 |
| GitHub | 一个空仓库（推荐名 `fsrs-from-logseq-db`） |
| 服务器 | Ubuntu/Debian，公网 IP，**防火墙放行 8790**（云安全组 + 系统防火墙） |

## 3. 修改镜像地址（重要）

`docker-compose.yml` 里镜像名现在是占位符，**改成你的真实 GitHub 用户名**：

```yaml
app:
  image: ghcr.io/YOUR_USERNAME/fsrs-from-logseq-db:latest   # ← 替换 YOUR_USERNAME
  pull_policy: always
```

> 这一步在本地改好再推送；服务器部署时会把这份（已改好的）compose 拷过去。

## 4. 本地推送

```powershell
# 4.1 建仓库 + 首次提交
git init
git add .
git commit -m "init: FSRS review app with tag decks"

# 4.2 在 GitHub 建空仓库（二选一）
#     A. 网页：github.com → New repository → 名 fsrs-from-logseq-db → 不勾 README → Create
#     B. 命令行（已装 gh）：gh repo create fsrs-from-logseq-db --private --source . --remote origin --push
#        —— 用 B 的话，下面 4.3 / 4.4 跳过

# 4.3 关联远程
git remote add origin git@github.com:<你的用户名>/fsrs-from-logseq-db.git

# 4.4 首次推送
git push -u origin main
```

> `.gitignore` 已排除 `.env`，密码/token 不会上传；`.dockerignore` 也排除 `.env`，镜像里同样没有密钥。

## 5. Actions 自动构建（push 后自动发生）

1. 打开仓库 **Actions** 标签页 → 看到 `build` 工作流在跑
2. 点进去看进度（约 3–6 分钟），出现绿色对勾即成功
3. 成功后右侧 **Packages** 里出现 `fsrs-from-logseq-db`，`:latest` 可用
4. 失败则点进日志看红字（最常见：类型错误、Dockerfile 问题）
5. 也可在 Actions 页点 **Run workflow** 手动触发

## 6. 服务器部署

```bash
# 6.1 装 Docker（Ubuntu/Debian 一键脚本）
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER
newgrp docker        # 或重新登录，让 docker 组生效

# 6.2 部署目录
sudo mkdir -p /opt/fsrs && cd /opt/fsrs

# 6.3 把项目里的 docker-compose.yml（已含真实用户名）拷到服务器
#     本地执行：scp docker-compose.yml <用户>@<服务器IP>:/opt/fsrs/
#     或直接在服务器 vim 粘贴该文件
```

**6.4 创建 `/opt/fsrs/.env`**（compose 自动读取同目录 `.env`）：

```bash
cat > /opt/fsrs/.env << 'EOF'
POSTGRES_USER=fsrs
POSTGRES_PASSWORD=<openssl rand -base64 24>   # 生成强密码填入
POSTGRES_DB=fsrs
APP_PASSWORD=<你的登录密码>
SESSION_SECRET=<openssl rand -base64 32>      # 生成强随机填入
LOGSEQ_API_BASE=http://110.41.171.187:8789
EOF
```

> **`DATABASE_URL` 不用写**——compose 内部用 `POSTGRES_USER/PASSWORD/DB` 拼好注入 app 容器。

**6.5 拉取镜像的认证**（ghcr 新包默认私有，不认证 `docker compose pull` 会报 401）。

> 关键认知：**仓库公开 ≠ 镜像包公开**。包有独立的可见性设置，新包默认 private，不管仓库是否公开。二选一：

**方式 A：把包设为公开（最简单，仓库公开时推荐）**

1. GitHub → 仓库右侧 **Packages** → 点进 `fsrs-from-logseq-db` → **Package settings** → **Change visibility** → **Public**
   - 直达：`https://github.com/users/Smallart/packages/container/package/fsrs-from-logseq-db`
2. 之后服务器**无需任何登录**，直接 `docker compose pull`

**方式 B：保持私有镜像 → 用 classic PAT 登录**

1. 建 PAT：`https://github.com/settings/tokens` → **Generate new token (classic)** → 只勾 **`read:packages`** → Generate
   - 注意：用 **classic** token，**不要**用 fine-grained（它的 `Packages` 权限对 ghcr 支持不稳定）
2. 服务器登录：
   ```bash
   echo <你的PAT> | docker login ghcr.io -u Smallart --password-stdin
   ```

> 镜像里没有任何密钥，包公开无泄露风险；想严格私有就选方式 B。

**6.6 拉取 + 启动**：

```bash
docker compose pull
docker compose up -d          # postgres 先健康，app 再启动（自动跑迁移）
docker compose logs -f app    # 看到迁移成功 + Next.js Ready 即完成，Ctrl+C 退出
```

**6.7 防火墙放行 8790**：

```bash
sudo ufw allow 8790/tcp       # Ubuntu 防火墙（若有）
# 另外：云厂商安全组入方向规则也要放行 8790（TCP）
```

## 7. 验证

浏览器访问 `http://<服务器IP>:8790` → 用 `APP_PASSWORD` 登录 → 首页应显示 deck 列表。
若首次部署，先到全局设置配 Logseq PAT + graphId，再同步拉取卡片。

## 8. 日常更新

```bash
# 本地：改代码 → 提交 → 推送
git add . && git commit -m "..." && git push

# 服务器：拉新镜像 + 重启
cd /opt/fsrs && docker compose pull && docker compose up -d
```

> `pull_policy: always` 下 `docker compose up -d` 本身会尝试拉取；显式 `pull` 更稳。
