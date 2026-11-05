import { Kysely, PostgresDialect } from 'kysely'
import { Pool, types as pgTypes } from 'pg'
import type { Database } from '@server/models'

// Parse jsonb (OID 3802) and json (OID 114) columns as JS objects.
// pg returns them as strings by default, which would break deck.fsrs /
// deck.card_limit / notes.answer access. Parser runs only for non-null values.
pgTypes.setTypeParser(3802, (v: string) => JSON.parse(v))
pgTypes.setTypeParser(114, (v: string) => JSON.parse(v))
// pg returns int8 (bigint, OID 20) as strings to avoid precision loss. All our
// bigint columns hold epoch milliseconds (< 2^53), safe to parse as Number —
// otherwise new Date(c.due) with a string arg yields Invalid Date → NaN.
pgTypes.setTypeParser(20, (v: string) => Number(v))

// NOTE: a placeholder URL is used during build (collecting page data) when
// DATABASE_URL is not set. Real connections only happen at query time, so a
// missing URL at runtime will surface as a pg connection error, not a crash.
const connectionString =
  process.env.DATABASE_URL ??
  'postgresql://placeholder:placeholder@localhost:5432/placeholder'

const pool = new Pool({ connectionString, max: 10 })

export const db = new Kysely<Database>({
  dialect: new PostgresDialect({ pool }),
})

export type { Database }
