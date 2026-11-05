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
    elapsed_days: c.elapsed_days,
    scheduled_days: c.scheduled_days,
    reps: c.reps,
    lapses: c.lapses,
    state: c.state as State,
    last_review: c.last_review ? new Date(num(c.last_review)) : undefined,
  }
}

export type NextCard = {
  cid: number
  nid: number
  did: number
  question: string
  answer: string[]
  state: number
  due: number
}

class SchedulerService {
  /**
   * Pick the next card to review.
   *
   * Algorithm (user-specified):
   * 1. Overdue branch — if any Learning/Relearning/Review card has due <= now,
   *    return the MOST RECENTLY overdue one (max due among overdue, i.e. the
   *    card with |due - now| smallest).
   * 2. Otherwise (nothing due yet):
   *    - 80%: draw a New card (state=0, due=0), respecting the daily new limit
   *    - 20%: return the soonest-due pool card (min due = closest to now)
   *    Fallbacks (never skip a reviewable card):
   *    - 80% roll but no new card (limit reached / exhausted) → pool card
   *    - 20% roll but pool empty → new card
   *    - both empty → null (truly nothing to review)
   *
   * deck.p_due is no longer used here — the mix ratio is a fixed 80/20.
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

    // 1. Overdue: serve the most recently overdue first (max due among due <= now).
    const overdue = await baseQuery()
      .select(['c.id as cid', 'n.id as nid', 'c.did as did', 'n.question as question', 'n.answer as answer', 'c.state as state', 'c.due as due'])
      .where('c.state', 'in', [State.Learning, State.Review, State.Relearning])
      .where('c.due', '<=', now.getTime())
      .orderBy('c.due', 'desc')
      .limit(1)
      .executeTakeFirst()
    if (overdue) return overdue as NextCard

    // 2. Nothing overdue: soonest-due pool card (all future now, so min due = closest to now).
    const pickFuture = async (): Promise<NextCard | null> =>
      ((await baseQuery()
        .select(['c.id as cid', 'n.id as nid', 'c.did as did', 'n.question as question', 'n.answer as answer', 'c.state as state', 'c.due as due'])
        .where('c.state', 'in', [State.Learning, State.Review, State.Relearning])
        .orderBy('c.due', 'asc')
        .limit(1)
        .executeTakeFirst()) as NextCard) ?? null

    // New card draw, respecting the daily new limit.
    const drawNew = async (): Promise<NextCard | null> => {
      // cards first seen today = number of cid groups whose min(review) >= todayStart.
      // (count the groups, not per-group rows — a plain `group by cid + count(*)`
      // would return per-card review counts.)
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
      if ((todayNewLearned?.cnt ?? 0) >= deck.card_limit.new) return null

      const c = await baseQuery()
        .select(['c.id as cid', 'n.id as nid', 'c.did as did', 'n.question as question', 'n.answer as answer', 'c.state as state', 'c.due as due'])
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
   * Grade a card: fsrs.next → update cards + write revlog.
   *
   * 语义（ts-fsrs 4.7.1）：
   *   - `card`（f.next 返回）→ toCardUpdate → cards 表 = 评分后的当前状态
   *   - `log`（f.next 返回）→ toRevlogInsert → revlog 表 = 评分前的状态快照
   *     （log.state/stability/difficulty/scheduled_days 是评分前值；
   *       log.due = 评分前 last_review；log.elapsed_days 是本次事件间隔）
   *   - undo 依赖 revlog 的评分前快照做 fsrs.rollback 还原 cards
   */
  async review(cid: number, grade: Grade, duration = 0): Promise<{ next_state: number; next_due: number; lid: number }> {
    const row = await db
      .selectFrom('cards as c')
      .innerJoin('decks as d', 'd.id', 'c.did')
      .selectAll('c')
      .select(['d.fsrs as fsrs'])
      .where('c.id', '=', cid)
      .executeTakeFirstOrThrow()
    const params = row.fsrs as FSRSParameters
    const f = fsrs(params)
    const fsrsCard = dbCardToFsrsCard(row)
    const now = new Date()

    const { card, log } = f.next(fsrsCard, now, grade, (item: RecordLogItem) => {
      return {
        card: this.toCardUpdate(item.card, now.getTime()),
        log: this.toRevlogInsert(item, cid, row.did, row.nid, duration),
      } as any
    })

    const lid = await db.transaction().execute(async (trx) => {
      await trx.updateTable('cards').set(card as Updateable<CardTable>).where('id', '=', cid).execute()
      const r = await trx.insertInto('revlog').values(log as Insertable<RevlogTable>).returning('id').executeTakeFirstOrThrow()
      return r.id
    })
    return { next_state: (card as Card).state, next_due: +(card as Card).due, lid }
  }

  /** Undo last review for a card via fsrs.rollback. */
  async undo(cid: number, lid: number): Promise<{ next_state: number; next_due: number }> {
    const row = await db
      .selectFrom('cards as c')
      .innerJoin('decks as d', 'd.id', 'c.did')
      .selectAll('c')
      .select(['d.fsrs as fsrs'])
      .where('c.id', '=', cid)
      .executeTakeFirstOrThrow()
    const logRow = await db.selectFrom('revlog').selectAll().where('id', '=', lid).where('cid', '=', cid).executeTakeFirstOrThrow()

    const f = fsrs(row.fsrs as FSRSParameters)
    const logWithRating = { ...logRow, rating: logRow.grade }
    const now = Date.now()

    const prevCard = f.rollback(dbCardToFsrsCard(row), logWithRating as any, (c: Card) => this.toCardUpdate(c, now))
    await db.transaction().execute(async (trx) => {
      await trx.updateTable('cards').set(prevCard as Updateable<CardTable>).where('id', '=', cid).execute()
      await trx.updateTable('revlog').set({ deleted: true }).where('id', '=', lid).execute()
    })
    return { next_state: prevCard.state ?? 0, next_due: prevCard.due ? +prevCard.due : 0 }
  }

  private toCardUpdate(c: Card, updated: number): Updateable<CardTable> {
    return {
      due: num(+c.due),
      stability: num(c.stability),
      difficulty: num(c.difficulty),
      elapsed_days: num(c.elapsed_days),
      scheduled_days: num(c.scheduled_days),
      reps: num(c.reps),
      lapses: num(c.lapses),
      state: num(c.state),
      last_review: c.last_review ? num(c.last_review.getTime()) : undefined,
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
      elapsed_days: num(log.elapsed_days),
      last_elapsed_days: num(log.last_elapsed_days),
      scheduled_days: num(log.scheduled_days),
      review: num(+log.review),
      duration,
      offset: new Date().getTimezoneOffset(),
    }
  }
}

export const scheduler = new SchedulerService()
export default scheduler
