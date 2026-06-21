import { HashRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AppProvider, useApp } from './state/FilterContext';
import { AppLayout } from './components/AppLayout';
import { ErrorState, Skeleton } from './components/States';
import { Dashboard } from './screens/Dashboard';
import { Transactions } from './screens/Transactions';
import { Funds } from './screens/Funds';
import { PnL } from './screens/PnL';
import { Users } from './screens/Users';
import { Settings } from './screens/Settings';
import { Chat } from './screens/Chat';
import { More } from './screens/More';
import { Employees } from './screens/Employees';
import { Contractors } from './screens/Contractors';
import { AICommands } from './screens/AICommands';

function Gate() {
  const { sessionLoading, sessionError, retrySession } = useApp();

  if (sessionLoading) {
    return (
      <div className="mx-auto flex min-h-screen max-w-app flex-col gap-4 bg-bg-deep p-4">
        <Skeleton className="h-12 w-1/2" />
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-48 w-full" />
      </div>
    );
  }

  if (sessionError) {
    return (
      <div className="mx-auto flex min-h-screen max-w-app items-center bg-bg-deep">
        <ErrorState
          message={`Не удалось распознать сессию. ${sessionError}`}
          onRetry={retrySession}
        />
      </div>
    );
  }

  return (
    <AppLayout>
      <Routes>
        <Route path="/dashboard" element={<Dashboard />} />
        <Route path="/transactions" element={<Transactions />} />
        <Route path="/pnl" element={<PnL />} />
        <Route path="/funds" element={<Funds />} />
        <Route path="/users" element={<Users />} />
        <Route path="/settings" element={<Settings />} />
        <Route path="/chat" element={<Chat />} />
        <Route path="/more" element={<More />} />
        <Route path="/employees" element={<Employees />} />
        <Route path="/contractors" element={<Contractors />} />
        <Route path="/ai-commands" element={<AICommands />} />
        <Route path="*" element={<Navigate to="/dashboard" replace />} />
      </Routes>
    </AppLayout>
  );
}

export function App() {
  return (
    <AppProvider>
      <HashRouter>
        <Gate />
      </HashRouter>
    </AppProvider>
  );
}
