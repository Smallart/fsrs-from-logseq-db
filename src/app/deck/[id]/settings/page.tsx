'use client'
import { useEffect, useState } from 'react'
import Link from 'next/link'
import { ChevronLeft } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Separator } from '@/components/ui/separator'

type DeckFsrs = {
  request_retention: number
  maximum_interval: number
  enable_fuzz: boolean
  enable_short_term: boolean
  w: number[]
  day_start: number
}

type Deck = {
  id: number
  name: string
  desk_name?: string | null
  fsrs: DeckFsrs
  card_limit: { new: number; review: number; learning: number }
  p_due: number
}

function NumField({
  label,
  value,
  onChange,
  hint,
}: {
  label: string
  value: number
  onChange: (v: number) => void
  hint?: string
}) {
  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      <Input
        type="number"
        value={value}
        step="any"
        onChange={(e) => onChange(e.target.value === '' ? 0 : +e.target.value)}
      />
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  )
}

export default function DeckSettingsPage({ params }: { params: { id: string } }) {
  const deckId = Number(params.id)
  const [deck, setDeck] = useState<Deck | null>(null)
  const [f, setF] = useState<DeckFsrs | null>(null)
  const [cl, setCl] = useState<Deck['card_limit'] | null>(null)
  const [pDue, setPDue] = useState(0)
  const [wText, setWText] = useState('')
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState('')
  const [err, setErr] = useState('')

  useEffect(() => {
    fetch('/api/decks')
      .then((r) => r.json())
      .then((d) => {
        const hit: Deck | undefined = (d?.decks ?? []).find((x: Deck) => x.id === deckId)
        if (hit) {
          setDeck(hit)
          setF(hit.fsrs)
          setCl(hit.card_limit)
          setPDue(hit.p_due)
          setWText(JSON.stringify(hit.fsrs.w))
        }
      })
  }, [deckId])

  async function save() {
    if (!f || !cl) return
    setSaving(true)
    setErr('')
    setMsg('')
    try {
      const w = JSON.parse(wText)
      if (!Array.isArray(w) || w.some((x: unknown) => typeof x !== 'number')) {
        throw new Error('w 必须是数字数组（JSON）')
      }
      const res = await fetch(`/api/decks/${deckId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fsrs: { ...f, w }, card_limit: cl, p_due: pDue }),
      })
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? '保存失败')
      setMsg('已保存')
    } catch (e: any) {
      setErr(e?.message ?? '保存失败')
    } finally {
      setSaving(false)
    }
  }

  if (!deck || !f || !cl) {
    return (
      <div className="mx-auto max-w-xl p-8 text-center text-sm text-muted-foreground">
        {deck === null ? '加载中…' : '未找到该 deck'}
      </div>
    )
  }

  return (
    <div className="mx-auto min-h-screen w-full max-w-xl space-y-4 p-4">
      {/* Breadcrumb: 复习 › Deck 参数（当前页，不可跳转全局设置） */}
      <nav className="flex items-center gap-2 text-sm">
        <Link href={`/review?deck=${deckId}`} className="flex items-center gap-1 text-muted-foreground transition-colors hover:text-foreground">
          <ChevronLeft className="h-4 w-4" />
          复习
        </Link>
        <span className="text-muted-foreground">›</span>
        <span className="font-medium">Deck 参数</span>
      </nav>

      <Card>
        <CardHeader>
          <CardTitle>{deck.desk_name ?? deck.name} · Deck 参数</CardTitle>
          <CardDescription>FSRS 调度参数与每日卡片上限，保存后立即生效</CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <section className="space-y-3">
            <h4 className="text-sm font-semibold">FSRS 参数</h4>
            <div className="grid grid-cols-2 gap-3">
              <NumField
                label="目标保留率"
                hint="0.7 ~ 0.97"
                value={f.request_retention}
                onChange={(v) => setF({ ...f, request_retention: v })}
              />
              <NumField
                label="最大间隔（天）"
                value={f.maximum_interval}
                onChange={(v) => setF({ ...f, maximum_interval: v })}
              />
              <NumField
                label="日界（小时）"
                hint="如 3 = 凌晨 3 点前算前一天"
                value={f.day_start}
                onChange={(v) => setF({ ...f, day_start: v })}
              />
              <NumField
                label="复习优先概率 p_due"
                hint="复习与新卡混合时的复习占比"
                value={pDue}
                onChange={setPDue}
              />
            </div>
            <div className="flex flex-wrap gap-6 pt-1">
              <div className="flex items-center gap-2">
                <Switch checked={f.enable_fuzz} onCheckedChange={(v) => setF({ ...f, enable_fuzz: v })} />
                <Label className="text-foreground">启用模糊 (fuzz)</Label>
              </div>
              <div className="flex items-center gap-2">
                <Switch
                  checked={f.enable_short_term}
                  onCheckedChange={(v) => setF({ ...f, enable_short_term: v })}
                />
                <Label className="text-foreground">启用短程调度 (short_term)</Label>
              </div>
            </div>
            <div className="space-y-1.5">
              <Label>FSRS 权重 w（JSON 数字数组，一般不需要改）</Label>
              <Input value={wText} onChange={(e) => setWText(e.target.value)} />
            </div>
          </section>

          <Separator />

          <section className="space-y-3">
            <h4 className="text-sm font-semibold">每日上限</h4>
            <div className="grid max-w-xs gap-3">
              <NumField label="新卡" value={cl.new} onChange={(v) => setCl({ ...cl, new: v })} />
            </div>
          </section>

          {msg && <div className="text-sm text-emerald-600">{msg}</div>}
          {err && <div className="text-sm text-destructive">{err}</div>}

          <Button onClick={save} disabled={saving} className="w-full">
            {saving ? '保存中…' : '保存参数'}
          </Button>
        </CardContent>
      </Card>
    </div>
  )
}
