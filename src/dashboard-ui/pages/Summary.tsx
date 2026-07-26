import { useQuery } from '@tanstack/react-query'
import { api } from '../lib/api.ts'
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card.tsx'

export function SummaryPage() {
  const { data, isLoading, error } = useQuery({ queryKey: ['summary'], queryFn: api.getSummary })

  if (isLoading) return <p className="text-muted-foreground">Loading…</p>
  if (error) return <p className="text-destructive">Failed to load summary: {(error as Error).message}</p>
  if (!data) return null

  const stats = [
    { label: 'Easy applied today', value: data.applied },
    { label: 'Externals saved today', value: data.externalSaved },
    { label: 'Failed today', value: data.failed },
    { label: 'Queue waiting', value: data.queueWaiting },
    { label: 'Queue active', value: data.queueActive },
  ]

  return (
    <div>
      <h1 className="mb-6 text-2xl font-semibold">Today</h1>
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
        {stats.map((s) => (
          <Card key={s.label}>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">{s.label}</CardTitle>
            </CardHeader>
            <CardContent className="text-2xl font-bold">{s.value}</CardContent>
          </Card>
        ))}
      </div>
    </div>
  )
}
