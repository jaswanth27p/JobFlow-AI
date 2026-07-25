import { BrowserRouter, Routes, Route } from 'react-router-dom'
import { QueryClientProvider } from '@tanstack/react-query'
import { queryClient } from './lib/queryClient.ts'
import { Layout } from './Layout.tsx'
import { SummaryPage } from './pages/Summary.tsx'
import { ApplicationsPage } from './pages/Applications.tsx'
import { ExternalJobsPage } from './pages/ExternalJobs.tsx'
import { ReviewPage } from './pages/Review.tsx'
import { CareerPagesPage } from './pages/CareerPages.tsx'

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <Routes>
          <Route element={<Layout />}>
            <Route index element={<SummaryPage />} />
            <Route path="applications" element={<ApplicationsPage />} />
            <Route path="external-jobs" element={<ExternalJobsPage />} />
            <Route path="review" element={<ReviewPage />} />
            <Route path="career-pages" element={<CareerPagesPage />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>
  )
}
