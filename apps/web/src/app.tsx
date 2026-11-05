import { lazy } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { useAuth } from '@/hooks/use-auth';
import { Loading, ErrorNotice } from '@/components/feedback';
import { Layout } from '@/components/layout';
import { LoginPage } from '@/pages/login';
import { InboxPage } from '@/pages/inbox';
import { Button } from '@/components/ui/button';
const ConnectionPage = lazy(() =>
  import('@/pages/connection').then((module) => ({
    default: module.ConnectionPage,
  })),
);
const PersonalConnectionPage = lazy(() =>
  import('@/pages/personal-connection').then((module) => ({
    default: module.PersonalConnectionPage,
  })),
);
const AppsPage = lazy(() =>
  import('@/pages/apps').then((module) => ({ default: module.AppsPage })),
);
const FacebookPageConnectionPage = lazy(() =>
  import('@/pages/facebook-page-connection').then((module) => ({
    default: module.FacebookPageConnectionPage,
  })),
);
const FacebookPersonalConnectionPage = lazy(() =>
  import('@/pages/facebook-personal-connection').then((module) => ({
    default: module.FacebookPersonalConnectionPage,
  })),
);
export function App() {
  const auth = useAuth();
  if (auth.isPending)
    return (
      <div className="grid min-h-dvh place-items-center">
        <Loading label="Đang mở không gian làm việc…" />
      </div>
    );
  if (auth.error)
    return (
      <div className="mx-auto max-w-md p-8">
        <ErrorNotice error={auth.error} />
        <Button className="mt-4" onClick={() => void auth.refetch()}>
          Thử lại
        </Button>
      </div>
    );
  if (!auth.data?.authenticated) return <LoginPage onLogin={auth.login} />;
  return (
    <Routes>
      <Route element={<Layout onLogout={auth.logout} />}>
        <Route path="/apps" element={<AppsPage />} />
        <Route path="/personal" element={<PersonalConnectionPage />} />
        <Route path="/connection" element={<ConnectionPage />} />
        <Route path="/facebook/page" element={<FacebookPageConnectionPage />} />
        <Route
          path="/facebook/personal"
          element={<FacebookPersonalConnectionPage />}
        />
        <Route path="/inbox/:conversationId?" element={<InboxPage />} />
        <Route path="*" element={<Navigate to="/inbox" replace />} />
      </Route>
    </Routes>
  );
}
