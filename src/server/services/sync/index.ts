import { db } from '@server/models/db'
import { GatewayClient, type FlatCard, type TsFsrsCard, type DeckDef } from '@server/libs/gateway'

// ---------------------------------------------------------------------------
// Sync engine — web-fsrs client side of the PULL → merge → PUSH protocol
// (docs/WEB_FSRS_INTEGRATION.md §4).
//
//   ① PULL   gateway GET /api/decks + GET /api/cards — the gateway has no
//             incremental API; every sync is a full pull + merge. The two
//             calls run sequentially (the gateway's CLI spawns must not
//             race on the db-worker lifecycle).
//   ② decks  decks are #Cards query blocks in the graph: created/renamed/
//             removed to mirror GET /api/decks (anchor = block uuid); card
//             membership = each deck's resolved memberDbIds (+ virtual All).
//   ③ merge  per card, lastReview arbitrates (§4.1: newest wins):
//             gateway newer → overwrite local cards row (dirty=false)
//             local newer   → keep, stays dirty (awaiting PUSH)
//             content (question/…) always follows the gateway
//   ④ PUSH   for dirty cards: re-read the block via the gateway, push the
//             local state with base = the block's current lastReview; on 409
//             the gateway's state wins and overwrites the local row.
//
// The Logseq DB block `card_params` is the single source of truth; this PG
// is a local cache. Decks are defined in Logseq (#Cards blocks), never
// created manually in the app.
// ---------------------------------------------------------------------------

// pg serializes JS arrays/objects into PG literals (invalid JSON for jsonb),
// so stringify explicitly before insert/update.
const jsonb = <T>(v: unknown) => JSON.stringify(v) as unknown as T

/** TsFsrsCard → cards-row values (camelCase mirrors both sides). */
export function tsCardValues(c: TsFsrsCard) {
  return {
    state: c.state,
    due: c.due,
    stability: c.stability,
    difficulty: c.difficulty,
    lastReview: c.lastReview,
    learningSteps: c.learningSteps,
    priorState: c.priorState,
    elapsedDays: c.elapsedDays,
    scheduledDays: c.scheduledDays,
    reps: c.reps,
    lapses: c.lapses,
    lastRating: c.lastRating,
  }
}

export type SyncReport = {
  pulled: number
  newCards: number
  contentUpdated: number
  /** gateway won lastReview arbitration → local state overwritten */
  stateUpdated: number
  /** local state is newer → kept dirty for PUSH */
  keptDirty: number
  deletedCards: number
  decksCreated: number
  pushed: number
  /** PUSH hit a conflict (409) or the block caught up → gateway state adopted */
  pushConflicts: number
  /** PUSH could not complete (gateway unreachable / no dbId) — stays dirty */
  pushFailed: number
  fullCheck: boolean
  startedAt: number
  finishedAt: number
}

// The builtin #Card class tag rides on every card block. It is NOT a deck
// source (decks come from #Cards blocks); this filter is only used to compare
// a card's own tags for content-change detection (§4.3).
const BUILTIN_CARD_TAG = 'card'

const nonBuiltinTags = (tags: string[]): string[] =>
  tags.filter((t) => t.toLowerCase() !== BUILTIN_CARD_TAG)

export async function loadConfig(): Promise<{ gatewayUrl: string }> {
  const row = await db.selectFrom('config').selectAll().where('id', '=', 1).executeTakeFirstOrThrow()
  if (!row.gatewayUrl) {
    throw new Error('网关 URL 未配置，请到全局设置填写（logseq-cli2http 地址）')
  }
  return { gatewayUrl: row.gatewayUrl }
}

export async function sync(opts: { fullCheck?: boolean } = {}): Promise<SyncReport> {
  const startedAt = Date.now()
  const { gatewayUrl } = await loadConfig()
  const client = new GatewayClient(gatewayUrl)
  const now = () => Date.now()

  // ① PULL — deck definitions first, then the full card snapshot.
  //    Sequential on purpose: the gateway runs Logseq CLI per call and
  //    parallel CLI spawns race on the db-worker lifecycle.
  const deckDefs = await client.fetchDeckDefs()
  const cards = await client.fetchCards()
  const liveUuids = new Set(cards.map((c) => c.id))

  // --- decks: All (virtual) + one per #Cards deck block (anchor = uuid) ---
  const allDeck = await db
    .selectFrom('decks')
    .selectAll()
    .where('name', '=', 'All')
    .where('deleted', '=', false)
    .executeTakeFirstOrThrow()

  const deckIdByAnchor = new Map<string, number>()
  let decksCreated = 0
  for (const def of deckDefs) {
    let deck = await db
      .selectFrom('decks')
      .selectAll()
      .where('anchorUuid', '=', def.uuid)
      .executeTakeFirst()
    if (!deck || deck.deleted) {
      // new deck block (or resurrected) — keep settings if the row exists
      if (deck) {
        await db
          .updateTable('decks')
          .set({ deleted: false, name: def.name, updated: now() })
          .where('id', '=', deck.id)
          .execute()
        deck = { ...deck, deleted: false, name: def.name }
      } else {
        deck = await db
          .insertInto('decks')
          .values({ name: def.name, anchorUuid: def.uuid })
          .returningAll()
          .executeTakeFirstOrThrow()
        decksCreated++
      }
    } else if (deck.name !== def.name) {
      // renamed in Logseq → follow, settings survive (anchor is the uuid)
      await db
        .updateTable('decks')
        .set({ name: def.name, updated: now() })
        .where('id', '=', deck.id)
        .execute()
      deck = { ...deck, name: def.name }
    }
    deckIdByAnchor.set(def.uuid, deck.id)
  }

  // deck blocks that vanished from the graph → soft-delete the deck
  const liveAnchors = new Set(deckDefs.map((d) => d.uuid))
  const staleDecks = await db
    .selectFrom('decks')
    .selectAll()
    .where('anchorUuid', 'is not', null)
    .where('deleted', '=', false)
    .execute()
  for (const stale of staleDecks) {
    if (!liveAnchors.has(stale.anchorUuid!)) {
      await db
        .updateTable('decks')
        .set({ deleted: true, updated: now() })
        .where('id', '=', stale.id)
        .execute()
    }
  }

  // dbId → deck ids membership index (a card may sit in several decks)
  const deckIdsByDbId = new Map<number, number[]>()
  for (const def of deckDefs) {
    const did = deckIdByAnchor.get(def.uuid)!
    for (const dbId of def.memberDbIds) {
      let ids = deckIdsByDbId.get(dbId)
      if (!ids) {
        ids = []
        deckIdsByDbId.set(dbId, ids)
      }
      ids.push(did)
    }
  }

  // --- local state maps ---
  const noteRows = await db.selectFrom('notes').selectAll().execute()
  const notesByUuid = new Map(noteRows.map((n) => [n.logseq_uuid, n]))
  const cardRows = await db.selectFrom('cards').selectAll().execute()
  const cardsByNid = new Map(cardRows.map((c) => [c.nid, c]))
  const noteDeckRows = await db.selectFrom('note_decks').selectAll().execute()
  const activeDidsByNid = new Map<number, Set<number>>()
  for (const nd of noteDeckRows) {
    if (nd.deleted) continue
    let s = activeDidsByNid.get(nd.nid)
    if (!s) {
      s = new Set()
      activeDidsByNid.set(nd.nid, s)
    }
    s.add(nd.did)
  }

  let newCards = 0
  let contentUpdated = 0
  let stateUpdated = 0
  let keptDirty = 0

  /** All deck + every deck whose #Cards block query matched this card. */
  const targetDids = (fc: FlatCard): number[] => {
    const dids = [allDeck.id]
    if (fc.dbId !== null) {
      for (const did of deckIdsByDbId.get(fc.dbId) ?? []) dids.push(did)
    }
    return dids
  }

  const ensureMemberships = async (nid: number, dids: number[]) => {
    const cur = activeDidsByNid.get(nid) ?? new Set<number>()
    const target = new Set(dids)
    let changed = cur.size !== target.size
    if (!changed) for (const d of target) if (!cur.has(d)) { changed = true; break }
    if (!changed) return
    const t = now()
    await db
      .insertInto('note_decks')
      .values(dids.map((did) => ({ nid, did, deleted: false, created: t })))
      .onConflict((oc) => oc.columns(['nid', 'did']).doUpdateSet({ deleted: false }))
      .execute()
    await db
      .updateTable('note_decks')
      .set({ deleted: true })
      .where('nid', '=', nid)
      .where('did', 'not in', dids)
      .execute()
    activeDidsByNid.set(nid, target)
  }

  // --- ② merge ---
  const seenUuids = new Set<string>()
  for (const fc of cards) {
    seenUuids.add(fc.id)
    const note = notesByUuid.get(fc.id)
    const t = now()
    // primary deck = the first deck block whose query matched; All otherwise
    const memberDids = fc.dbId !== null ? deckIdsByDbId.get(fc.dbId) ?? [] : []
    const primaryDid = memberDids[0] ?? allDeck.id

    if (!note) {
      // new card: note + card + memberships
      const inserted = await db
        .insertInto('notes')
        .values({
          did: primaryDid,
          logseq_uuid: fc.id,
          dbId: fc.dbId,
          question: fc.question,
          deck: fc.deck,
          pageId: fc.pageId,
          parentId: fc.parentId,
          tags: jsonb<string[]>(fc.tags),
          properties: jsonb<Record<string, unknown>>(fc.properties),
          cardSource: fc.cardSource,
          createdAt: fc.createdAt,
          updatedAt: fc.updatedAt,
          deleted: false,
          created: t,
          updated: t,
        })
        .returningAll()
        .executeTakeFirstOrThrow()
      await db
        .insertInto('cards')
        .values({
          did: primaryDid,
          nid: inserted.id,
          ...tsCardValues(fc.card),
          cardSource: fc.cardSource,
          dirty: false,
          created: t,
          updated: t,
        })
        .execute()
      activeDidsByNid.set(inserted.id, new Set())
      await ensureMemberships(inserted.id, targetDids(fc))
      newCards++
      continue
    }

    // resurrect if it was soft-deleted locally but is back in Logseq
    if (note.deleted) {
      await db.updateTable('notes').set({ deleted: false, updated: t }).where('id', '=', note.id).execute()
    }

    // content merge (§4.3): updatedAt is a hint; question/tags are the truth.
    // Content follows the gateway unconditionally; the card state does NOT.
    const contentChanged =
      fc.question !== note.question ||
      fc.deck !== note.deck ||
      fc.dbId !== note.dbId ||
      fc.cardSource !== note.cardSource ||
      (fc.updatedAt !== null && fc.updatedAt !== note.updatedAt) ||
      JSON.stringify(nonBuiltinTags(fc.tags)) !== JSON.stringify(nonBuiltinTags(note.tags))
    if (contentChanged) {
      await db
        .updateTable('notes')
        .set({
          did: primaryDid,
          dbId: fc.dbId,
          question: fc.question,
          deck: fc.deck,
          pageId: fc.pageId,
          parentId: fc.parentId,
          tags: jsonb<string[]>(fc.tags),
          properties: jsonb<Record<string, unknown>>(fc.properties),
          cardSource: fc.cardSource,
          createdAt: fc.createdAt,
          updatedAt: fc.updatedAt,
          deleted: false,
          updated: t,
        })
        .where('id', '=', note.id)
        .execute()
      contentUpdated++
    }

    // state merge: lastReview arbitration (§4.2 ②)
    let pgCard = cardsByNid.get(note.id)
    if (!pgCard) {
      // legacy edge (note without a card row) — create from the gateway state
      pgCard = await db
        .insertInto('cards')
        .values({
          did: primaryDid,
          nid: note.id,
          ...tsCardValues(fc.card),
          cardSource: fc.cardSource,
          dirty: false,
          created: t,
          updated: t,
        })
        .returningAll()
        .executeTakeFirstOrThrow()
      cardsByNid.set(note.id, pgCard)
      continue
    }
    if (pgCard.deleted) {
      await db.updateTable('cards').set({ deleted: false, updated: t }).where('id', '=', pgCard.id).execute()
      pgCard = { ...pgCard, deleted: false }
    }

    const gw = fc.card.lastReview
    const local = pgCard.lastReview
    if (gw !== null && (local === null || gw > local)) {
      // gateway (desktop plugin) reviewed after us → gateway wins
      await db
        .updateTable('cards')
        .set({
          ...tsCardValues(fc.card),
          cardSource: fc.cardSource,
          dirty: false,
          deleted: false,
          updated: t,
        })
        .where('id', '=', pgCard.id)
        .execute()
      stateUpdated++
    } else if (gw !== local) {
      // local newer (unpushed review) → keep, stays dirty for ③ PUSH
      if (contentChanged) {
        await db.updateTable('cards').set({ did: primaryDid, updated: t }).where('id', '=', pgCard.id).execute()
      }
      keptDirty++
    }

    await ensureMemberships(note.id, targetDids(fc))
  }

  // deletions: local notes the gateway no longer returns → soft delete
  const toDelete = noteRows.filter((n) => !seenUuids.has(n.logseq_uuid) && !n.deleted)
  if (toDelete.length > 0) {
    const t = now()
    await db
      .updateTable('notes')
      .set({ deleted: true, updated: t })
      .where(
        'id',
        'in',
        toDelete.map((n) => n.id),
      )
      .execute()
    await db
      .updateTable('cards')
      .set({ deleted: true, updated: t })
      .where(
        'nid',
        'in',
        toDelete.map((n) => n.id),
      )
      .execute()
    await db
      .updateTable('note_decks')
      .set({ deleted: true })
      .where(
        'nid',
        'in',
        toDelete.map((n) => n.id),
      )
      .execute()
  }

  // --- ③ PUSH dirty (§4.2 ③): re-read → conflict check → write back ---
  const dirtyRows = await db
    .selectFrom('cards as c')
    .innerJoin('notes as n', 'n.id', 'c.nid')
    .where('c.dirty', '=', true)
    .where('c.deleted', '=', false)
    .where('n.deleted', '=', false)
    .selectAll('c')
    .select('n.dbId as dbId')
    .execute()

  let pushed = 0
  let pushConflicts = 0
  let pushFailed = 0
  for (const row of dirtyRows) {
    const t = now()
    const dbId = (row as { dbId: number | null }).dbId
    if (dbId === null) {
      pushFailed++
      continue
    }
    // a) re-read the block's current state
    let fresh: FlatCard | null = null
    try {
      fresh = await client.fetchCardById(dbId)
    } catch {
      pushFailed++
      continue
    }
    const cur = fresh.card.lastReview
    const localLast = row.lastReview
    const localNewer = localLast !== null && (cur === null || localLast > cur)
    if (localNewer) {
      // b/c) push the local state, base = the block's current lastReview
      const r = await client
        .writeCardState(
          dbId,
          {
            state: row.state,
            due: row.due,
            stability: row.stability,
            difficulty: row.difficulty,
            lastReview: row.lastReview,
            learningSteps: row.learningSteps,
            priorState: row.priorState,
            elapsedDays: row.elapsedDays,
            scheduledDays: row.scheduledDays,
            reps: row.reps,
            lapses: row.lapses,
            lastRating: row.lastRating,
          },
          cur,
        )
        .catch(() => null)
      if (r === null) {
        pushFailed++
        continue
      }
      if (r.ok) {
        await db.updateTable('cards').set({ dirty: false, updated: t }).where('id', '=', row.id).execute()
        pushed++
      } else {
        // 409: the block moved again → gateway state wins
        await db
          .updateTable('cards')
          .set({ ...tsCardValues(r.current), dirty: false, updated: t })
          .where('id', '=', row.id)
          .execute()
        pushConflicts++
      }
    } else {
      // the block caught up with (or passed) us → adopt the gateway state
      await db
        .updateTable('cards')
        .set({ ...tsCardValues(fresh.card), dirty: false, updated: t })
        .where('id', '=', row.id)
        .execute()
      pushConflicts++
    }
  }

  // --- sync_meta ---
  const finishedAt = Date.now()
  await db
    .updateTable('sync_meta')
    .set({ last_sync_at: finishedAt, last_full_check_at: finishedAt })
    .where('id', '=', 1)
    .execute()

  return {
    pulled: cards.length,
    newCards,
    contentUpdated,
    stateUpdated,
    keptDirty,
    deletedCards: toDelete.length,
    decksCreated,
    pushed,
    pushConflicts,
    pushFailed,
    // a full gateway pull happens every time — there is no incremental API
    fullCheck: true,
    startedAt,
    finishedAt,
  }
}
