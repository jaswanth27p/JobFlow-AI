import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { type ColumnDef } from '@tanstack/react-table'
import { toast } from 'sonner'
import { api } from '../lib/api.ts'
import { DataTable, type BulkAction } from '../components/data-table.tsx'
import { LinkIconButton } from '../components/link-icon-button.tsx'
import { Button } from '../components/ui/button.tsx'
import { Badge } from '../components/ui/badge.tsx'
import type { ExternalJobDto } from '../../dashboard/api-types.ts'

const SOURCE_LABELS: Record<string, string> = { linkedin: 'LinkedIn', career_page: 'Career Page' }

function MarkAppliedButton({ jobId }: { jobId: string }) {
  const queryClient = useQueryClient()
  const mutation = useMutation({
    mutationFn: () => api.markExternalJobApplied({ jobId }),
    onSuccess: () => {
      toast.success('Marked applied')
      queryClient.invalidateQueries({ queryKey: ['external-jobs'] })
    },
    onError: (err) => toast.error((err as Error).message),
  })

  return (
    <Button size="sm" variant="outline" disabled={mutation.isPending} onClick={() => mutation.mutate()}>
      {mutation.isPending ? 'Marking…' : 'Mark Applied'}
    </Button>
  )
}

const columns: ColumnDef<ExternalJobDto, any>[] = [
  { accessorKey: 'title', header: 'Job' },
  { accessorKey: 'company', header: 'Company' },
  { accessorKey: 'location', header: 'Location' },
  { accessorKey: 'source', header: 'Source', cell: ({ row }) => SOURCE_LABELS[row.original.source] ?? row.original.source },
  { accessorKey: 'applyType', header: 'Apply Type' },
  { id: 'applyUrl', header: 'Apply URL', enableSorting: false, cell: ({ row }) => <LinkIconButton href={row.original.applyUrl} label="Apply URL" /> },
  { id: 'sourceUrl', header: 'Source URL', enableSorting: false, cell: ({ row }) => <LinkIconButton href={row.original.sourceUrl} label="Source URL" /> },
  {
    accessorKey: 'status',
    header: 'Status',
    cell: ({ row }) => <Badge variant={row.original.status === 'applied' ? 'secondary' : 'default'}>{row.original.status}</Badge>,
  },
  { accessorKey: 'createdAt', header: 'Found' },
  {
    id: 'action',
    header: 'Action',
    enableSorting: false,
    cell: ({ row }) => (row.original.status === 'applied' ? null : <MarkAppliedButton jobId={row.original.id} />),
  },
]

export function ExternalJobsPage() {
  const queryClient = useQueryClient()
  const { data, isLoading, error } = useQuery({ queryKey: ['external-jobs'], queryFn: api.getExternalJobs })

  const bulkMarkApplied = useMutation({
    mutationFn: (jobIds: string[]) => api.markExternalJobsAppliedBulk({ jobIds }),
    onSuccess: (res) => {
      toast.success(`Marked ${res.count} job${res.count === 1 ? '' : 's'} applied`)
      queryClient.invalidateQueries({ queryKey: ['external-jobs'] })
    },
    onError: (err) => toast.error((err as Error).message),
  })

  if (isLoading) return <p className="text-muted-foreground">Loading…</p>
  if (error) return <p className="text-destructive">Failed to load external jobs: {(error as Error).message}</p>

  // Only jobs still 'external_saved' can be marked applied — a row already
  // applied in the selection is silently excluded rather than erroring the batch.
  const bulkActions: BulkAction<ExternalJobDto>[] = [
    {
      label: 'Mark Applied',
      pendingLabel: 'Marking…',
      isPending: bulkMarkApplied.isPending,
      onClick: (rows, clearSelection) => {
        const outstanding = rows.filter((r) => r.status !== 'applied')
        if (outstanding.length === 0) {
          toast.info('All selected jobs are already marked applied.')
          clearSelection()
          return
        }
        bulkMarkApplied.mutate(
          outstanding.map((r) => r.id),
          { onSettled: clearSelection },
        )
      },
    },
  ]

  return (
    <div>
      <h1 className="mb-6 text-2xl font-semibold">External Jobs</h1>
      <DataTable
        columns={columns}
        data={data ?? []}
        statusFilter={{ columnId: 'status', options: ['external_saved', 'applied'], defaultValue: 'external_saved' }}
        getRowId={(row) => row.id}
        bulkActions={bulkActions}
      />
      {data?.length === 0 && <p className="mt-4 text-muted-foreground">No external jobs saved yet.</p>}
    </div>
  )
}
