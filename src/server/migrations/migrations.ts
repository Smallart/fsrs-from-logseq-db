import path from 'path'

import { db } from '@server/models/db'
import { Migrator } from 'kysely'
import { fileMigrationProvider } from './provider'

const migrator = new Migrator({
  db,
  provider: fileMigrationProvider(path.join(process.cwd(), 'src/server/migrations/logs')),
  allowUnorderedMigrations: true,
})

// tsx --env-file=.env src/server/migrations/migrations.ts [up|down|latest]
const type = process.argv[2] as ('up' | 'down' | 'latest') | undefined

async function migrate() {
  const start = Date.now()
  const { error, results } =
    type === 'up'
      ? await migrator.migrateUp()
      : type === 'down'
        ? await migrator.migrateDown()
        : await migrator.migrateToLatest()

  results?.forEach((it) => {
    if (it.status === 'Success') {
      console.log(`migration "${it.migrationName}" executed successfully`)
    } else if (it.status === 'Error') {
      console.error(`failed to execute migration "${it.migrationName}"`)
    }
  })
  console.log(`migrated in ${((Date.now() - start) / 1000).toFixed(2)}s`)
  if (error) {
    console.error(error)
    process.exit(1)
  }
  await db.destroy()
}

migrate()
