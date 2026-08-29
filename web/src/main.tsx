import React from "react";
import { createRoot } from "react-dom/client";
import localforage from "localforage";
import "antd/dist/reset.css";
import "streamdown/styles.css";
import "./styles/globals.css";
import { RouterProvider } from "react-router-dom";

import { AppProviders } from "@/components/layout/app-providers";
import "@/i18n";
import { initAnalytics } from "@/lib/analytics";
import { router } from "@/router";
import { upgradeRecoveryStorage } from "@/services/canvas-recovery/bootstrap";

/** Explicit one-time bootstrap action; it is outside React, so StrictMode remounts cannot repeat it. */
void upgradeRecoveryStorage({
    storage: {
        getItem: (key) => window.localStorage.getItem(key),
        setItem: (key, value) => window.localStorage.setItem(key, value),
    },
    dropLegacy: () => localforage.dropInstance({ name: "infinite-canvas", storeName: "canvas_recovery" }),
});
initAnalytics();

document.body.style.fontFamily = '"SF Pro Display","SF Pro Text","PingFang SC","Microsoft YaHei","Helvetica Neue",sans-serif';

createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
        <AppProviders>
            <RouterProvider router={router} />
        </AppProviders>
    </React.StrictMode>,
);
