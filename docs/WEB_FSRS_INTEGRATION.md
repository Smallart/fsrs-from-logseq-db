# web-fsrs 同步设计与 API 契约

> 本文档面向 **web-fsrs 应用**（移动端复习界面）的开发方。
> 目标：让 web-fsrs 与 Logseq 桌面端插件的 FSRS 复习状态保持一致，并给出当前网关服务 `logseq-cli2http` 提供的全部接口契约。
>
> 对应实现：`src/server.ts`（路由）、`src/service.ts`（拉取编排）、`src/convert.ts`（转换）、`src/cli.ts`（CLI 调用）。

---

## 1. 架构与背景

```
Logseq 桌面端 (fsrs 插件，写 FSRS 状态)      Logseq 移动端 (无插件，仅同步)
        │  selfhost-sync                          │  selfhost-sync
        ▼                                         ▼
        └─────────────► VPS Logseq DB ◄───────────┘   ← 事实源
                              │
                        VPS Logseq CLI  ← 读 / 写
                              │
                             logseq-cli2http 网关 (本文档的接口)
                              │
                             web-fsrs 应用 (有自身状态，需对账)
```

- **内容**（block/title、结构、自定义属性）：三端由 `logseq-selfhost-sync` 保持一致。
- **FSRS 状态**：桌面端插件和 web-fsrs **都是写入方**，写同一张卡，这是不一致的根源。
- **网关**：部署在 VPS，经 Logseq CLI 读/写 VPS 的 Logseq DB，是 web-fsrs 访问数据的唯一通道。

---

## 2. 核心问题：双写入方 + 同步延迟

单张卡的 FSRS 状态是一个**可覆盖的标量**。桌面插件与 web-fsrs 各自「读旧状态 → 算新状态 → 写」：

```
T1  卡C 状态 S1 (lastReview=T1)
T2  桌面复习 → 读 S1 → 算 S2 → 写卡        (VPS 收到 T2+Δ，Δ=同步延迟)
T3  web-fsrs 复习 → 若仍读到 S1 (因 Δ 未到) → 基于过期 S1 算 S3 → 写卡
     ⟹ 桌面 S2 被覆盖；且 S3 由过期基数算出，reps/stability 均错误
```

两类问题：**覆盖丢失** + **过期基数导致状态错误**。

---

## 3. 数据模型

### 3.1 卡片对象（`FlatCard`）

每个 `#Card` 类 block 转换成一个扁平对象：

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | string | Logseq block UUID（唯一键） |
| `dbId` | number \| null | Logseq db/id，**单卡接口用这个** |
| `question` | string | 卡片正面 = block title（**内容可被修改**） |
| `answer` | string[] | 卡片背面 = 子块 title 列表；批量接口恒为 `[]`，单卡接口动态查 |
| `deck` | string \| null | 第一个非内置类 tag 名（如 `Dictionary-Item`）；无则 `null` |
| `pageId` | number \| null | 所属页面 db/id |
| `parentId` | number \| null | 父块 db/id |
| `tags` | string[] | 全部 tag/类名（如 `["Card","Dictionary-Item"]`） |
| `properties` | object | 自定义 `*.property/*` 值（除 fsrs 插件字段外） |
| `card` | `TsFsrsCard` | FSRS 调度状态（见 3.2） |
| `cardSource` | string | `card_params` \| `fsrs-legacy` \| `default`（见 3.3） |
| `createdAt` / `updatedAt` | number \| null | block 创建/更新时间，**毫秒**；`updatedAt` 用于内容变更提示 |

### 3.2 FSRS 状态（`card` 字段，插件 camelCase 格式）

```jsonc
{
  "state": 2,             // 0 new / 1 learning / 2 review / 3 relearning
  "due": 1795918306625,   // 下次到期，毫秒
  "stability": 21.02452958,
  "difficulty": 1,        // 1–10
  "lastReview": 1794017506625,  // 上次复习时间，毫秒；新卡为 null
  "learningSteps": 0,
  "priorState": 2,
  "elapsedDays": 0,
  "scheduledDays": 22,
  "reps": 1,
  "lapses": 0,
  "lastRating": 3         // 1 again / 2 hard / 3 good / 4 easy
}
```

> **写回时 web-fsrs 也输出这个结构**（写回只写 `card` 的 JSON，见 §4.4）。

### 3.3 `cardSource`（状态来源）

| 值 | 来源 | 说明 |
|---|---|---|
| `card_params` | `card_params` 属性（JSON 字符串） | 完整 ts-fsrs 字段，**权威** |
| `fsrs-legacy` | 旧版分散字段（`fsrs_stability` 等） | 旧插件写的；缺 `reps/lapses/elapsedDays/scheduledDays`，填 0 |
| `default` | 无任何 FSRS 属性 | 新卡：`state:0`，其余 0/null |

**优先级链**：`card_params` → `fsrs-legacy` → `default`。不合并（`card_params` 是超集）。

---

## 4. 同步协议

### 4.1 三条原则

1. **Logseq DB 是唯一事实源**（对 `card_params`），web-fsrs 只做本地缓存/工作集。
2. **冲突仲裁键 = `lastReview`（逻辑时钟）**：谁的复习时间更新谁赢。
3. **写回必须「读-改-写」带冲突检测，先 PULL 后 PUSH，绝不盲写。**

### 4.2 同步顺序：PULL → merge → PUSH

```
① PULL    GET /api/decks  → deck 定义（#Cards 查询块 + memberDbIds）
          GET /api/cards  → DB 全量快照 (card.id → card)
          （两个调用顺序执行：网关每次调用都要起 CLI，并发会竞争 db-worker）
② decks   deck 镜像：按查询块 uuid 建/改名/软删 deck；卡片按 memberDbIds
          归入对应 deck（+ 虚拟 All deck）；deck 全部在 Logseq 里定义，
          应用不创建/删除 deck
③ merge   逐卡比较 lastReview:
            DB.lastReview  > Local.lastReview → 用 DB 版覆盖 Local（桌面先复习）
            Local.lastReview > DB.lastReview → 保留 Local，标记 dirty（待推送）
            相等 / 都 null → 内容以 DB 为准；状态有差异以 DB 为准（DB 是事实源）
            Local 有但 DB 无 → 卡已删/移除 #card → 软删 Local（不推送）
            DB 有但 Local 无 → 新卡，加入 Local
④ PUSH    只推 dirty，只写 card_params:
            for each dirty card:
              a. 重读该卡 DB 当前状态 (GET /api/cards/:dbId)
              b. 若 DB.lastReview > Local.lastReview → 冲突：丢弃推送，
                 用 DB 版覆盖 Local（桌面赢了，或按产品需求提示/REBASE）
              c. 否则写回 → POST /api/cards/:id/state（见 §4.4）
              d. 成功 → 清 dirty；失败 → 保留 dirty 下次重试
```

**触发时机**：启动时全量对账；每次复习后更新 Local 并标记 dirty、批量推送；周期性（如 30s）增量拉取保持与桌面同步。

### 4.3 内容变更（question/title 修改）

- `updatedAt` 是提示：未变 → 内容未动，跳过比较；变了 → 比较 `question`（及 `deck`/`tags`/`properties`）。
- **内容以 DB 为准**（web-fsrs 不编辑内容）。
- **内容变更不重置复习进度**：question 变了 → 更新 Local 内容，**保留 Local.card**（除非 `lastReview` 仲裁表明 DB 状态更新）。
- 注意：`updatedAt` 在 FSRS 状态写回时也会更新，不能单独区分「内容变」vs「状态变」。

### 4.4 写回（web-fsrs 端）

- **只写 `card_params`**（单一 JSON），桌面插件改造为优先读它——实现单点写源。
- 写回 body 为 §3.2 的 `card` 结构（camelCase），网关转成 JSON 字符串写入 `card_params` 属性。
- 写回前**必须重读**（`GET /api/cards/:dbId`）做 `lastReview` 冲突检查（③b）。

### 4.5 复习时的动态取卡

- 批量接口**不返回 children**（`answer: []`），web-fsrs 本地**不维护子块**。
- 复习时调 `GET /api/cards/:dbId` 一次性拿**最新 question + answer + FSRS 状态**，避免复习到旧内容。

### 4.6 前提与约束

- **桌面插件与 web-fsrs 必须用同一套 FSRS 参数**（`w`、`request_retention`、`maximum_interval`、`enable_fuzz`），否则同基数同评分也会算出不同状态。
- **时钟偏差**：`lastReview` 来自不同设备，秒级偏差可接受（复习间隔分钟级）；更稳的做法是写回时统一用 VPS 服务器时间。

---

## 5. API 契约（当前网关提供）

Base URL 由部署环境决定（默认 `http://127.0.0.1:3000`）。所有时间均为**毫秒**。

### 5.1 `GET /healthz`

```jsonc
// 200
{ "status": "ok" }
```

### 5.2 `GET /api/cards` —— 批量拉取全部卡（无 children）

```jsonc
// 200
{
  "status": "ok",
  "data": {
    "count": 1689,
    "cards": [ /* FlatCard[]，见 §3.1，answer 恒为 [] */ ],
    "meta": {
      "graph": "E-Garden",
      "tookMs": 2635,                 // 本次 CLI 拉取+转换耗时
      "queriedAt": 1794040000000,     // 服务器时间
      "sources": { "card_params": 1, "fsrs-legacy": 727, "default": 961 }
    }
  }
}
```

用于：对账 ①PULL。

### 5.2a `GET /api/decks` —— deck 定义（`#Cards` 查询块）

deck **在 Logseq 图里定义**：每个打了内置 `#Cards` 类（`logseq.class/Cards`，extends `#Query`）
的查询块就是一个 deck——块的 `logseq.property/query` 指向另一个块，其 title 是 Logseq
查询 DSL，定义该 deck 的成员。网关解析 DSL 并翻译成 datalog 执行，结果**限定为卡片块**
（`logseq.class/Card`）后作为 `memberDbIds` 返回。

支持的 DSL 形式（`and` 组合 = 各 clause 结果交集）：
- `(property :key "value")` — 属性值通常是实体 ref（两跳 `?v :block/title "value"`），
  退化为普通字符串属性时直接匹配；两种形式结果取并集
- `(tags [[uuid] [uuid]])` — 先将 uuid 解析为 tag 实体 db/id，再按 `block/tags` 匹配

```jsonc
// 200
{
  "status": "ok",
  "data": {
    "count": 2,
    "decks": [
      {
        "blockId": 11241,          // #Cards 查询块自身的 db/id
        "uuid": "6aed4d9c-…",      // 查询块 uuid —— 应用侧 deck 的稳定锚点
        "name": "Opencode v2",     // deck 名 = 查询块 title
        "dsl": "(tags [[6aed4d57-…]])", // 原始 DSL（诊断用）
        "memberDbIds": [7698, 7706, …],  // 成员卡片块的 db/id
        "dslOk": true              // false = DSL 无法解析/执行 → 空成员
      }
    ],
    "meta": { "graph": "E-Garden", "tookMs": 2607, "queriedAt": 1794040000000 }
  }
}
```

用于：deck 镜像（应用建/改名/删 deck、写 note_decks 成员）。改名（title 变化）时
`uuid` 不变 → 应用侧 deck 设置（fsrs 参数等）得以保留。DSL 无法识别的 deck 以
`dslOk: false` 返回空成员，**不**导致整个请求失败。

### 5.3 `GET /api/cards/:dbId` —— 单卡（含最新 content + answer + 状态）

```jsonc
// 200 —— dbId 为 Logseq db/id（正整数）
{
  "status": "ok",
  "data": {
    "card": {
      /* FlatCard，answer 已填充为子块 title 列表 */
      "id": "ce62618e-0772-428c-8d9d-f68e5f9d4814",
      "dbId": 841,
      "question": "{{cloze nervous}} `/ˈnɜːrvəs/` - adj. worried or afraid about something",
      "answer": ["nervous", "I was really nervous before my presentation."],
      "deck": "Dictionary-Item",
      "card": { /* §3.2 */ },
      "cardSource": "card_params",
      "updatedAt": 1794017511536
    }
  }
}

// 404 —— dbId 不存在或不是卡
{ "status": "error", "error": { "code": "card_not_found", "message": "card db/id 999999 not found in graph" } }

// 400 —— dbId 非正整数
{ "status": "error", "error": { "code": "invalid_db_id", "message": "invalid db/id: \"abc\" (expected a positive integer)" } }
```

用于：复习时动态取卡（§4.5）、推送前重读冲突检查（③a）。

### 5.4 `POST /api/cards/:dbId/state` —— 写回 FSRS 状态（复习后推送）

写该卡的 `card_params` 属性（fsrs-enhance 插件存储，camelCase JSON），**带 last-write-wins 冲突检测**：先重读 block 当前状态，若其 `lastReview` 比 `base`（推送方计算时的基数）更新 → 409 并返回当前状态，推送方应刷新重算，绝不盲写覆盖。

```jsonc
// 请求 body
{
  "card": { /* §3.2 TsFsrsCard 完整结构 */ },
  "base": 1794017506625   // 推送方计算新状态时读到的 lastReview；新卡为 null
}

// 200 —— 已写入（card 为重读确认后的 block 当前状态）
{
  "status": "ok",
  "data": { "card": { /* §3.2 */ }, "updatedAt": 1794040000000 }
}

// 409 —— 冲突：block 的 lastReview 比 base 新（桌面端后复习了）
{
  "status": "error",
  "error": {
    "code": "card_state_conflict",
    "message": "stale push: block lastReview 1794999... is newer than base 1794017...",
    "current": { /* §3.2：当前 block 上的获胜状态 */ }
  }
}

// 400 —— body 不合法（缺 card / 字段非有限数）
{ "status": "error", "error": { "code": "invalid_state_body", "message": "..." } }

// 404 / 400 —— 同 §5.3（dbId 不存在 / 非正整数）
```

实现：网关经 CLI `upsert block --id <dbId> --update-properties <edn-map>` 写入，属性键用**全限定名** `:plugin.property.logseq-db-plugin-fsrs-enhance/card_params`（CLI 对含 `/` 的键原样使用），值为 card JSON 字符串——与桌面插件 `upsertBlockProperty` 写出的形状一致，插件下次读取即为本推送。

### 5.5 错误响应（通用）

```jsonc
// 502 —— CLI 非零退出；code 优先取 CLI 自身错误码
{
  "status": "error",
  "error": {
    "code": "graph-not-exists",   // 或 cli_error（解析不出 CLI 码时）
    "message": "logseq CLI error graph-not-exists: Graph is absent or stopped by deletion",
    "exitCode": 1,
    "stderr": "",
    "stdout": "{:status :error :error {:code :graph-not-exists :message \"…\"}}"
  }
}

// 500 —— 配置缺失 / EDN 解析失败 / 内部错误
{ "status": "error", "error": { "code": "config_error" | "edn_parse_error" | "internal_error", "message": "…" } }
```

**瞬态自动重试**：CLI 与桌面版共享 db-worker 生命周期，以下错误码（或消息含 `EPERM`）网关会自动重试 1 次（400ms）：`server-cleanup-failed`、`server-start-timeout-orphan`、`server-start-failed`、`server-owned-by-other`。

---

## 6. web-fsrs 端职责清单

1. **本地存储**：`card.id → { content 字段, card(§3.2), dirty 标志 }`；`deck.uuid → deck 设置`。
2. **启动对账**：`GET /api/decks` + `GET /api/cards` → deck 镜像 → §4.2 ③merge → ④PUSH。
3. **复习时**：`GET /api/cards/:dbId` 取最新内容+状态 → web-fsrs 算新状态 → 更新 Local（dirty）。
4. **推送**：对 dirty 卡先重读（`GET /api/cards/:dbId`）→ `lastReview` 冲突检查 → 写回（§4.4）→ 清 dirty。
5. **内容变更**：merge 时按 `updatedAt` 提示 + `question` 比较处理（§4.3）。
6. **删除**：merge 时 DB 缺失的 Local 卡软删，不推送；DB 缺失的 deck 块 → 软删 deck。
7. **FSRS 参数**：与桌面插件共享同一套参数（§4.6）。

---

## 7. 后续接口（规划中）

- ~~`POST /api/cards/:id/state`~~ —— **已实现**（§5.4，含 `base.lastReview` 服务端冲突检查）。
