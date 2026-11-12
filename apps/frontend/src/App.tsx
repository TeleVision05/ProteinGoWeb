import { BrowserRouter, Route, Routes } from 'react-router-dom';
import { RequireAdmin, RequirePlay, RequireUser, SessionProvider } from '@/components/session';
import { AdminPage } from '@/pages/admin-page';
import { LoginPage } from '@/pages/login-page';
import { MapPage } from '@/pages/map-page';
import { RedeemPage } from '@/pages/redeem-page';

export function App() {
  return (
    <SessionProvider>
      <BrowserRouter>
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
            path="/"
            element={
              <RequirePlay>
                <MapPage />
              </RequirePlay>
            }
          />
        </Routes>
      </BrowserRouter>
    </SessionProvider>
  );
}
