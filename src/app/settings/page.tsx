'use client'
import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { ChevronLeft, LogOut, RefreshCw, Save } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'

type Config = { id: number; gatewayUrl: string | null }

type SyncReport = {
  pulled: number
  newCards: number
  contentUpdated: number
  stateUpdated: number
  keptDirty: number
  deletedCards: number
  decksCreated: number
  pushed: number
  pushConflicts: number
  pushFailed: number
  fullCheck: boolean
  startedAt: number
  finishedAt: number
} | { error: string }

export default function SettingsPage() {
  const router = useRouter()
  const [gatewayUrl, setGatewayUrl] = useState('')
  const [saving, setSaving] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [report, setReport] = useState<SyncReport | null>(null)
  const [msg, setMsg] = useState('')

  useEffect(() => {
    fetch('/api/config')
      .then((r) => r.json())
      .then((c: Config) => setGatewayUrl(c.gatewayUrl ?? ''))
  }, [])

  async function logout() {
    await fetch('/api/auth/logout', { method: 'POST' })
    router.replace('/login')
  }

  async function saveConfig() {
    setSaving(true)
    setMsg('')
    const res = await fetch('/api/config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ gatewayUrl: gatewayUrl.trim() }),
    })
    setSaving(false)
    setMsg(res.ok ? '已保存' : (await res.json().catch(() => ({}))).error ?? '保存失败')
  }

  async function runSync() {
    setSyncing(true)
    setReport(null)
    setMsg('')
    const res = await fetch('/api/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fullCheck: true }),
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
          <CardTitle>网关地址</CardTitle>
          <CardDescription>
            logseq-cli2http 网关的 URL——应用读写 Logseq 卡片与 FSRS 状态的唯一通道
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-1.5">
            <Label>网关 URL</Label>
            <Input
              value={gatewayUrl}
              onChange={(e) => setGatewayUrl(e.target.value)}
              placeholder="如 http://127.0.0.1:3000"
            />
          </div>
          <Button onClick={saveConfig} disabled={saving} className="w-full">
            <Save className="h-4 w-4" />
            {saving ? '保存中…' : '保存'}
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>同步</CardTitle>
          <CardDescription>
            从网关全量拉取卡片：内容跟随 Logseq，FSRS 状态按 lastReview 仲裁（最新者赢），未推送的本地复习会自动补推
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <Button onClick={runSync} disabled={syncing} className="w-full">
            <RefreshCw className="h-4 w-4" />
            {syncing ? '同步中…' : '立即同步'}
          </Button>

          {report && !('error' in report) && (
            <div className="space-y-2 rounded-md bg-muted/60 p-3 text-sm">
              <div className="flex flex-wrap gap-2">
                <Badge variant="secondary">拉取 {report.pulled}</Badge>
                <Badge variant="secondary">新增 {report.newCards}</Badge>
                <Badge variant="secondary">内容更新 {report.contentUpdated}</Badge>
                <Badge variant="secondary">状态更新 {report.stateUpdated}</Badge>
                <Badge variant="secondary">删除 {report.deletedCards}</Badge>
              </div>
              <div className="flex flex-wrap gap-2">
                <Badge variant={report.pushFailed > 0 ? 'destructive' : 'outline'}>补推 {report.pushed}</Badge>
                <Badge variant="outline">推送冲突 {report.pushConflicts}</Badge>
                <Badge variant={report.pushFailed > 0 ? 'destructive' : 'outline'}>
                  推送失败 {report.pushFailed}
                </Badge>
              </div>
              <div className="text-muted-foreground">
                耗时 {((report.finishedAt - report.startedAt) / 1000).toFixed(1)}s
              </div>
            </div>
          )}

          {report && !('error' in report) && report.pushFailed > 0 && (
            <div className="text-sm text-orange-500">
              ⚠ {report.pushFailed} 张卡的复习结果未能写回 Logseq（网关不可达或无 dbId），已保留待下次同步补推
            </div>
          )}

          {report && 'error' in report && <div className="text-sm text-destructive">{report.error}</div>}
          {msg && <div className="text-sm text-emerald-600">{msg}</div>}
        </CardContent>
      </Card>
    </div>
  )
}
