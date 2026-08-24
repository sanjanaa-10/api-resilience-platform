import { BrowserRouter, Outlet, Route, Routes } from 'react-router-dom'
import { GatewayDataProvider } from './hooks/useGatewayData'
import { AppShell } from './components/layout/AppShell'
import { OverviewPage } from './pages/OverviewPage'
import { ServicesPage } from './pages/ServicesPage'
import { IncidentsPage } from './pages/IncidentsPage'
import { AnomaliesPage } from './pages/AnomaliesPage'
import { MetricsPage } from './pages/MetricsPage'
import { EventsPage } from './pages/EventsPage'

function NotFound() {
  return (
    <div className="flex flex-col items-center gap-3 py-24 text-center">
      <p className="font-serif text-6xl tracking-tight text-lavender">404</p>
      <p className="text-sm text-soft">This corridor of the command center does not exist.</p>
    </div>
  )
}

function Layout() {
  return (
    <GatewayDataProvider>
      <AppShell>
        <Outlet />
      </AppShell>
    </GatewayDataProvider>
  )
}

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route element={<Layout />}>
          <Route index element={<OverviewPage />} />
          <Route path="services" element={<ServicesPage />} />
          <Route path="incidents" element={<IncidentsPage />} />
          <Route path="anomalies" element={<AnomaliesPage />} />
          <Route path="metrics" element={<MetricsPage />} />
          <Route path="events" element={<EventsPage />} />
          <Route path="*" element={<NotFound />} />
        </Route>
      </Routes>
    </BrowserRouter>
  )
}
