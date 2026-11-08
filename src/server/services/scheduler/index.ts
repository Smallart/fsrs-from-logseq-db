import 'server-only'
import { db } from '@server/models/db'
import { sql } from 'kysely'
import {
  fsrs,
  type Card,
  type Grade,
  type FSRSParameters,
  Rating,
  State,
  type RecordLogItem,
} from 'ts-fsrs'
import type { CardTable, RevlogTable } from '@server/models'
import type { Insertable, Selectable, Updateable } from 'kysely'
import { GatewayClient, type TsFsrsCard } from '@server/libs/gateway'
import { loadConfig } from '@server/services/sync'
import { tsCardValues } from '@server/services/sync'
import { log } from '@server/libs/logger'

// ---- helpers ----
export function dayBoundaryMs(now: Date, dayStartHour: number): { todayStart: number; nextBoundary: number } {
  const d = new Date(now)
  d.setHours(dayStartHour, 0, 0, 0)
  const todayStart = d.getTime()
  if (now.getTime() < todayStart) {
    // before today's boundary → today's boundary is yesterday's
    const prev = new Date(d)
    prev.setDate(prev.getDate() - 1)
    return { todayStart: prev.getTime(), nextBoundary: todayStart }
  }
  const next = new Date(d)
  next.setDate(next.getDate() + 1)
  return { todayStart, nextBoundary: next.getTime() }
}

// Sanitize FSRS outputs before they reach pg: any non-finite value
// (NaN/Infinity from e.g. an Invalid Date slipping through) becomes 0
// instead of crashing with "invalid input syntax for integer NaN".
const num = (v: unknown): number => {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

function dbCardToFsrsCard(c: Selectable<CardTable>): Card {
  return {
    due: new Date(num(c.due)),
    stability: c.stability,
    difficulty: c.difficulty,
    elapsed_days: c.elapsedDays,
    scheduled_days: c.scheduledDays,
    reps: c.reps,
    lapses: c.lapses,
    state: c.state as State,
    last_review: c.lastReview != null ? new Date(num(c.lastReview)) : undefined,
  }
}

export type NextCard = {
  cid: number
  nid: number
  did: number
  /** Logseq block db/id — the frontend fetches the answer from the gateway with it */
  dbId: number | null
  question: string
  state: number
  due: number
}

class SchedulerService {
  /**
   * Pick the next card to review.
   *
   * Algorithm (unchanged from the pre-gateway version):
   * 1. Overdue branch — if any Learning/Relearning/Review card has due <= now,
   *    return the MOST RECENTLY overdue one (max due among overdue).
   * 2. Otherwise: 80% draw a New card (respecting the daily new limit),
   *    20% return the soonest-due pool card — with cross-fallbacks.
   */
  async next(deckId?: number): Promise<NextCard | null> {
    const deck = await db
      .selectFrom('decks')
      .selectAll()
      .where('deleted', '=', false)
      .where((eb) =>
        deckId != null && Number.isInteger(deckId)
          ? eb('id', '=', deckId)
          : eb('name', '=', 'All'),
      )
      .executeTakeFirstOrThrow()
    const fsrsParams = deck.fsrs
    const now = new Date()
    const { todayStart } = dayBoundaryMs(now, fsrsParams.day_start ?? 3)

    // deck membership is note-level (shared cards): a card enters a deck
    // through its note's active note_decks row.
    const memberNids = () =>
      db.selectFrom('note_decks').select('nid').where('did', '=', deck.id).where('deleted', '=', false)

    const baseQuery = () =>
      db
        .selectFrom('cards as c')
        .innerJoin('notes as n', 'n.id', 'c.nid')
        .where('c.deleted', '=', false)
        .where('c.suspended', '=', false)
        .where('c.nid', 'in', memberNids())
        .where('n.deleted', '=', false)

    const fields = [
      'c.id as cid',
      'n.id as nid',
      'c.did as did',
      'n.dbId as dbId',
      'n.question as question',
      'c.state as state',
      'c.due as due',
    ] as const

    // 1. Overdue: serve the most recently overdue first (max due among due <= now).
    const overdue = await baseQuery()
      .select(fields)
      .where('c.state', 'in', [State.Learning, State.Review, State.Relearning])
      .where('c.due', '<=', now.getTime())
      .orderBy('c.due', 'desc')
      .limit(1)
      .executeTakeFirst()
    if (overdue) return overdue as NextCard

    // 2. Nothing overdue: soonest-due pool card (min due = closest to now).
    const pickFuture = async (): Promise<NextCard | null> =>
      ((await baseQuery()
        .select(fields)
        .where('c.state', 'in', [State.Learning, State.Review, State.Relearning])
        .orderBy('c.due', 'asc')
        .limit(1)
        .executeTakeFirst()) as NextCard) ?? null

    // New card draw, respecting the daily new limit.
    const drawNew = async (): Promise<NextCard | null> => {
      // cards first seen today = cid groups whose min(review) >= todayStart
      const firstSeenToday = db
        .selectFrom('revlog')
        .where('revlog.deleted', '=', false)
        .groupBy('cid')
        .having(sql`min(review)`, '>=', todayStart)
        .select('cid')
        .as('t')

      const todayNewLearned = await db
        .selectFrom(firstSeenToday)
        .select(sql<number>`count(*)::int`.as('cnt'))
        .executeTakeFirst()
      if ((todayNewLearned?.cnt ?? 0) >= deck.cardLimit.new) return null

      const c = await baseQuery()
        .select(fields)
        .where('c.state', '=', State.New)
        .where('c.due', '=', 0)
        .orderBy('c.id', 'asc')
        .limit(1)
        .executeTakeFirst()
      return (c as NextCard) ?? null
    }

    // 80% new / 20% soonest-future, with cross-fallbacks.
    if (Math.random() < 0.8) {
      return (await drawNew()) ?? (await pickFuture())
    }
    return (await pickFuture()) ?? (await drawNew())
  }

  /**
   * Grade a card (web-fsrs side computes, then writes back to the gateway).
   *
   * 1. ts-fsrs next → update local cards (dirty=true) + write revlog
   * 2. PUSH to the gateway immediately (base = the pre-review lastReview):
   *    ok    → dirty=false
   *    409   → the block moved (desktop reviewed meanwhile) → the gateway's
   *            state wins and overwrites the local row
   *    fail  → keep dirty=true; the next sync's PUSH loop retries
   */
  async review(
    cid: number,
    grade: Grade,
    duration = 0,
  ): Promise<{ next_state: number; next_due: number; lid: number; conflict: boolean }> {
    const row = await db
      .selectFrom('cards as c')
      .innerJoin('decks as d', 'd.id', 'c.did')
      .innerJoin('notes as n', 'n.id', 'c.nid')
      .selectAll('c')
      .select(['d.fsrs as fsrs', 'n.dbId as dbId'])
      .where('c.id', '=', cid)
      .executeTakeFirstOrThrow()
    const params = row.fsrs as FSRSParameters
    const f = fsrs(params)
    const fsrsCard = dbCardToFsrsCard(row)
    const preLastReview = row.lastReview
    const preState = row.state
    const now = new Date()

    // f.next's callback lets us capture BOTH sides: item.card = the ts-fsrs
    // Card (snake_case, for the gateway push) and item.log = the pre-review
    // snapshot (for revlog). The callback's return value is what f.next hands
    // back — here the camelCase cards-row update.
    let nextCard!: Card
    let revlogRow!: Insertable<RevlogTable>
    const cardUpdate = f.next(fsrsCard, now, grade, (item: RecordLogItem) => {
      nextCard = item.card
      revlogRow = this.toRevlogInsert(item, cid, row.did, row.nid, duration)
      return this.toCardUpdate(item.card, now.getTime(), preState, grade)
    }) as Updateable<CardTable>

    const lid = await db.transaction().execute(async (trx) => {
      await trx.updateTable('cards').set({ ...cardUpdate, dirty: true }).where('id', '=', cid).execute()
      const r = await trx.insertInto('revlog').values(revlogRow).returning('id').executeTakeFirstOrThrow()
      return r.id
    })

    // the post-review state we just computed (to push to the gateway)
    const pushed: TsFsrsCard = {
      state: num(nextCard.state),
      due: num(+nextCard.due),
      stability: num(nextCard.stability),
      difficulty: num(nextCard.difficulty),
      lastReview: nextCard.last_review ? num(nextCard.last_review.getTime()) : null,
      learningSteps: num(row.learningSteps), // ts-fsrs 4.5 core has none — passthrough
      priorState: num(preState),
      elapsedDays: num(nextCard.elapsed_days),
      scheduledDays: num(nextCard.scheduled_days),
      reps: num(nextCard.reps),
      lapses: num(nextCard.lapses),
      lastRating: grade,
    }

    // PUSH to the gateway (best-effort; on failure stays dirty for sync PUSH)
    let conflict = false
    let finalState = pushed.state
    let finalDue = pushed.due
    try {
      const { gatewayUrl } = await loadConfig()
      const client = new GatewayClient(gatewayUrl)
      const dbId = (row as { dbId: number | null }).dbId
      if (dbId === null) {
        log('warn', 'review: card has no dbId, cannot push to gateway', { cid })
      } else {
        const r = await client.writeCardState(dbId, pushed, preLastReview)
        if (r.ok) {
          await db.updateTable('cards').set({ dirty: false, updated: Date.now() }).where('id', '=', cid).execute()
        } else {
          // 409: the block is newer — the gateway state wins locally too
          conflict = true
          finalState = r.current.state
          finalDue = r.current.due
          await db
            .updateTable('cards')
            .set({ ...tsCardValues(r.current), dirty: false, updated: Date.now() })
            .where('id', '=', cid)
            .execute()
          log('warn', 'review: gateway conflict, adopted block state', {
            cid,
            pushed_last_review: pushed.lastReview,
            current_last_review: r.current.lastReview,
          })
        }
      }
    } catch (e: any) {
      // gateway unreachable → stays dirty, the sync PUSH loop retries later
      log('warn', 'review: gateway push failed, kept dirty', { cid, message: e?.message })
    }

    return { next_state: finalState, next_due: finalDue, lid, conflict }
  }

  /**
   * Undo last review for a card via fsrs.rollback, then force-push the
   * restored state to the gateway (undo is an explicit user intent and MUST
   * overwrite whatever the block holds — force skips the conflict check).
   */
  async undo(cid: number, lid: number): Promise<{ next_state: number; next_due: number }> {
    const row = await db
      .selectFrom('cards as c')
      .innerJoin('decks as d', 'd.id', 'c.did')
      .innerJoin('notes as n', 'n.id', 'c.nid')
      .selectAll('c')
      .select(['d.fsrs as fsrs', 'n.dbId as dbId'])
      .where('c.id', '=', cid)
      .executeTakeFirstOrThrow()
    const logRow = await db.selectFrom('revlog').selectAll().where('id', '=', lid).where('cid', '=', cid).executeTakeFirstOrThrow()

    const f = fsrs(row.fsrs as FSRSParameters)
    const logWithRating = { ...logRow, rating: logRow.grade }
    const now = Date.now()

    // same capture pattern as review(): rollback's callback receives the
    // restored ts-fsrs Card; its return value is the cards-row update
    let restored!: Card
    const prevUpdate = f.rollback(dbCardToFsrsCard(row), logWithRating as any, (c: Card) => {
      restored = c
      return this.toCardUpdate(c, now, logRow.state, logRow.grade)
    }) as Updateable<CardTable>

    await db.transaction().execute(async (trx) => {
      await trx
        .updateTable('cards')
        .set({ ...prevUpdate, dirty: true })
        .where('id', '=', cid)
        .execute()
      await trx.updateTable('revlog').set({ deleted: true }).where('id', '=', lid).execute()
    })

    // force-push the restored state — undo must beat the block's newer state
    try {
      const { gatewayUrl } = await loadConfig()
      const client = new GatewayClient(gatewayUrl)
      const dbId = (row as { dbId: number | null }).dbId
      if (dbId !== null) {
        const restoredState: TsFsrsCard = {
          state: num(restored.state),
          due: num(+restored.due),
          stability: num(restored.stability),
          difficulty: num(restored.difficulty),
          lastReview: restored.last_review ? num(restored.last_review.getTime()) : null,
          learningSteps: num(row.learningSteps),
          priorState: num(row.priorState),
          elapsedDays: num(restored.elapsed_days),
          scheduledDays: num(restored.scheduled_days),
          reps: num(restored.reps),
          lapses: num(restored.lapses),
          lastRating: null, // the undone rating is gone; pre-review rating unknown
        }
        await client.writeCardState(dbId, restoredState, null, true)
        await db.updateTable('cards').set({ dirty: false, updated: Date.now() }).where('id', '=', cid).execute()
      }
    } catch (e: any) {
      log('warn', 'undo: gateway force-push failed, kept dirty', { cid, lid, message: e?.message })
    }

    return { next_state: num(restored.state), next_due: num(+restored.due) }
  }

  /** ts-fsrs Card → cards-row update (camelCase columns). */
  private toCardUpdate(
    c: Card,
    updated: number,
    priorState: number,
    lastRating: number,
  ): Updateable<CardTable> {
    return {
      due: num(+c.due),
      stability: num(c.stability),
      difficulty: num(c.difficulty),
      elapsedDays: num(c.elapsed_days),
      scheduledDays: num(c.scheduled_days),
      reps: num(c.reps),
      lapses: num(c.lapses),
      state: num(c.state),
      lastReview: c.last_review ? num(c.last_review.getTime()) : undefined,
      priorState: num(priorState),
      lastRating: num(lastRating),
      updated,
    }
  }

  private toRevlogInsert(item: RecordLogItem, cid: number, did: number, nid: number, duration: number): Insertable<RevlogTable> {
    const log = item.log as any
    return {
      cid,
      did,
      nid,
      grade: log.rating,
      state: log.state,
      due: num(+log.due),
      stability: num(log.stability),
      difficulty: num(log.difficulty),
      elapsedDays: num(log.elapsed_days),
      lastElapsedDays: num(log.last_elapsed_days),
      scheduledDays: num(log.scheduled_days),
      review: num(+log.review),
      duration,
      offset: new Date().getTimezoneOffset(),
    }
  }
}

export const scheduler = new SchedulerService()
export default scheduler
