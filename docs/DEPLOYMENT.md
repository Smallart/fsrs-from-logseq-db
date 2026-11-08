# 部署指南

源码推上 GitHub → Actions 自动构建镜像 → **双推**（华为云 SWR 主 + ghcr 备份）→ VPS 从 **SWR** 拉取运行。

> **为什么用 SWR 不用 ghcr 直连**：见 §2「问题与解决」。一句话——国内 VPS 直连 ghcr.io 极慢/不通，SWR 在国内，拉取飞快。

## 1. 架构总览

```
本地 git push ──▶ GitHub 仓库 ──▶ GitHub Actions（build + 双推）
                                    ├──▶ 华为云 SWR（主，VPS 从这里拉）
                                    └──▶ ghcr.io（备份，SWR 故障时切换）
                                              │
                              docker compose pull（从 SWR）
                                              ▼
                VPS：fsrs-app（Next.js + FSRS） + fsrs-postgres（数据卷 postgres_data）
```

- 镜像**无任何密钥**；密钥（DB 密码/登录密码/session 密钥/Logseq token）全在服务器 `.env`，运行时注入
- app 容器启动时自动执行数据库迁移
- 应用日志持久化到 `/opt/fsrs/logs/`（按天分文件，保留 14 天）

## 2. 问题与解决：为什么不直接拉 ghcr 镜像

**问题**：GitHub Actions 构建的镜像默认推 ghcr.io。但国内 VPS **直连 ghcr.io 经常超时或极慢**（实测约 50KB/s，200MB 要 1 小时+）；Docker 镜像加速器**只代理 Docker Hub（docker.io），不代理 ghcr.io**，帮不上忙。

**尝试过的方案**：

| 方案 | 结果 |
|---|---|
| 国内镜像加速器（registry-mirrors） | ❌ 只对 docker.io 有效，ghcr 无效 |
| ghcr 代理站（1ms/DaoCloud 等） | ⚠ 时效不稳，可用性没保障 |
| 离线 `docker save`/`load` 传镜像 | ✅ 能用，但要手动、每次更新都传 |
| **华为云 SWR 作主仓库** | ✅ **国内仓库，VPS 拉取秒级** |

**最终方案（推荐）**：工作流**同时推 SWR + ghcr**（双保险）。服务器固定从 **SWR** 拉（快）；ghcr 那份是备份，SWR 故障时把 compose 的 `image:` 切回 ghcr 即可。

## 3. 前置准备

| 位置 | 需要 |
|---|---|
| 华为云 | 账号；SWR 已建**组织**；**AK/SK**；「长期有效登录指令」的**密码** |
| GitHub | 一个空仓库（`fsrs-from-logseq-db`）；**3 个 Secrets**（见 §4） |
| 本地 | `git` |
| 服务器 | Ubuntu/Debian，公网 IP，**放行 8790**（安全组 + 系统防火墙） |

## 4. GitHub Secrets（仓库 → Settings → Secrets and variables → Actions）

| Name | 值 |
|---|---|
| `HUAWEI_SECRET_ACCESS_KEY` | 华为云 AK |
| `HUAWEI_SECRET_SECRET_KEY` | 华为云 SK（备用，工作流主要用 AK + 登录密码） |
| `HUAWEI_DOCKER_SECRET` | SWR「长期有效登录指令」里 `-p` 后面的密码 |

> ghcr 用 `GITHUB_TOKEN`，自动有，**不用配**。

## 5. 工作流（`.github/workflows/docker.yml`）

`push` 到 `main` 或手动触发，构建一次、双推。**只需改顶部两个值**：

```yaml
env:
  REGION: cn-south-1     # ← 你的 SWR 区域 ID
  ORG: smallar           # ← 你的 SWR 组织名称
  IMAGE: fsrs-from-logseq-db
  TAG: latest
```

流程：build（GitHub runner 用 npmjs 源）→ 登录 SWR（AK + 登录密码）→ 推 SWR → 登录 ghcr（GITHUB_TOKEN）→ 推 ghcr（`:latest` + `:sha-<commit>`）。

> 历史坑（已修，供参考）：
> - 缺 `id: meta` 导致 `docker buildx` 无 tag → 已加
> - SWR 登录密码含空格未加引号 → 已加引号
> - `github.repository` 保留大写 `Smallart`，Docker 仓库名必须小写 → 已用 `tr` 转小写

## 6. 本地推送

```powershell
git init
git add .
git commit -m "init: FSRS review app"
git remote add origin git@github.com:<你的用户名>/fsrs-from-logseq-db.git
git push -u origin main
```

> `.gitignore` 排除 `.env`；`.dockerignore` 排除 `.env`/`node_modules`/`.next`/`logs`，镜像无密钥。

## 7. 服务器部署

```bash
# 7.1 装 Docker
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER && newgrp docker

# 7.2 部署目录 + 拷 compose
sudo mkdir -p /opt/fsrs && cd /opt/fsrs
# 本地：scp docker-compose.yml <用户>@<服务器IP>:/opt/fsrs/
```

**7.3 `.env`**（compose 自动读取）：

```bash
cat > /opt/fsrs/.env << 'EOF'
POSTGRES_USER=fsrs
POSTGRES_PASSWORD=<openssl rand -base64 24>
POSTGRES_DB=fsrs
APP_PASSWORD=<你的登录密码>
SESSION_SECRET=<openssl rand -base64 32>
EOF
```

> `DATABASE_URL` 不用写，compose 内部拼好注入。
> Logseq 相关配置不再走环境变量：卡片数据经 **logseq-cli2http 网关** 读写，
> 网关 URL 在应用「全局设置」页配置（存 `config` 表）。
> Docker 内访问宿主机上的网关：`http://host.docker.internal:3000`
> （compose 已加 `extra_hosts: host.docker.internal:host-gateway`；网关 HOST 需为 `0.0.0.0`）。

**7.4 数据卷挂载（关键，postgres 18）**：compose 里 postgres 卷必须挂 **`postgres_data:/var/lib/postgresql`**（父目录）。挂旧的 `/var/lib/postgresql/data` 会触发 `unused mount/volume` 启动失败（即使卷空）。

**7.5 SWR 拉取认证**（SWR 仓库默认私有）：

```bash
docker login -u "cn-south-1@你的AK" -p "你的SWR登录密码" swr.cn-south-1.myhuaweicloud.com
```

> 或在 SWR 控制台把 `fsrs-from-logseq-db` 仓库设为**公开**，免登录。

**7.6 拉取 + 启动**：

```bash
docker compose pull
docker compose up -d
docker compose logs -f app      # 等迁移 + Ready
```

**7.7 防火墙**：

```bash
sudo ufw allow 8790/tcp
# 云安全组入方向也放行 TCP 8790
```

## 8. 验证

浏览器访问 `http://<服务器IP>:8790` → `APP_PASSWORD` 登录 → 全局设置填**网关 URL**（logseq-cli2http 地址，如 `http://host.docker.internal:3000`）→ 同步 → deck 列表（deck 由卡片 tag 自动生成）。

日志：`tail -f /opt/fsrs/logs/app-$(date +%F).log`（同步/复习等操作+结果都记录）。

## 9. 日常更新

```powershell
# 本地：改代码 → 提交 → 推送（触发 Actions 重建）
git add . && git commit -m "..." && git push
# 若 compose 有改动，先同步：
scp docker-compose.yml <用户>@<服务器IP>:/opt/fsrs/
```
```bash
# 服务器：等 Actions 变绿后
cd /opt/fsrs && docker compose pull && docker compose up -d
docker compose logs -f app
```

> 没有 `pull_policy: always`，**必须显式 `docker compose pull`**。

## 10. 常用排障

| 现象 | 处理 |
|---|---|
| `docker compose pull` 401 | 未登录 SWR（7.5）或登录密码过期 → 重新生成登录指令 |
| postgres 启动报 `unused mount/volume` | 卷挂载点不是 `/var/lib/postgresql` → 改 compose（7.4） |
| postgres `data directory incompatible` | 旧 16 卷 → 清卷重建（全新部署无数据时） |
| app 同步失败 | `docker compose logs` 或 `/opt/fsrs/logs/*.log` 看 `sync failed` 的 `message` |
| 端口被占 | `docker compose down && docker compose up -d` |
