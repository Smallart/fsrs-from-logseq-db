import 'server-only'

// Gateway client — the app's ONLY channel to Logseq data.
// Talks to logseq-cli2http (see docs/WEB_FSRS_INTEGRATION.md for the full
// contract). The Logseq DB's block `card_params` is the single source of
// truth; this app is the web-fsrs client (PG is a local cache).

/** ts-fsrs state on a card, plugin camelCase format (gateway §3.2). */
export type TsFsrsCard = {
  state: number
  due: number
  stability: number
  difficulty: number
  lastReview: number | null
  learningSteps: number
  priorState: number
  elapsedDays: number
  scheduledDays: number
  reps: number
  lapses: number
  lastRating: number | null
}

export type CardSource = 'card_params' | 'fsrs-legacy' | 'default'

/** One deck definition — a `#Cards` query block (gateway GET /api/decks). */
export type DeckDef = {
  /** db/id of the #Cards query block itself */
  blockId: number
  /** block/uuid of the deck block — the stable anchor for the app's decks row */
  uuid: string
  /** deck name = the deck block's title */
  name: string
  /** the raw Logseq query DSL this deck was defined with */
  dsl: string
  /** db/ids of the card blocks the deck's query resolves to */
  memberDbIds: number[]
  /** false when the DSL could not be parsed/executed → empty members */
  dslOk: boolean
}

/** One flat card from the gateway (batch endpoint: `answer` is always []). */
export type FlatCard = {
  id: string // Logseq block UUID
  dbId: number | null // Logseq block db/id
  question: string
  answer: string[]
  deck: string | null
  pageId: number | null
  parentId: number | null
  tags: string[]
  properties: Record<string, unknown>
  card: TsFsrsCard
  cardSource: CardSource
  createdAt: number | null
  updatedAt: number | null
}

export class GatewayError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message)
    this.name = 'GatewayError'
  }
}

const num = (v: unknown): number => {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

function normalizeCard(raw: Record<string, unknown>): TsFsrsCard {
  return {
    state: num(raw.state),
    due: num(raw.due),
    stability: num(raw.stability),
    difficulty: num(raw.difficulty),
    lastReview: raw.lastReview === null || raw.lastReview === undefined ? null : num(raw.lastReview),
    learningSteps: num(raw.learningSteps),
    priorState: num(raw.priorState),
    elapsedDays: num(raw.elapsedDays),
    scheduledDays: num(raw.scheduledDays),
    reps: num(raw.reps),
    lapses: num(raw.lapses),
    lastRating: raw.lastRating === null || raw.lastRating === undefined ? null : num(raw.lastRating),
  }
}

function normalizeFlatCard(raw: Record<string, unknown>): FlatCard {
  return {
    id: String(raw.id ?? ''),
    dbId: raw.dbId === null || raw.dbId === undefined ? null : num(raw.dbId),
    question: String(raw.question ?? ''),
    answer: Array.isArray(raw.answer) ? raw.answer.map(String) : [],
    deck: raw.deck === null || raw.deck === undefined ? null : String(raw.deck),
    pageId: raw.pageId === null || raw.pageId === undefined ? null : num(raw.pageId),
    parentId: raw.parentId === null || raw.parentId === undefined ? null : num(raw.parentId),
    tags: Array.isArray(raw.tags) ? raw.tags.map(String) : [],
    properties:
      raw.properties !== null && typeof raw.properties === 'object' && !Array.isArray(raw.properties)
        ? (raw.properties as Record<string, unknown>)
        : {},
    card: normalizeCard(
      typeof raw.card === 'object' && raw.card !== null ? (raw.card as Record<string, unknown>) : {},
    ),
    cardSource: (['card_params', 'fsrs-legacy', 'default'].includes(String(raw.cardSource))
      ? String(raw.cardSource)
      : 'default') as CardSource,
    createdAt: raw.createdAt === null || raw.createdAt === undefined ? null : num(raw.createdAt),
    updatedAt: raw.updatedAt === null || raw.updatedAt === undefined ? null : num(raw.updatedAt),
  }
}

export class GatewayClient {
  constructor(private baseUrl: string) {}

  private async req<T>(path: string, init?: RequestInit): Promise<{ status: number; body: unknown }> {
    let res: Response
    try {
      res = await fetch(`${this.baseUrl.replace(/\/$/, '')}${path}`, {
        ...init,
        headers: { Accept: 'application/json', ...(init?.headers ?? {}) },
      })
    } catch (e: any) {
      throw new GatewayError(`gateway unreachable: ${e?.message ?? 'fetch failed'}`, 0, 'gateway_unreachable')
    }
    const body = await res.json().catch(() => null)
    if (!res.ok) {
      const err = (body as { error?: { code?: string; message?: string } } | null)?.error
      throw new GatewayError(err?.message ?? `gateway ${res.status}`, res.status, err?.code)
    }
    return { status: res.status, body }
  }

  /** GET /api/cards — full pull (§4.2 ①PULL). */
  async fetchCards(): Promise<FlatCard[]> {
    const { body } = await this.req('/api/cards')
    const cards = (body as { data?: { cards?: unknown[] } })?.data?.cards
    if (!Array.isArray(cards)) throw new GatewayError('gateway returned no cards array', 500)
    return cards.map((c) =>
      normalizeFlatCard(c !== null && typeof c === 'object' ? (c as Record<string, unknown>) : {}),
    )
  }

  /** GET /api/decks — every #Cards deck block + resolved member db/ids. */
  async fetchDeckDefs(): Promise<DeckDef[]> {
    const { body } = await this.req('/api/decks')
    const decks = (body as { data?: { decks?: unknown[] } })?.data?.decks
    if (!Array.isArray(decks)) throw new GatewayError('gateway returned no decks array', 500)
    return decks
      .filter((d): d is Record<string, unknown> => d !== null && typeof d === 'object')
      .map((d) => ({
        blockId: num(d.blockId),
        uuid: String(d.uuid ?? ''),
        name: String(d.name ?? ''),
        dsl: String(d.dsl ?? ''),
        memberDbIds: Array.isArray(d.memberDbIds)
          ? d.memberDbIds.map((m) => num(m)).filter((m: number) => Number.isInteger(m) && m > 0)
          : [],
        dslOk: d.dslOk === true,
      }))
      .filter((d) => d.uuid !== '')
  }

  /** GET /api/cards/:dbId — single card with the answer filled (§4.5). */
  async fetchCardById(dbId: number): Promise<FlatCard> {
    const { body } = await this.req(`/api/cards/${dbId}`)
    const card = (body as { data?: { card?: unknown } })?.data?.card
    if (card === null || typeof card !== 'object') {
      throw new GatewayError('gateway returned no card', 500)
    }
    return normalizeFlatCard(card as Record<string, unknown>)
  }

  /**
   * POST /api/cards/:dbId/state — write a review result back into
   * `card_params` (§5.4). `base` = the lastReview the result was computed
   * from; the gateway re-reads the block and rejects (409, carrying the
   * winning `current`) when the block's state is newer — never blind-write.
   * `force` skips the conflict check (used by undo, an explicit user intent).
   */
  async writeCardState(
    dbId: number,
    card: TsFsrsCard,
    base: number | null,
    force = false,
  ): Promise<{ ok: true; card: TsFsrsCard } | { ok: false; current: TsFsrsCard }> {
    const { status, body } = await this.req(`/api/cards/${dbId}/state`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ card, base, force }),
    })
    if (status === 200) {
      const written = (body as { data?: { card?: unknown } })?.data?.card
      const c =
        written !== null && typeof written === 'object'
          ? normalizeCard(written as Record<string, unknown>)
          : card
      return { ok: true, card: c }
    }
    if (status === 409) {
      const current = (body as { error?: { current?: unknown } })?.error?.current
      return {
        ok: false,
        current:
          current !== null && typeof current === 'object'
            ? normalizeCard(current as Record<string, unknown>)
            : card,
      }
    }
    throw new GatewayError('unexpected writeCardState status', status)
  }
}
