import { db } from '@server/models/db'
import type { BlockResponse } from '@server/libs/logseq'
import { LogseqClient } from '@server/libs/logseq'
import { createHash } from 'crypto'

// pg's prepareValue serializes JS arrays into PostgreSQL array literals
// (e.g. ['a','b'] → '{"a","b"}'), which is NOT valid JSON and triggers
// "invalid input syntax for type json" on jsonb columns. We must pass an
// already-JSON.stringify'd string so pg treats it as a JSON literal.
// (Read side is fine: pg.types.setTypeParser(3802, JSON.parse) in db.ts
// parses jsonb back into a string[] at query time.)
const jsonb = (v: unknown): string[] => JSON.stringify(v) as unknown as string[]

// ---- config access ----
export async function loadConfig(): Promise<{ token: string; graphId: string }> {
  const row = await db.selectFrom('config').selectAll().where('id', '=', 1).executeTakeFirstOrThrow()
  if (!row.token || !row.graph_id) {
    throw new Error('Logseq token or graph_id not configured. Set them in Settings.')
  }
  return { token: row.token, graphId: row.graph_id }
}

// ---- parsing ----
export type ParsedCard = {
  question: string
  answer: string[]
  pageId: string | null
  hash: string
}

export function parseCard(block: BlockResponse): ParsedCard {
  const question = (block.title ?? '').trim()
  const answer = (block.children ?? []).map((c) => (c.title ?? '').trim()).filter((s) => s.length > 0)
  const pageId = block['page-id'] ?? null
  const hash = hashCard(question, answer)
  return { question, answer, pageId, hash }
}

function hashCard(question: string, answer: string[]): string {
  return createHash('sha256').update(JSON.stringify({ q: question, a: answer })).digest('hex')
}

// Logseq reserved pages (tag pages, all-pages, flashcards, …) have ids like
// "00000002-…". They are blocks, not real pages: listPageBlocks rejects them
// with 400 "block is not a page", and the API exposes no way to read their
// children. Skip them and surface the ids so the user can move those cards
// into real pages.
function isReservedPageId(id: string): boolean {
  return /^0000000[0-9a-f]/i.test(id)
}

// Recursively walk a block tree and collect blocks whose uuid is in `targets`.
function findBlocksInTree(blocks: BlockResponse[], targets: Set<string>): BlockResponse[] {
  const found: BlockResponse[] = []
  function walk(b: BlockResponse) {
    if (targets.has(b.uuid)) found.push(b)
    for (const c of b.children ?? []) walk(c)
  }
  for (const b of blocks) walk(b)
  return found
}

// ---- sync ----
export type SyncReport = {
  indexed: number
  newCards: number
  updatedCards: number
  deletedCards: number
  /** Reserved Logseq page ids (e.g. tag pages) whose cards were skipped. */
  skippedPages: string[]
  /** How many candidate cards live on skipped (reserved) pages. */
  skippedCards: number
  /** Local candidate cards not found in any fetched page tree — approximates
   *  "changed but not updated" (missed changes). */
  unmatchedCards: number
  fullCheck: boolean
  startedAt: number
  finishedAt: number
}

const ALL_DECK_ID_QUERY = db
  .selectFrom('decks')
  .select('id')
  .where('name', '=', 'All')
  .where('deleted', '=', false)
  .limit(1)

export async function sync(opts: { fullCheck?: boolean } = {}): Promise<SyncReport> {
  const startedAt = Date.now()
  const { token, graphId } = await loadConfig()
  const client = new LogseqClient(token)

  const tagId = await client.findCardTagId(graphId)
  if (!tagId) throw new Error('#card tag not found in graph')

  const syncMeta = await db.selectFrom('sync_meta').selectAll().where('id', '=', 1).executeTakeFirstOrThrow()
  const lastSync = syncMeta.last_sync_at ?? 0

  // A. full index
  const objects = await client.listTagObjects(graphId, tagId)
  const liveUuids = new Set(objects.map((o) => o.uuid))

  // B. deletion detection
  const localRows = await db
    .selectFrom('notes')
    .select(['id', 'logseq_uuid', 'content_hash'])
    .where('deleted', '=', false)
    .execute()
  const localUuids = new Map(localRows.map((r) => [r.logseq_uuid, r]))

  const toDelete = [...localUuids.keys()].filter((u) => !liveUuids.has(u))
  if (toDelete.length > 0) {
    await db.updateTable('notes').set({ deleted: true, updated: startedAt }).where('logseq_uuid', 'in', toDelete).execute()
    // memberships follow the note: excluded from every deck it belonged to
    const deletedNoteIds = localRows.filter((r) => toDelete.includes(r.logseq_uuid)).map((r) => r.id)
    if (deletedNoteIds.length > 0) {
      await db.updateTable('note_decks').set({ deleted: true }).where('nid', 'in', deletedNoteIds).execute()
    }
  }

  // C. candidates: new + updated-after hits
  const candidateUuids = new Set<string>()
  for (const o of objects) {
    if (!localUuids.has(o.uuid)) candidateUuids.add(o.uuid)
  }
  if (lastSync > 0) {
    const updated = await client.listTagObjects(graphId, tagId, { updatedAfter: lastSync })
    for (const o of updated) candidateUuids.add(o.uuid)
  }

  // D. full check override: scan all live uuids
  const fullCheck = opts.fullCheck === true || syncMeta.last_full_check_at == null || startedAt - (syncMeta.last_full_check_at ?? 0) > 24 * 60 * 60 * 1000
  if (fullCheck) {
    for (const u of liveUuids) candidateUuids.add(u)
  }

  // E. fetch + upsert (bounded concurrency, by page tree instead of per-card getBlock)
  const deck = await ALL_DECK_ID_QUERY.executeTakeFirstOrThrow()
  const deckId = deck.id

  // map candidate uuid → page-id (from tag index), then fetch only those pages
  const uuidToPage = new Map<string, string | null>()
  for (const o of objects) uuidToPage.set(o.uuid, o['page-id'] ?? null)
  const pageIdsToFetch = new Set<string>()
  for (const u of candidateUuids) {
    const p = uuidToPage.get(u)
    if (p) pageIdsToFetch.add(p)
  }
  const pageIds = [...pageIdsToFetch]
  const skippedPages = pageIds.filter((p) => isReservedPageId(p))
  const fetchablePageIds = pageIds.filter((p) => !isReservedPageId(p))
  let skippedCards = 0
  for (const u of candidateUuids) {
    const p = uuidToPage.get(u)
    if (p && isReservedPageId(p)) skippedCards++
  }

  let newCards = 0
  let updatedCards = 0
  const foundUuids = new Set<string>()
  const CONCURRENCY = 3
  for (let i = 0; i < fetchablePageIds.length; i += CONCURRENCY) {
    const batch = fetchablePageIds.slice(i, i + CONCURRENCY)
    const trees = await Promise.all(batch.map((p) => client.listPageBlocks(graphId, p)))
    for (const blocks of trees) {
      const found = findBlocksInTree(blocks, candidateUuids)
      for (const block of found) {
        foundUuids.add(block.uuid)
        const parsed = parseCard(block)
        const existing = localUuids.get(block.uuid)
        if (!existing) {
          const note = await db
            .insertInto('notes')
            .values({
              did: deckId,
              logseq_uuid: block.uuid,
              page_id: parsed.pageId,
              question: parsed.question,
              answer: jsonb(parsed.answer),
              content_hash: parsed.hash,
              source: 'logseq',
            })
            .returning('id')
            .executeTakeFirstOrThrow()
          // the new note immediately joins its base deck (note-level membership)
          await db
            .insertInto('note_decks')
            .values({ nid: note.id, did: deckId, deleted: false, created: startedAt })
            .execute()
          await db
            .insertInto('cards')
            .values({
              did: deckId,
              nid: note.id,
              due: 0,
              stability: 0,
              difficulty: 0,
              elapsed_days: 0,
              scheduled_days: 0,
              reps: 0,
              lapses: 0,
              state: 0,
              last_review: null,
            })
            .execute()
          newCards++
        } else if (existing.content_hash !== parsed.hash) {
          await db
            .updateTable('notes')
            .set({
              question: parsed.question,
              answer: jsonb(parsed.answer),
              content_hash: parsed.hash,
              page_id: parsed.pageId,
              updated: startedAt,
            })
            .where('id', '=', existing.id)
            .execute()
          updatedCards++
        }
      }
    }
  }

  // Candidates that exist locally, aren't on skipped (reserved) pages, yet
  // weren't found in any fetched page tree — i.e. potential missed changes.
  let unmatchedCards = 0
  for (const u of candidateUuids) {
    if (foundUuids.has(u)) continue
    if (!localUuids.has(u)) continue
    const p = uuidToPage.get(u)
    if (p && isReservedPageId(p)) continue
    unmatchedCards++
  }

  // F. tag-deck membership maintenance: for each tag deck, refresh which notes
  // still carry the tag (→ active membership) and which no longer do
  // (→ membership soft-deleted). Failures for one deck never abort the whole
  // content sync — a tag deleted in Logseq would otherwise break sync forever.
  const tagDecks = await db
    .selectFrom('decks')
    .select(['id', 'logseq_uuid'])
    .where('deleted', '=', false)
    .where('logseq_uuid', 'is not', null)
    .execute()
  for (const td of tagDecks) {
    try {
      const objs = await client.listTagObjects(graphId, td.logseq_uuid!)
      const tagUuids = new Set(objs.map((o) => o.uuid))

      // notes that should be active members of this tag deck
      const shouldMembers = [...tagUuids].length
        ? await db
            .selectFrom('notes')
            .select('id')
            .where('deleted', '=', false)
            .where('logseq_uuid', 'in', [...tagUuids])
            .execute()
        : []
      const shouldIds = shouldMembers.map((n) => n.id)

      if (shouldIds.length > 0) {
        await db
          .insertInto('note_decks')
          .values(shouldIds.map((nid) => ({ nid, did: td.id, deleted: false, created: startedAt })))
          .onConflict((oc) => oc.columns(['nid', 'did']).doUpdateSet({ deleted: false }))
          .execute()
      }
      // active members that no longer carry the tag → excluded from this deck
      // (nid not in shouldIds; empty list → every active row is excluded)
      if (shouldIds.length > 0) {
        await db
          .updateTable('note_decks')
          .set({ deleted: true })
          .where('did', '=', td.id)
          .where('deleted', '=', false)
          .where('nid', 'not in', shouldIds)
          .execute()
      } else {
        await db
          .updateTable('note_decks')
          .set({ deleted: true })
          .where('did', '=', td.id)
          .where('deleted', '=', false)
          .execute()
      }
    } catch (e) {
      // skip this deck's refresh; content sync must not fail because of it
      console.warn(`[sync] tag-deck refresh failed for deck ${td.id}:`, e)
    }
  }

  const finishedAt = Date.now()
  await db
    .updateTable('sync_meta')
    .set({ last_sync_at: finishedAt, ...(fullCheck ? { last_full_check_at: finishedAt } : {}) })
    .where('id', '=', 1)
    .execute()

  return {
    indexed: objects.length,
    newCards,
    updatedCards,
    deletedCards: toDelete.length,
    skippedPages,
    skippedCards,
    unmatchedCards,
    fullCheck,
    startedAt,
    finishedAt,
  }
}
