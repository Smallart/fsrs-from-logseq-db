'use client'
import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { ChevronLeft, LogOut, RefreshCw, Save, SearchCheck } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'

type Config = { id: number; token: string | null; graph_id: string | null }

type SyncReport = {
  indexed: number
  newCards: number
  updatedCards: number
  deletedCards: number
  skippedPages: string[]
  skippedCards: number
  unmatchedCards: number
  fullCheck: boolean
  startedAt: number
  finishedAt: number
} | { error: string }

export default function SettingsPage() {
  const router = useRouter()
  const [token, setToken] = useState('')
  const [graphId, setGraphId] = useState('')
  const [saving, setSaving] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [report, setReport] = useState<SyncReport | null>(null)
  const [msg, setMsg] = useState('')

  useEffect(() => {
    fetch('/api/config')
      .then((r) => r.json())
      .then((c: Config) => {
        setToken(c.token ?? '')
        setGraphId(c.graph_id ?? '')
      })
  }, [])

  async function logout() {
    await fetch('/api/auth/logout', { method: 'POST' })
    router.replace('/login')
  }

  async function saveConfig() {
    setSaving(true)
    setMsg('')
    await fetch('/api/config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, graph_id: graphId }),
    })
    setSaving(false)
    setMsg('已保存')
  }

  async function runSync(full = false) {
    setSyncing(true)
    setReport(null)
    setMsg('')
    const res = await fetch('/api/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fullCheck: full }),
    })
    setReport(await res.json())
    setSyncing(false)
  }

  return (
    <div className="mx-auto min-h-screen w-full max-w-xl space-y-4 p-4">
      <div className="flex items-center justify-between">
        <Link href="/">
          <Button variant="ghost" size="sm" className="text-muted-foreground hover:text-foreground">
            <ChevronLeft className="h-4 w-4" />
            返回
          </Button>
        </Link>
        <Button variant="ghost" size="sm" onClick={logout} className="text-muted-foreground hover:text-foreground">
          <LogOut className="h-4 w-4" />
          退出登录
        </Button>
      </div>

      <h1 className="text-xl font-bold">全局设置</h1>

        <Card>
          <CardHeader>
            <CardTitle>Logseq 凭证</CardTitle>
            <CardDescription>后端只读调用 Logseq API 所需的 PAT 与图 ID</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-1.5">
              <Label>Token (logseq_pat_…)</Label>
              <Input value={token} onChange={(e) => setToken(e.target.value)} placeholder="从 Logseq sync-worker 获取" />
            </div>
            <div className="space-y-1.5">
              <Label>Graph ID</Label>
              <Input value={graphId} onChange={(e) => setGraphId(e.target.value)} placeholder="图 UUID" />
            </div>
            <Button onClick={saveConfig} disabled={saving} className="w-full">
              <Save className="h-4 w-4" />
              {saving ? '保存中…' : '保存凭证'}
            </Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>同步</CardTitle>
            <CardDescription>增量同步快速拉取；全量校验按内容哈希比对全部卡片</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-2 gap-2">
              <Button variant="outline" onClick={() => runSync(false)} disabled={syncing}>
                <RefreshCw className="h-4 w-4" />
                {syncing ? '同步中…' : '增量同步'}
              </Button>
              <Button variant="outline" onClick={() => runSync(true)} disabled={syncing}>
                <SearchCheck className="h-4 w-4" />
                全量校验
              </Button>
            </div>

            {report && !('error' in report) && (
              <div className="space-y-2 rounded-md bg-muted/60 p-3 text-sm">
                <div className="flex flex-wrap gap-2">
                  <Badge variant="secondary">索引 {report.indexed}</Badge>
                  <Badge variant="secondary">新增 {report.newCards}</Badge>
                  <Badge variant="secondary">更新 {report.updatedCards}</Badge>
                  <Badge variant="secondary">删除 {report.deletedCards}</Badge>
                  <Badge variant="secondary">未更新 {report.unmatchedCards}</Badge>
                  <Badge variant={report.fullCheck ? 'default' : 'outline'}>
                    {report.fullCheck ? '全量' : '增量'}
                  </Badge>
                </div>
                <div className="text-muted-foreground">
                  耗时 {((report.finishedAt - report.startedAt) / 1000).toFixed(1)}s
                </div>
              </div>
            )}

            {report && !('error' in report) && report.unmatchedCards > 0 && (
              <div className="text-sm text-orange-500">
                ⚠ 检测到 {report.unmatchedCards} 张卡片有变化但未更新：这些卡片是候选，但其所在页面树中未找到对应块
              </div>
            )}

            {report && !('error' in report) && report.skippedPages.length > 0 && (
              <div className="break-all text-sm text-orange-500">
                ⚠ 跳过 {report.skippedCards} 张卡片：它们挂在 Logseq 保留页面（tag 页面等）下，API
                无法读取其内容，请把这些卡片移到普通页面。页面 ID：
                {report.skippedPages.join('、')}
              </div>
            )}

            {report && 'error' in report && <div className="text-sm text-destructive">{report.error}</div>}
            {msg && <div className="text-sm text-emerald-600">{msg}</div>}
          </CardContent>
        </Card>
    </div>
  )
}
