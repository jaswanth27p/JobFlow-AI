import { NavLink, Outlet } from 'react-router-dom'
import { Toaster } from './components/ui/sonner.tsx'

const NAV_ITEMS = [
  { to: '/', label: 'Summary', end: true },
  { to: '/applications', label: 'Applications', end: false },
  { to: '/external-jobs', label: 'External Jobs', end: false },
  { to: '/review', label: 'Review', end: false },
  { to: '/career-pages', label: 'Career Pages', end: false },
]

export function Layout() {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <nav className="flex gap-1 border-b px-6 py-3">
        {NAV_ITEMS.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.end}
            className={({ isActive }) =>
              `rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
                isActive ? 'bg-accent text-accent-foreground' : 'text-muted-foreground hover:bg-accent/50'
              }`
            }
          >
            {item.label}
          </NavLink>
        ))}
      </nav>
      <main className="mx-auto max-w-6xl px-6 py-8">
        <Outlet />
      </main>
      <Toaster />
    </div>
  )
}
