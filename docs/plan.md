# FSRS from Logseq DB — 方案存档

> 从 Logseq DB 语义 API 拉取 `#card` 卡片，在独立应用里做 FSRS 复习调度。
> Logseq 仅作数据源（只读），FSRS 状态由应用独占维护。

## 一、架构

```
手机浏览器 ─ http://110.41.171.187:8790 ─> Next.js + PostgreSQL (Docker Compose)
   │ 登录：密码 + httpOnly cookie（密码存 Docker env）
   ▼
后端持有 Bearer logseq_pat_xxx（存 config 表）
   ▼
Logseq 语义 API (110.41.171.187:8789)
```

## 二、技术栈

- **Next.js**（App Router，TypeScript）
- **kysely** + **PostgreSQL 16**（Docker `postgres:16`）
- **ts-fsrs**（FSRS 算法 + `rollback()` undo）
- **迁移**：kysely `FileMigrationProvider`，`up()`/`down()` 可回退
- **部署**：Docker Compose（app + postgres），端口 8790，HTTP 非 PWA（域名需备案，放弃 PWA）

## 三、数据模型

```
decks     id, name('All'), fsrs jsonb, card_limit jsonb, deleted, created, updated
notes     id, did, logseq_uuid UNIQUE, page_id, question, answer(json),
          content_hash, source, deleted, created, updated
cards     id, did, nid, due, stability, difficulty, elapsed_days,
          scheduled_days, reps, lapses, state, last_review,
          suspended, deleted, created, updated
revlog    id, did, nid, cid, grade, state, due, stability, difficulty,
          elapsed_days, last_elapsed_days, scheduled_days, review,
          duration, deleted, offset
config    token, graph_id                    ← 后端存 Logseq 凭证
sync_meta last_sync_at, last_full_check_at  ← 定时/兜底判断
```

- **Anki 式三层**：`notes`（内容）→ `cards`（FSRS 状态）→ `revlog`（复习日志，存评分后状态）
- **FSRS 参数**：进 `decks.fsrs` jsonb（per-deck 独立一套）
- **每日上限**：进 `decks.card_limit` jsonb（`{new, review, learning}`）
- **凭证分工**：Logseq 凭证（token + graph_id）→ 后端 `config` 表；应用登录密码 → Docker env（httpOnly cookie）

## 四、核心逻辑

### 1. 卡片解析（只读）
```
cardBlock = getBlock(uuid)
front = cardBlock.title                      ← 问题
back  = cardBlock.children.map(c => c.title) ← 答案，JSON 数组
```
Logseq 卡片结构：`- 问题  #card` + `  - 答案1` + `  - 答案2`。应用不改内容。

### 2. 认证（Logseq）
- `Authorization: Bearer logseq_pat_xxx`（PAT token，用户从 sync-worker 程序获取）
- 后端持有，调 Logseq API

### 3. 同步引擎
```
每轮 sync（手动 / 进应用 / 每30分钟）：
  A. 索引全量 listTagObjects 翻页 → uuid 集合 U
     删除：本地 uuid ∉ U → deleted=1
  B. 内容增量 getBlock(新增 ∪ updated-after 候选) → content_hash 比对 → upsert
  C. 每天凌晨 3:00 全量兜底：对 U 全部 getBlock → 哈希比对修正漏检
```
- `updated-after` 可能漏纯子块变更（不更新父块 updated-at）→ 靠 C 每日全量兜底
- 后端自主定时（Node 异步任务，不阻塞主线程）

### 4. 取卡逻辑（3 盒 + 概率）
```
box_new      = state=New       AND due IS NULL          （新卡，每日上限 20）
box_learning = state IN (Learning, Relearning)          （学习中，Anki 式合并）
box_review   = state=Review    AND due <= 明天 3:00      （到期复习卡）

P1  box_learning 非空          → 取 Learning/Relearning（间隔短必须先清）
P2  box_review 有逾期(due<now) → 取 Review（清旧债）
P3  否则                        → random()<0.7 ? box_review : box_new
                                  （某盒空自动从另一盒取）
```
- 日界 = 凌晨 3:00（FSRS 日界 + 全量兜底触发时刻）
- 新卡上限 20/天（默认，`card_limit.new` 可配）
- 概率 p_due = 0.7（默认，可配）
- Learning/Relearning 间隔由 ts-fsrs 自动算

### 5. 复习
```
取下一张（按 P1/P2/P3）
→ 显示 front → 点按钮翻面 → 显示 back[0..n]
→ 点 Again/Hard/Good/Easy
→ ts-fsrs fsrs.next(card, grade, now)
→ 更新 cards + 写 revlog（评分后状态）
→ 自动下一张
```

### 6. 撤回（undo）
```
undo(cid, lid):
  log = revlog[cid][lid]
  prev_card = fsrs.rollback(currentCard, log, cb)   ← ts-fsrs 内建反推评分前状态
  update cards ← prev_card
  revlog[lid].deleted = true
```
revlog 不存 prev_*，靠 `fsrs.rollback()` 精确反推。

## 五、前端（MVP）

- **复习页**：翻卡 + 评分 + 撤回（Ctrl+Z）
- **设置页**：token / graph / FSRS 参数 / 上限 / 概率 / 同步按钮
- **登录页**：密码 + httpOnly cookie
- 列表/统计：后续加

## 六、应用结构

```
src/
  app/
    page.tsx              复习页
    settings/page.tsx     设置页
    login/page.tsx        登录页
    api/
      auth/...            登录/登出
      sync/...            触发同步 / 状态
      cards/next/...      取下一张
      cards/review/...    评分
      cards/undo/...      撤回
      config/...          读写配置
  server/
    libs/db.ts            kysely 实例
    libs/logseq.ts        Logseq API 客户端
    models/               kysely 表类型
    migrations/
      migrations.ts       Migrator（up/down/latest）
      logs/*.ts           迁移文件
    services/
      sync/               同步引擎
      scheduler/          取卡 + 复习 + 撤回
  types.ts
docker-compose.yml        app + postgres
Dockerfile
```

## 七、实施阶段

- **Phase 1**：Next.js + kysely + PG 骨架 + 迁移（可回退）+ Logseq 客户端 + 同步引擎
- **Phase 2**：复习页 + 设置页 + 登录 + FSRS 调度（取卡/评分/撤回）
- **Phase 3**：同步联调 + 部署到 110.41.171.187（Docker Compose）
- **后续**：卡片列表 / 统计 / 多 desk / desk 来源映射 Logseq 标签

## 八、双环境运行

### 本地 Windows（Node + 本地 PostgreSQL）
1. 安装 PostgreSQL 16（EnterpriseDB 安装包，默认端口 5432，记住 postgres 密码）
2. 建库：`CREATE DATABASE fsrs;`（pgAdmin / psql）
3. `Copy-Item .env.example .env`
4. `.env` 的 `DATABASE_URL=postgresql://postgres:<密码>@localhost:5432/fsrs`
5. `npm install`
6. `npm run migrate`（`--env-file=.env` 自动读配置）
7. `npm run dev` → http://localhost:3000

### VPS（Docker）
1. git 推送代码到 VPS
2. `docker compose up -d`（app + postgres，容器启动自动迁移建表）
3. 访问 http://110.41.171.187:8790

### 迁移自动执行
- 本地 `npm run dev` 与 VPS 容器启动时，`src/instrumentation.ts` 自动 `migrateToLatest`，无需手动跑迁移（build 阶段跳过）
- 手动迁移：`npm run migrate` / `npm run migrate:up` / `npm run migrate:down`（回退）

