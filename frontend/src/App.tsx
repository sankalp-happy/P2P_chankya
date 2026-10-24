import { lazy, Suspense } from 'react';
import { Route, Routes } from 'react-router-dom';
import Shell from './components/Shell';
import { Skeleton } from './components/ui';
import Overview from './pages/Overview';

const BuildingDetail = lazy(() => import('./pages/BuildingDetail'));
const SmartBin = lazy(() => import('./pages/SmartBin'));
const Offline = lazy(() => import('./pages/Offline'));
const League = lazy(() => import('./pages/League'));
const Waste = lazy(() => import('./pages/Waste'));
const Models = lazy(() => import('./pages/Models'));

export default function App() {
  return (
    <Shell>
      <Suspense fallback={<Skeleton className="h-[60vh]" />}>
        <Routes>
          <Route path="/" element={<Overview />} />
          <Route path="/building" element={<BuildingDetail />} />
          <Route path="/bin" element={<SmartBin />} />
          <Route path="/offline" element={<Offline />} />
          <Route path="/league" element={<League />} />
          <Route path="/waste" element={<Waste />} />
          <Route path="/models" element={<Models />} />
        </Routes>
      </Suspense>
    </Shell>
  );
}
