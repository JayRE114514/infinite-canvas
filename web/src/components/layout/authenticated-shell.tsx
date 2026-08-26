import { useEffect, useRef } from "react";
import { Button, Spin } from "antd";
import { Outlet, useLocation, useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";

import { authClient, createLoginPath } from "@/lib/auth-client";
import { clearWorkspaceSessionMemory } from "@/services/api/invitation-acceptance";
import { PlatformApiError, platformErrorTranslationKey } from "@/services/api/platform-client";
import { workspaceKeys, workspacesQueryOptions } from "@/services/api/workspaces";
import { useUserStore } from "@/stores/use-user-store";
import { useWorkspaceStore } from "@/stores/use-workspace-store";

type ShellStateProps = {
    title: string;
    description?: string;
    busy?: boolean;
    actionLabel?: string;
    onAction?: () => void;
};

function ShellState({ title, description, busy = false, actionLabel, onAction }: ShellStateProps) {
    return (
        <div className="flex h-dvh items-center justify-center bg-background px-6 text-foreground">
            <div className="max-w-sm text-center" role="status">
                {busy ? <Spin size="small" /> : null}
                <h1 className={`${busy ? "mt-5" : ""} text-lg font-medium`}>{title}</h1>
                {description ? <p className="mt-2 text-sm leading-6 text-muted-foreground">{description}</p> : null}
                {actionLabel && onAction ? <Button className="mt-5" onClick={onAction}>{actionLabel}</Button> : null}
            </div>
        </div>
    );
}

export function AuthenticatedShell() {
    const { t } = useTranslation();
    const location = useLocation();
    const navigate = useNavigate();
    const queryClient = useQueryClient();
    const { data: session, error: sessionError, isPending: sessionPending, refetch: refetchSession } = authClient.useSession();
    const activeWorkspaceId = useWorkspaceStore((state) => state.activeWorkspaceId);
    const setActiveWorkspaceId = useWorkspaceStore((state) => state.setActiveWorkspaceId);
    const clearWorkspace = useWorkspaceStore((state) => state.clearWorkspace);
    const setUser = useUserStore((state) => state.setUser);
    const clearUser = useUserStore((state) => state.clearUser);
    const anonymousSessionHandled = useRef(false);
    const staleSessionHandled = useRef(false);
    const userId = session?.user.id ?? "";
    const userName = session?.user.name ?? "";
    const userEmail = session?.user.email ?? "";
    const userImage = session?.user.image ?? null;
    const returnTo = `${location.pathname}${location.search}${location.hash}`;
    const loginPath = createLoginPath(returnTo);
    const workspaceQuery = useQuery({ ...workspacesQueryOptions(userId), enabled: Boolean(userId) });
    const workspaces = workspaceQuery.data?.workspaces ?? [];
    const selectedWorkspace = workspaces.find((workspace) => workspace.id === activeWorkspaceId);
    const fallbackWorkspace = workspaces.find((workspace) => workspace.type === "personal") ?? workspaces[0];
    const resolvedWorkspaceId = selectedWorkspace?.id ?? fallbackWorkspace?.id ?? "";
    const hasSessionError = Boolean(sessionError);
    const anonymousSession = !sessionPending && !userId && !hasSessionError;
    const staleSession = workspaceQuery.error instanceof PlatformApiError && workspaceQuery.error.status === 401;

    useEffect(() => {
        if (!userId) return;
        setUser({ id: userId, name: userName, email: userEmail, image: userImage });
    }, [setUser, userEmail, userId, userImage, userName]);

    useEffect(() => {
        if (!anonymousSession || anonymousSessionHandled.current) return;
        anonymousSessionHandled.current = true;
        clearUser();
        clearWorkspace();
        void clearWorkspaceSessionMemory(queryClient).then(() => {
            navigate(loginPath, { replace: true });
        });
    }, [anonymousSession, clearUser, clearWorkspace, loginPath, navigate, queryClient]);

    useEffect(() => {
        if (!workspaceQuery.isSuccess || activeWorkspaceId === resolvedWorkspaceId) return;
        if (resolvedWorkspaceId) setActiveWorkspaceId(resolvedWorkspaceId);
        else clearWorkspace();
    }, [activeWorkspaceId, clearWorkspace, resolvedWorkspaceId, setActiveWorkspaceId, workspaceQuery.isSuccess]);

    useEffect(() => {
        if (!staleSession || staleSessionHandled.current) return;
        staleSessionHandled.current = true;
        clearUser();
        clearWorkspace();
        void clearWorkspaceSessionMemory(queryClient).then(() => {
            return authClient.signOut({ fetchOptions: { credentials: "include" } }).catch(() => undefined);
        }).finally(() => navigate(loginPath, { replace: true }));
    }, [clearUser, clearWorkspace, loginPath, navigate, queryClient, staleSession]);

    if (sessionPending) return <ShellState busy title={t("auth.checkingSession")} />;
    if (!session && hasSessionError) {
        return <ShellState title={t("auth.sessionLoadFailed")} description={t("auth.sessionLoadFailedDescription")} actionLabel={t("common.retry")} onAction={() => void refetchSession()} />;
    }
    if (!session) return <ShellState busy title={t("auth.sessionExpiredRedirect")} />;
    if (staleSession) return <ShellState busy title={t("auth.sessionExpiredRedirect")} />;
    if (workspaceQuery.isPending) return <ShellState busy title={t("workspace.loading")} />;
    if (workspaceQuery.error) {
        return (
            <ShellState
                title={t("workspace.loadFailed")}
                description={t(platformErrorTranslationKey(workspaceQuery.error, "workspace.errors.loadFailed"))}
                actionLabel={t("common.retry")}
                onAction={() => void workspaceQuery.refetch()}
            />
        );
    }
    if (!resolvedWorkspaceId) return <ShellState title={t("workspace.emptyTitle")} description={t("workspace.emptyDescription")} actionLabel={t("common.retry")} onAction={() => void workspaceQuery.refetch()} />;

    return <Outlet />;
}
