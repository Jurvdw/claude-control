import { Routes, Route, Navigate, useLocation } from 'react-router-dom';
import { AuthProvider, useAuth } from './state/AuthContext';
import { NotificationProvider } from './state/NotificationContext';
import { ServerProvider } from './state/ServerContext';
import { TourProvider } from './state/TourContext';
import { ThemeProvider } from './state/ThemeContext';
import LoginPage from './pages/LoginPage';
import RegisterPage from './pages/RegisterPage';
import OnboardingPage from './pages/OnboardingPage';
import AppPage from './pages/AppPage';
import Toasts from './components/Toasts';

function Loading() {
  return (
    <div className="h-full flex items-center justify-center text-cream-400">
      <div className="animate-pulse-dot text-clay text-2xl font-semibold">Claude Control</div>
    </div>
  );
}

function RequireAuth({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  const location = useLocation();
  if (loading) return <Loading />;
  if (!user) return <Navigate to="/login" replace state={{ from: location }} />;
  return <>{children}</>;
}

function Shell() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/register" element={<RegisterPage />} />
      <Route path="/onboarding" element={<RequireAuth><OnboardingPage /></RequireAuth>} />
      <Route
        path="/:serverId?/:channelId?"
        element={
          <RequireAuth>
            <ServerProvider>
              <TourProvider>
                <AppPage />
              </TourProvider>
            </ServerProvider>
          </RequireAuth>
        }
      />
    </Routes>
  );
}

export default function App() {
  return (
    <ThemeProvider>
      <AuthProvider>
        <NotificationProvider>
          <div className="h-full">
            <Shell />
            <Toasts />
          </div>
        </NotificationProvider>
      </AuthProvider>
    </ThemeProvider>
  );
}
