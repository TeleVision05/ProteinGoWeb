import { BrowserRouter, Route, Routes } from 'react-router-dom';
import { ArProvider } from '@/components/ar-provider';
import { Toaster } from '@/components/toaster';
import { RequireAdmin, RequirePlay, RequireUser, SessionProvider } from '@/components/session';
import { AdminPage } from '@/pages/admin-page';
import { AssignmentsPage } from '@/pages/assignments-page';
import { CollectionPage } from '@/pages/collection-page';
import { LeaderboardPage } from '@/pages/leaderboard-page';
import { LoginPage } from '@/pages/login-page';
import { MapPage } from '@/pages/map-page';
import { RedeemPage } from '@/pages/redeem-page';

export function App() {
  return (
    <SessionProvider>
      <Toaster />
      <ArProvider>
      <BrowserRouter basename={import.meta.env.BASE_URL.replace(/\/$/, '')}>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route
            path="/redeem"
            element={
              <RequireUser>
                <RedeemPage />
              </RequireUser>
            }
          />
          <Route
            path="/admin"
            element={
              <RequireAdmin>
                <AdminPage />
              </RequireAdmin>
            }
          />
          <Route
            path="/collection"
            element={
              <RequirePlay>
                <CollectionPage />
              </RequirePlay>
            }
          />
          <Route
            path="/assignments"
            element={
              <RequirePlay>
                <AssignmentsPage />
              </RequirePlay>
            }
          />
          <Route
            path="/leaderboard"
            element={
              <RequirePlay>
                <LeaderboardPage />
              </RequirePlay>
            }
          />
          <Route
            path="/"
            element={
              <RequirePlay>
                <MapPage />
              </RequirePlay>
            }
          />
        </Routes>
      </BrowserRouter>
      </ArProvider>
    </SessionProvider>
  );
}
