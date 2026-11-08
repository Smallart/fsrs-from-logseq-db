# 卡片同步数据流（网关 → 应用）

本应用是 **web-fsrs 客户端**：Logseq DB 的 block `card_params` 是唯一事实源，应用经 **logseq-cli2http 网关**读写，本地 PostgreSQL 只做缓存/工作集。完整架构与同步协议见 `docs/WEB_FSRS_INTEGRATION.md`；本文聚焦**数据本身**：网关返回什么格式、应用怎么解析入库、表结构长什么样。

## 1. 数据流全景

```
Logseq DB (card_params，唯一事实源)
        ▲ 读写
  logseq CLI ←─ logseq-cli2http 网关 (RESTful)
                      │  GET /api/decks            #Cards 查询块 + 成员 dbIds
                      │  GET /api/cards            全量 FlatCard[]
                      │  GET /api/cards/:dbId      单卡（含 answer）
                      │  POST /api/cards/:dbId/state  写回 card_params
                      ▼
  本应用 (PG 缓存)：PULL → deck 镜像 → merge → PUSH
        notes  = FlatCard 内容（无 answer）
        cards  = TsFsrsCard 状态（camelCase 镜像）
        decks  = 由 #Cards 查询块定义（锚点 = 块 uuid）
```

| 层 | 文件 | 职责 |
|---|---|---|
| 网关客户端 | `src/server/libs/gateway.ts` | 四端点封装（含 fetchDeckDefs）、FlatCard/TsFsrsCard 规范化（NaN→0）、409 冲突解析 |
| 同步引擎 | `src/server/services/sync/index.ts` | PULL（deck 定义 + 全量卡）→ deck 镜像 → merge（lastReview 仲裁）→ PUSH（补推 dirty） |
| 调度器 | `src/server/services/scheduler/index.ts` | 取卡算法；复习 = 应用算 → PG → **立即推网关**；撤销 = rollback → **force 推网关** |
| 存储 | `src/server/models/index.ts` + 迁移 `logs/20261108_deck_anchors.ts` | 表结构镜像网关格式（camelCase） |

## 2. 网关返回的数据格式

**`FlatCard`**（每张卡，批量接口 `answer` 恒为 `[]`）：

```jsonc
{
  "id": "ce62...",            // block UUID ←→ notes.logseq_uuid（对账锚点）
  "dbId": 841,                // block db/id ★ 单卡/写回接口用这个
  "question": "...",          // 正面
  "answer": [],              // 批量恒 []；单卡接口才填充子块标题
  "deck": "Dictionary-Item", // 第一个非内置 tag 名（内容参考，不再定义 deck）
  "pageId": 12, "parentId": null,
  "tags": ["Card", "Dictionary-Item"],
  "properties": { ... },      // 自定义属性（除 fsrs 外）
  "card": { /* TsFsrsCard ↓ */ },
  "cardSource": "card_params", // card_params | fsrs-legacy | default
  "createdAt": 1794..., "updatedAt": 1794...  // 毫秒，updatedAt=内容变更提示
}
```

**`DeckDef`**（`GET /api/decks`，每个 `#Cards` 查询块一个）：

```jsonc
{
  "blockId": 11241,             // #Cards 查询块 db/id
  "uuid": "6aed4d9c-…",         // 查询块 uuid ★ decks.anchorUuid（稳定锚点）
  "name": "Opencode v2",        // deck 名 = 查询块 title
  "dsl": "(tags [[6aed4d57-…]])", // 原始查询 DSL
  "memberDbIds": [7698, 7706, …], // 该 deck 的卡片块 db/id（已限定为卡片）
  "dslOk": true                 // false = DSL 无法解析 → 空成员
}
```

**`TsFsrsCard`**（FSRS 状态，插件 camelCase 格式）：

```jsonc
{
  "state": 2,              // 0 new / 1 learning / 2 review / 3 relearning
  "due": 1795918306625,    // 毫秒
  "stability": 21.02,      // 天
  "difficulty": 1,         // 1–10
  "lastReview": 1794017506625, // ★ lastReview 仲裁键（最新者赢）
  "learningSteps": 0, "priorState": 2,   // 插件扩展（ts-fsrs 4.5 核心无）
  "elapsedDays": 0, "scheduledDays": 22,
  "reps": 1, "lapses": 0, "lastRating": 3
}
```

**写回格式**：`POST /api/cards/:dbId/state` body = `{ card: TsFsrsCard, base: lastReview|null, force?: bool }`；网关先重读 block，`lastReview` 比 base 新 → **409 + current**（推送方刷新重算）；`force: true` 跳过冲突检查（仅撤销用）。

## 3. 同步步骤（`sync()`）

```
① PULL   GET /api/decks → #Cards 查询块 + memberDbIds
         GET /api/cards → 全量 FlatCard[]（网关无增量 API，每次都是全量）
         （两调用顺序执行，网关 CLI 并发会竞争 db-worker）
② decks  按查询块 uuid 镜像 deck：
         - 新 uuid → INSERT deck（name = 查询块 title）
         - 改名 → 更新 name（设置保留，锚点是 uuid）
         - 查询块消失 → 软删 deck
         - 卡片成员 = 该查询块的 memberDbIds（+ 虚拟 All deck）
③ merge  逐卡（lastReview 仲裁，最新者赢）：
         - 本地无 → INSERT notes + cards + note_decks
         - 本地有：
           · 内容（question/tags/updatedAt…）无条件跟随网关
           · 网关 lastReview > 本地 → 覆盖 cards（dirty=false）
           · 本地较新（有未推送复习）→ 保留，等 PUSH
         - 本地有但网关无 → 软删（卡在 Logseq 删了）
④ PUSH   对 dirty 卡：重读网关单卡 → 本地更新则推（base=网关当前值）
         → 200 清 dirty；409 用网关版覆盖；失败保留 dirty 下次再试
⑤ 更新 sync_meta
```

## 4. 表结构（camelCase 镜像网关）

### `notes` = FlatCard（**无 answer**）
| 列 | 说明 |
|---|---|
| id / did | PK / 主 deck |
| `logseq_uuid` UNIQUE | block UUID（对账锚点） |
| `dbId` | block db/id（单卡/写回接口用） |
| question | 正面 |
| deck | 第一个非内置 tag 名 |
| pageId / parentId | 所属页 / 父块 |
| tags (jsonb) / properties (jsonb) | tag 列表 / 自定义属性 |
| `cardSource` | card_params / fsrs-legacy / default |
| createdAt / updatedAt | block 创建/更新时间（ms） |
| deleted / created / updated | 软删 / 行时间戳 |

### `cards` = TsFsrsCard
| 列 | 说明 |
|---|---|
| id / did / nid | PK（复习接口的 cid）/ deck / note |
| state / due / stability / difficulty | 调度状态 |
| `lastReview` | ★ 仲裁键 |
| learningSteps / priorState | 插件扩展 |
| elapsedDays / scheduledDays / reps / lapses / lastRating | 计数 |
| `cardSource` | 状态来源 |
| `dirty` | 本地复习待推送标记（PUSH 用） |
| suspended / deleted / created / updated | 本地簿记 |

### 配套表
- **`decks`**：name / `anchorUuid`（#Cards 查询块 uuid，稳定锚点）/ deskName / fsrs(jsonb) / cardLimit(jsonb) / pDue——**deck 由 #Cards 查询块定义，不能手动创建**
- **`note_decks`**：(nid, did) UNIQUE，deleted=从该 deck 排除
- **`revlog`**：撤销用评分前快照（elapsedDays/lastElapsedDays/scheduledDays…camelCase）
- **`config`**：`gatewayUrl`（单行 id=1）
- **`sync_meta`**：last_sync_at / last_full_check_at

## 5. 复习/撤销的数据流

```
复习（应用算）：
  读 PG 基数 → ts-fsrs next → PG(dirty=true) + revlog
  → POST 网关 state（base=基数 lastReview）
  → 200 清 dirty；409 用网关 current 覆盖 PG；网关不可达保留 dirty

显示答案（answer 不存表）：
  GET /api/cards/:cid/detail → 网关单卡 → question + answer + 最新状态
  （网关状态较新时顺手 merge 进 PG）

撤销（用户显式意图）：
  fsrs.rollback → PG + revlog 软删 → force 推网关（跳过冲突检查）
```

## 6. 关键设计点

1. **answer 永不落库**——复习时经网关单卡接口动态请求（§4.5），卡面永远最新
2. **lastReview 仲裁**——所有写回前重读比较，最新者赢，绝不盲写（§4.1）
3. **deck 由 `#Cards` 查询块定义**——Logseq 里每个 `#Cards` 块是一个 deck（块 title 是 deck 名，块查询 DSL 决定成员）；应用只镜像，不能手动建/删；All 是虚拟 deck
4. **deck 锚点 = 查询块 uuid**——改名/编辑 Logseq 块不影响应用侧 deck 设置（fsrs 参数等），锚点稳定
5. **内容跟随网关、状态仲裁**——question/tags 无条件用网关版；FSRS 状态只在 lastReview 更新时覆盖
6. **updatedAt 双关**——FSRS 写回也会更新 block 的 updatedAt，故内容判断以 updatedAt + question 对比（§4.3 已知限制）
7. **fsrs-legacy 兼容**——旧属性卡（无 card_params）照常拉取入库；应用复习写回后升级为 card_params（桌面 enhance 插件接管）
