import { createHashRouter, Navigate, useLocation } from 'react-router';

import { CaptureDetailPage } from '../features/captures/CaptureDetailPage.js';
import { CapturesPage } from '../features/captures/CapturesPage.js';
import { PromotionsPage } from '../features/promotions/PromotionsPage.js';
import { AtlasLayout } from '../layouts/AtlasLayout.js';
import { ConfigRedirect } from '../pages/ConfigPage.js';
import { EndpointPage } from '../pages/EndpointPage.js';
import { HomePage } from '../pages/HomePage.js';
import { NotFoundPage } from '../pages/NotFoundPage.js';
import { ScenariosPage } from '../pages/ScenariosPage.js';

/** `#/explorer?…` → `#/requests?…&mode=explore`, keeping the request the link describes. */
function ExplorerRedirect() {
  const { search } = useLocation();
  const next = new URLSearchParams(search);
  next.set('mode', 'explore');
  return <Navigate replace to={`/requests?${next.toString()}`} />;
}

/** `#/?…` → `#/requests?…`: Requests is the home page; the endpoint list lives at `#/endpoints`. */
function HomeRedirect() {
  const { search } = useLocation();
  return <Navigate replace to={`/requests${search}`} />;
}

const requestsPage = () => import('../features/requests/RequestsPage.js');

export function createRouter() {
  return createHashRouter([
    {
      path: '/',
      element: <AtlasLayout />,
      children: [
        { index: true, element: <HomeRedirect /> },
        { path: 'endpoints', element: <HomePage /> },
        // Configuration is a dialog now (`?config=1`); old links open it.
        { path: 'config', element: <ConfigRedirect /> },
        // The Explorer tab became the Requests tab's Explore mode; old links land there.
        { path: 'explorer', element: <ExplorerRedirect /> },
        { path: 'scenarios', element: <ScenariosPage /> },
        { path: 'captures', element: <CapturesPage /> },
        { path: 'captures/:scenario/:exchange', element: <CaptureDetailPage /> },
        { path: 'promotions', element: <PromotionsPage /> },
        // The request runner is its own chunk, loaded on first visit.
        { path: 'requests', lazy: requestsPage },
        { path: 'requests/runs', lazy: requestsPage },
        { path: 'requests/runs/:runId', lazy: requestsPage },
        { path: 'endpoints/:endpointId', element: <EndpointPage /> },
        { path: 'endpoints/:endpointId/fixtures/:fixtureId', element: <EndpointPage /> },
        { path: '*', element: <NotFoundPage /> },
      ],
    },
  ]);
}
