import { useQuery } from '@tanstack/react-query'
import { type ColumnDef } from '@tanstack/react-table'
import { api } from '../lib/api.ts'
import { DataTable } from '../components/data-table.tsx'
import { LinkIconButton } from '../components/link-icon-button.tsx'
import type { CareerPageDto } from '../../dashboard/api-types.ts'

const columns: ColumnDef<CareerPageDto, any>[] = [
  { accessorKey: 'label', header: 'Label' },
  { id: 'url', header: 'URL', enableSorting: false, cell: ({ row }) => <LinkIconButton href={row.original.url} label="Career page URL" /> },
  { accessorKey: 'addedAt', header: 'Added' },
  { accessorKey: 'lastCheckedAt', header: 'Last checked' },
  { accessorKey: 'totalScanned', header: 'Scanned (all time)' },
  { accessorKey: 'relevantFound', header: 'Relevant found (all time)' },
  { accessorKey: 'totalSkipped', header: 'Skipped (all time)' },
]

export function CareerPagesPage() {
  const { data, isLoading, error } = useQuery({ queryKey: ['career-pages'], queryFn: api.getCareerPages })

  if (isLoading) return <p className="text-muted-foreground">Loading…</p>
  if (error) return <p className="text-destructive">Failed to load career pages: {(error as Error).message}</p>

  return (
    <div>
      <h1 className="mb-6 text-2xl font-semibold">Career Pages</h1>
      <DataTable columns={columns} data={data ?? []} getRowId={(row) => row.id} searchColumns={['label']} />
      {data?.length === 0 && <p className="mt-4 text-muted-foreground">No career pages tracked yet — use /add-career-url.</p>}
    </div>
  )
}
