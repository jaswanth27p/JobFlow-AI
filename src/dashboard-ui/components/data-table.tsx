import * as React from 'react'
import {
  type ColumnDef,
  type FilterFn,
  type RowSelectionState,
  type SortingState,
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getSortedRowModel,
  useReactTable,
} from '@tanstack/react-table'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from './ui/table.tsx'
import { Input } from './ui/input.tsx'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select.tsx'
import { Checkbox } from './ui/checkbox.tsx'
import { Button, type ButtonProps } from './ui/button.tsx'

export interface StatusFilterConfig {
  columnId: string
  options: string[]
  defaultValue?: string
}

export interface DateFilterConfig {
  columnId: string
  /** Shown in the date inputs' aria-label, e.g. "Applied" — defaults to "Date". */
  label?: string
}

/** One button in the bulk-actions toolbar that appears once at least one row
 * is selected. `onClick` receives the selected rows and a `clearSelection`
 * callback — the caller decides when to clear (typically its mutation's
 * onSuccess), so a failed bulk action leaves the selection intact for retry. */
export interface BulkAction<TData> {
  label: string
  pendingLabel?: string
  variant?: ButtonProps['variant']
  isPending?: boolean
  onClick: (selectedRows: TData[], clearSelection: () => void) => void
}

export interface DataTableProps<TData> {
  columns: ColumnDef<TData, any>[]
  data: TData[]
  statusFilter?: StatusFilterConfig
  dateFilter?: DateFilterConfig
  /** Stable per-row id (e.g. `(row) => row.jobId`) — required for selection
   * to survive sorting/filtering and to report the right ids to bulk actions. */
  getRowId?: (row: TData) => string
  bulkActions?: BulkAction<TData>[]
  /** Keys on TData the search box matches against (e.g. `['jobTitle', 'company',
   * 'location']`). Omit to fall back to TanStack's default fuzzy match across
   * every column, including ones like URLs/errors a user never searches by. */
  searchColumns?: (keyof TData & string)[]
}

const ALL_STATUSES = '__all__'

export function DataTable<TData>({ columns, data, statusFilter, dateFilter, getRowId, bulkActions, searchColumns }: DataTableProps<TData>) {
  const [sorting, setSorting] = React.useState<SortingState>([])
  const [globalFilter, setGlobalFilter] = React.useState('')
  const [statusValue, setStatusValue] = React.useState(statusFilter?.defaultValue ?? ALL_STATUSES)
  const [dateFrom, setDateFrom] = React.useState('')
  const [dateTo, setDateTo] = React.useState('')
  const [rowSelection, setRowSelection] = React.useState<RowSelectionState>({})

  const scopedFilterFn = React.useMemo<FilterFn<TData> | undefined>(() => {
    if (!searchColumns || searchColumns.length === 0) return undefined
    return (row, _columnId, filterValue) => {
      const term = String(filterValue).toLowerCase().trim()
      if (!term) return true
      return searchColumns.some((key) => String(row.original[key] ?? '').toLowerCase().includes(term))
    }
  }, [searchColumns])

  const filteredData = React.useMemo(() => {
    let rows = data
    if (statusFilter && statusValue !== ALL_STATUSES) {
      rows = rows.filter((row) => String((row as Record<string, unknown>)[statusFilter.columnId]) === statusValue)
    }
    if (dateFilter && (dateFrom || dateTo)) {
      const fromTime = dateFrom ? new Date(`${dateFrom}T00:00:00`).getTime() : undefined
      const toTime = dateTo ? new Date(`${dateTo}T23:59:59.999`).getTime() : undefined
      rows = rows.filter((row) => {
        const raw = (row as Record<string, unknown>)[dateFilter.columnId]
        if (!raw) return false
        const time = new Date(String(raw)).getTime()
        if (Number.isNaN(time)) return false
        if (fromTime !== undefined && time < fromTime) return false
        if (toTime !== undefined && time > toTime) return false
        return true
      })
    }
    return rows
  }, [data, statusFilter, statusValue, dateFilter, dateFrom, dateTo])

  const tableColumns = React.useMemo<ColumnDef<TData, any>[]>(() => {
    if (!bulkActions || bulkActions.length === 0) return columns
    const selectColumn: ColumnDef<TData, any> = {
      id: '__select',
      enableSorting: false,
      header: ({ table }) => (
        <Checkbox
          checked={table.getIsAllPageRowsSelected() ? true : table.getIsSomePageRowsSelected() ? 'indeterminate' : false}
          onCheckedChange={(value) => table.toggleAllPageRowsSelected(value === true)}
          aria-label="Select all rows"
        />
      ),
      cell: ({ row }) => (
        <Checkbox checked={row.getIsSelected()} onCheckedChange={(value) => row.toggleSelected(value === true)} aria-label="Select row" />
      ),
    }
    return [selectColumn, ...columns]
  }, [columns, bulkActions])

  const table = useReactTable({
    data: filteredData,
    columns: tableColumns,
    state: { sorting, globalFilter, rowSelection },
    getRowId: getRowId ? (row) => getRowId(row as TData) : undefined,
    enableRowSelection: Boolean(bulkActions && bulkActions.length > 0),
    globalFilterFn: scopedFilterFn,
    onSortingChange: setSorting,
    onGlobalFilterChange: setGlobalFilter,
    onRowSelectionChange: setRowSelection,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
  })

  const selectedRows = table.getSelectedRowModel().rows.map((r) => r.original)
  const clearSelection = React.useCallback(() => setRowSelection({}), [])

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        {statusFilter && (
          <Select value={statusValue} onValueChange={setStatusValue}>
            <SelectTrigger className="w-48">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL_STATUSES}>All statuses</SelectItem>
              {statusFilter.options.map((opt) => (
                <SelectItem key={opt} value={opt}>
                  {opt}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        {dateFilter && (
          <div className="flex items-center gap-1">
            <Input
              type="date"
              value={dateFrom}
              onChange={(e) => setDateFrom(e.target.value)}
              className="w-36"
              aria-label={`${dateFilter.label ?? 'Date'} from`}
            />
            <span className="text-sm text-muted-foreground">to</span>
            <Input
              type="date"
              value={dateTo}
              onChange={(e) => setDateTo(e.target.value)}
              className="w-36"
              aria-label={`${dateFilter.label ?? 'Date'} to`}
            />
            {(dateFrom || dateTo) && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setDateFrom('')
                  setDateTo('')
                }}
              >
                Clear
              </Button>
            )}
          </div>
        )}
        <Input
          placeholder={searchColumns ? `Search ${searchColumns.join(', ')}...` : 'Search...'}
          value={globalFilter}
          onChange={(e) => setGlobalFilter(e.target.value)}
          className="max-w-xs"
        />
        {bulkActions && selectedRows.length > 0 && (
          <div className="ml-auto flex items-center gap-2 rounded-md border bg-muted/50 px-3 py-1.5">
            <span className="text-sm text-muted-foreground">{selectedRows.length} selected</span>
            {bulkActions.map((action) => (
              <Button
                key={action.label}
                size="sm"
                variant={action.variant ?? 'outline'}
                disabled={action.isPending}
                onClick={() => action.onClick(selectedRows, clearSelection)}
              >
                {action.isPending ? (action.pendingLabel ?? `${action.label}…`) : action.label}
              </Button>
            ))}
            <Button size="sm" variant="ghost" onClick={clearSelection}>
              Clear
            </Button>
          </div>
        )}
      </div>
      <div className="overflow-x-auto rounded-md border">
        <Table>
          <TableHeader>
            {table.getHeaderGroups().map((hg) => (
              <TableRow key={hg.id}>
                {hg.headers.map((header) => (
                  <TableHead
                    key={header.id}
                    onClick={header.column.getToggleSortingHandler()}
                    className={header.column.getCanSort() ? 'cursor-pointer select-none' : undefined}
                  >
                    {flexRender(header.column.columnDef.header, header.getContext())}
                    {{ asc: ' ▲', desc: ' ▼' }[header.column.getIsSorted() as string] ?? ''}
                  </TableHead>
                ))}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody>
            {table.getRowModel().rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={tableColumns.length} className="text-center text-muted-foreground">
                  No results.
                </TableCell>
              </TableRow>
            ) : (
              table.getRowModel().rows.map((row) => (
                <TableRow key={row.id} data-state={row.getIsSelected() ? 'selected' : undefined} className="data-[state=selected]:bg-muted/50">
                  {row.getVisibleCells().map((cell) => {
                    const value = cell.getValue()
                    const titleAttr = typeof value === 'string' && value ? value : undefined
                    return (
                      <TableCell key={cell.id} title={titleAttr}>
                        {flexRender(cell.column.columnDef.cell, cell.getContext())}
                      </TableCell>
                    )
                  })}
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  )
}
