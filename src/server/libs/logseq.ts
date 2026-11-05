// Logseq Semantic API client — read-only wrapper around the endpoints we use.
// Spec: http://110.41.171.187:8789/api-docs (OpenAPI 3.1, oauth PAT bearer)

export type BlockResponse = {
  uuid: string
  kind: string
  title: string
  order?: string
  'parent-id'?: string
  'page-id'?: string
  children?: BlockResponse[]
}

export type TagResponse = {
  uuid: string
  title: string
  ident?: string
}

export type GraphResponse = {
  uuid: string
  name?: string
}

const DEFAULT_BASE = process.env.LOGSEQ_API_BASE ?? 'http://110.41.171.187:8789'

export class LogseqClient {
  constructor(
    private token: string,
    private baseUrl: string = DEFAULT_BASE,
  ) {}

  private async req<T>(path: string, init?: RequestInit): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(`${this.baseUrl}${path}`, {
        ...init,
        headers: {
          Authorization: `Bearer ${this.token}`,
          Accept: 'application/json',
          ...(init?.headers ?? {}),
        },
      })
      if (res.status === 429) {
        if (attempt >= 4) {
          throw new Error('Logseq rate limit exceeded (429) after 4 retries')
        }
        const retryAfter = res.headers.get('retry-after')
        const ms = retryAfter
          ? parseInt(retryAfter, 10) * 1000
          : Math.min(1000 * 2 ** attempt, 8000)
        await new Promise((r) => setTimeout(r, ms))
        continue
      }
      if (!res.ok) {
        const body = await res.text().catch(() => '')
        throw new Error(`Logseq API ${res.status}: ${path} ${body}`)
      }
      return res.json() as Promise<T>
    }
  }

  async listGraphs(): Promise<GraphResponse[]> {
    const out: GraphResponse[] = []
    let cursor: string | undefined
    do {
      const q = new URLSearchParams({ limit: '200' })
      if (cursor) q.set('cursor', cursor)
      const r = await this.req<{ graphs: GraphResponse[]; 'next-cursor'?: string }>(
        `/api/v1/graphs?${q}`,
      )
      out.push(...r.graphs)
      cursor = r['next-cursor']
    } while (cursor)
    return out
  }

  async listTags(graphId: string): Promise<TagResponse[]> {
    const out: TagResponse[] = []
    let cursor: string | undefined
    do {
      const q = new URLSearchParams({ limit: '200' })
      if (cursor) q.set('cursor', cursor)
      const r = await this.req<{ tags: TagResponse[]; 'next-cursor'?: string }>(
        `/api/v1/graphs/${graphId}/tags?${q}`,
      )
      out.push(...r.tags)
      cursor = r['next-cursor']
    } while (cursor)
    return out
  }

  /** Find the #card tag by exact title (case-insensitive). */
  async findCardTagId(graphId: string, title = 'card'): Promise<string | null> {
    const tags = await this.listTags(graphId)
    const hit = tags.find((t) => t.title.toLowerCase() === title.toLowerCase())
    return hit?.uuid ?? null
  }

  async listTagObjects(
    graphId: string,
    tagId: string,
    opts: { createdAfter?: number; updatedAfter?: number } = {},
  ): Promise<BlockResponse[]> {
    const out: BlockResponse[] = []
    let cursor: string | undefined
    do {
      const q = new URLSearchParams({ limit: '200' })
      if (cursor) q.set('cursor', cursor)
      if (opts.createdAfter) q.set('created-after', String(opts.createdAfter))
      if (opts.updatedAfter) q.set('updated-after', String(opts.updatedAfter))
      const r = await this.req<{ objects: BlockResponse[]; 'next-cursor'?: string }>(
        `/api/v1/graphs/${graphId}/tags/${tagId}/objects?${q}`,
      )
      out.push(...r.objects)
      cursor = r['next-cursor']
    } while (cursor)
    return out
  }

  async listPageBlocks(graphId: string, pageId: string): Promise<BlockResponse[]> {
    const out: BlockResponse[] = []
    let cursor: string | undefined
    do {
      const q = new URLSearchParams({ limit: '200' })
      if (cursor) q.set('cursor', cursor)
      const r = await this.req<{ blocks: BlockResponse[]; 'next-cursor'?: string }>(
        `/api/v1/graphs/${graphId}/pages/${pageId}/blocks?${q}`,
      )
      out.push(...r.blocks)
      cursor = r['next-cursor']
    } while (cursor)
    return out
  }

  async getBlock(graphId: string, blockId: string): Promise<BlockResponse> {
    return this.req<BlockResponse>(`/api/v1/graphs/${graphId}/blocks/${blockId}`)
  }
}
