import { createBrowserRouter, Outlet } from "react-router-dom";

import { AnalyticsTracker } from "@/components/layout/analytics-tracker";
import { AuthenticatedShell } from "@/components/layout/authenticated-shell";
import UserLayout from "@/layouts/user-layout";
import AcceptInvitationPage from "@/pages/auth/accept-invitation";
import LoginPage from "@/pages/auth/login";
import RegisterPage from "@/pages/auth/register";
import AssetsPage from "@/pages/assets";
import CanvasPage from "@/pages/canvas";
import CanvasProjectPage from "@/pages/canvas/project";
import ConfigPage from "@/pages/config";
import HomePage from "@/pages/home";
import ImagePage from "@/pages/image";
import NotFound from "@/pages/not-found";
import PromptsPage from "@/pages/prompts";
import VideoPage from "@/pages/video";

export const router = createBrowserRouter([
    {
        element: <AuthenticatedShell />,
        children: [
            {
                element: (
                    <UserLayout>
                        <AnalyticsTracker />
                        <Outlet />
                    </UserLayout>
                ),
                children: [
                    { path: "/", element: <HomePage /> },
                    { path: "/image", element: <ImagePage /> },
                    { path: "/video", element: <VideoPage /> },
                    { path: "/assets", element: <AssetsPage /> },
                    { path: "/prompts", element: <PromptsPage /> },
                    { path: "/canvas", element: <CanvasPage /> },
                    { path: "/canvas/:id", element: <CanvasProjectPage /> },
                    { path: "/config", element: <ConfigPage /> },
                ],
            },
        ],
    },
    { path: "/login", element: <LoginPage /> },
    { path: "/register", element: <RegisterPage /> },
    { path: "/accept-invitation/:token", element: <AcceptInvitationPage /> },
    { path: "*", element: <NotFound /> },
]);
