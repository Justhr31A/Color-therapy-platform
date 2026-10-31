import { Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider } from './auth/AuthContext';
import ProtectedRoute from './auth/ProtectedRoute';
import LoginPage from './pages/LoginPage';
import RegisterPage from './pages/RegisterPage';
import DashboardPage from './pages/DashboardPage';
import ProtocolStudioPage from './pages/ProtocolStudioPage';
import AdminConditionsPage from './pages/admin/AdminConditionsPage';
import AdminAiSettingsPage from './pages/admin/AdminAiSettingsPage';
import AdminPaymentsPage from './pages/admin/AdminPaymentsPage';
import PatientActivatePage from './pages/patient/PatientActivatePage';
import PatientDashboardPage from './pages/patient/PatientDashboardPage';
import PatientProtocolPage from './pages/patient/PatientProtocolPage';
import CameraSessionPage from './pages/patient/CameraSessionPage';
import HomePage from './pages/public/HomePage';
import ProtocolBrowserPage from './pages/public/ProtocolBrowserPage';
import ProtocolDetailsPage from './pages/public/ProtocolDetailsPage';
import FindProtocolPage from './pages/public/FindProtocolPage';
import PublicCameraPage from './pages/public/PublicCameraPage';
import AdminCameraSettingsPage from './pages/admin/AdminCameraSettingsPage';
import AdminHandReferencePage from './pages/admin/AdminHandReferencePage';

export default function App() {
  return (
    <AuthProvider>
      <Routes>
        {/* Public site: visible to everyone, logged in or not — no auth check, no redirect. */}
        <Route path="/" element={<HomePage />} />
        <Route path="/protocols" element={<ProtocolBrowserPage />} />
        <Route path="/protocols/:slug" element={<ProtocolDetailsPage />} />
        {/* Live camera AR for a PUBLISHED protocol — public, no login, no patient assignment (off unless an admin turns it on). */}
        <Route path="/protocols/:slug/camera" element={<PublicCameraPage />} />
        <Route path="/protocols/:slug/camera/:viewKey" element={<PublicCameraPage />} />
        <Route path="/find-protocol" element={<FindProtocolPage />} />

        <Route path="/login" element={<LoginPage />} />
        <Route path="/register" element={<RegisterPage />} />
        <Route path="/patient/activate" element={<PatientActivatePage />} />

        <Route element={<ProtectedRoute roles={['doctor', 'admin']} />}>
          <Route path="/dashboard" element={<DashboardPage />} />
          <Route path="/builder/:id" element={<ProtocolStudioPage />} />
        </Route>

        <Route element={<ProtectedRoute role="admin" />}>
          <Route path="/admin/conditions" element={<AdminConditionsPage />} />
          <Route path="/admin/ai" element={<AdminAiSettingsPage />} />
          <Route path="/admin/camera" element={<AdminCameraSettingsPage />} />
          <Route path="/admin/hand-reference" element={<AdminHandReferencePage />} />
          <Route path="/admin/payments" element={<AdminPaymentsPage />} />
        </Route>

        <Route element={<ProtectedRoute role="patient" />}>
          <Route path="/patient/dashboard" element={<PatientDashboardPage />} />
          <Route path="/patient/protocols/:id" element={<PatientProtocolPage />} />
          <Route path="/patient/protocols/:id/session/:viewKey" element={<CameraSessionPage />} />
        </Route>

        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </AuthProvider>
  );
}
