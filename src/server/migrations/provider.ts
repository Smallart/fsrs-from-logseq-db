import { promises as fs } from 'fs'
import path from 'path'
import { pathToFileURL } from 'url'
import type { Migration, MigrationProvider } from 'kysely'

// Windows-compatible migration provider.
// kysely's FileMigrationProvider does `import(path.join(folder, file))`, which
// fails on Windows (absolute path 'E:\...' is parsed as an unsupported URL
// scheme). We convert to a proper file:// URL via pathToFileURL instead.
export function fileMigrationProvider(folder: string): MigrationProvider {
  return {
    async getMigrations() {
      const files = (await fs.readdir(folder)).filter(
        (f) => f.endsWith('.ts') || f.endsWith('.js'),
      )
      const migrations: Record<string, Migration> = {}
      for (const fileName of files) {
        const url = pathToFileURL(path.join(folder, fileName)).href
        const mod = (await import(url)) as any
        migrations[fileName] = mod.default ?? mod
      }
      return migrations
    },
  }
}
