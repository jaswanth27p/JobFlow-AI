import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { type ColumnDef } from '@tanstack/react-table'
import { toast } from 'sonner'
import { api } from '../lib/api.ts'
import { DataTable, type BulkAction } from '../components/data-table.tsx'
import { LinkIconButton } from '../components/link-icon-button.tsx'
import { Button } from '../components/ui/button.tsx'
import { Badge } from '../components/ui/badge.tsx'
import type { ApplicationDto } from '../../dashboard/api-types.ts'

const SOURCE_LABELS: Record<string, string> = { linkedin: 'LinkedIn', career_page: 'Career Page' }

function RetryWithAnswerForm({ jobId, question }: { jobId: string; question: string }) {
  const queryClient = useQueryClient()
  const retry = useMutation({
    mutationFn: (answer: string) => api.retryApplication({ jobId, question, answer }),
    onSuccess: () => {
      toast.success('Retry queued')
      queryClient.invalidateQueries({ queryKey: ['applications'] })
    },
    onError: (err) => toast.error((err as Error).message),
  })

  return (
    <form
      className="flex flex-col gap-1"
      onSubmit={(e) => {
        e.preventDefault()
        const answer = new FormData(e.currentTarget).get('answer')
        if (typeof answer === 'string' && answer.trim()) retry.mutate(answer)
      }}
    >
      <p className="text-xs text-muted-foreground">{question}</p>
      <div className="flex gap-2">
        <input name="answer" placeholder="answer" required className="h-8 rounded-md border border-input bg-background px-2 text-sm" />
        <Button size="sm" type="submit" disabled={retry.isPending}>
          {retry.isPending ? 'Retrying…' : 'Retry'}
        </Button>
      </div>
    </form>
  )
}

function RowActions({ row }: { row: ApplicationDto }) {
  const queryClient = useQueryClient()
  const canRetryWithAnswer = row.status === 'failed' && row.failureReason === 'missing_info' && row.missingInfoQuestion

  const retryJob = useMutation({
    mutationFn: () => api.retryApplicationJob({ jobId: row.jobId }),
    onSuccess: () => {
      toast.success('Retry queued')
      queryClient.invalidateQueries({ queryKey: ['applications'] })
    },
    onError: (err) => toast.error((err as Error).message),
  })

  if (row.status !== 'failed') return null
  if (canRetryWithAnswer) return <RetryWithAnswerForm jobId={row.jobId} question={row.missingInfoQuestion!} />

  return (
    <div className="flex gap-2">
      <Button size="sm" variant="outline" disabled={retryJob.isPending} onClick={() => retryJob.mutate()}>
        {retryJob.isPending ? 'Retrying…' : 'Retry'}
      </Button>
      <LinkIconButton href={row.applyUrl} label="Apply manually" />
    </div>
  )
}

const columns: ColumnDef<ApplicationDto, any>[] = [
  { accessorKey: 'jobTitle', header: 'Job' },
  { accessorKey: 'company', header: 'Company' },
  { accessorKey: 'location', header: 'Location' },
  { accessorKey: 'source', header: 'Source', cell: ({ row }) => SOURCE_LABELS[row.original.source] ?? row.original.source },
  { accessorKey: 'applyType', header: 'Apply Type' },
  { id: 'applyUrl', header: 'Apply URL', enableSorting: false, cell: ({ row }) => <LinkIconButton href={row.original.applyUrl} label="Apply URL" /> },
  { id: 'sourceUrl', header: 'Source URL', enableSorting: false, cell: ({ row }) => <LinkIconButton href={row.original.sourceUrl} label="Source URL" /> },
  {
    accessorKey: 'status',
    header: 'Status',
    cell: ({ row }) => <Badge variant={row.original.status === 'failed' ? 'destructive' : 'secondary'}>{row.original.status}</Badge>,
  },
  { accessorKey: 'result', header: 'Result' },
  { accessorKey: 'error', header: 'Error' },
  { accessorKey: 'createdAt', header: 'Applied At' },
  { id: 'action', header: 'Action', enableSorting: false, cell: ({ row }) => <RowActions row={row.original} /> },
]

export function ApplicationsPage() {
  const queryClient = useQueryClient()
  const { data, isLoading, error } = useQuery({ queryKey: ['applications'], queryFn: api.getApplications })

  const bulkRetry = useMutation({
    mutationFn: (jobIds: string[]) => api.retryApplicationJobsBulk({ jobIds }),
    onSuccess: (res) => {
      toast.success(`Retry queued for ${res.count} application${res.count === 1 ? '' : 's'}`)
      queryClient.invalidateQueries({ queryKey: ['applications'] })
    },
    onError: (err) => toast.error((err as Error).message),
  })

  if (isLoading) return <p className="text-muted-foreground">Loading…</p>
  if (error) return <p className="text-destructive">Failed to load applications: {(error as Error).message}</p>

  // Bulk retry is a plain requeue, same as the single-row "Retry" button —
  // rows that need a missing-info answer are skipped (they'd just fail the
  // same way again) and stay selectable for the single-row retry-with-answer form.
  const bulkActions: BulkAction<ApplicationDto>[] = [
    {
      label: 'Retry selected',
      pendingLabel: 'Retrying…',
      isPending: bulkRetry.isPending,
      onClick: (rows, clearSelection) => {
        const retryable = rows.filter((r) => r.status === 'failed' && !(r.failureReason === 'missing_info' && r.missingInfoQuestion))
        if (retryable.length === 0) {
          toast.error('Selected rows need an answer first — use the per-row retry form for those.')
          return
        }
        const skipped = rows.length - retryable.length
        if (skipped > 0) toast.info(`${skipped} selected row${skipped === 1 ? '' : 's'} need an answer first — skipped.`)
        bulkRetry.mutate(
          retryable.map((r) => r.jobId),
          { onSettled: clearSelection },
        )
      },
    },
  ]

  return (
    <div>
      <h1 className="mb-6 text-2xl font-semibold">Applications</h1>
      <DataTable
        columns={columns}
        data={data ?? []}
        statusFilter={{ columnId: 'status', options: ['applied', 'failed', 'needs_input'] }}
        dateFilter={{ columnId: 'createdAt', label: 'Applied' }}
        getRowId={(row) => row.jobId}
        bulkActions={bulkActions}
        searchColumns={['jobTitle', 'company', 'location']}
      />
    </div>
  )
}
