import { useEffect, useRef, useState } from "react";
import { Alert, Button } from "antd";
import { CircleCheck, CircleX } from "lucide-react";
import { Navigate, useNavigate, useParams } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";

import { AuthPageLoading, AuthPageShell } from "@/pages/auth/auth-page-shell";
import { authClient, authErrorTranslationKey, createLoginPath, unwrapAuthResponse } from "@/lib/auth-client";
import { workspaceKeys, workspacesQueryOptions } from "@/services/api/workspaces";
import { useWorkspaceStore } from "@/stores/use-workspace-store";

type InvitationState = "idle" | "accepting" | "success" | "error";

export default function AcceptInvitationPage() {
    const { t } = useTranslation();
    const navigate = useNavigate();
    const queryClient = useQueryClient();
    const { invitationId = "" } = useParams();
    const { data: session, error: sessionError, isPending, refetch } = authClient.useSession();
    const setActiveWorkspaceId = useWorkspaceStore((state) => state.setActiveWorkspaceId);
    const attemptedIdRef = useRef("");
    const [state, setState] = useState<InvitationState>("idle");
    const [errorKey, setErrorKey] = useState("");
    const [workspaceName, setWorkspaceName] = useState("");
    const sessionUserId = session?.user.id ?? "";
    const returnTo = `/accept-invitation/${encodeURIComponent(invitationId)}`;

    useEffect(() => {
        if (!sessionUserId || !invitationId || attemptedIdRef.current === invitationId) return;
        attemptedIdRef.current = invitationId;
        setState("accepting");

        void (async () => {
            try {
                const accepted = unwrapAuthResponse(
                    await authClient.organization.acceptInvitation({
                        invitationId,
                        fetchOptions: { credentials: "include" },
                    }),
                );
                const acceptedWorkspaceId = accepted.member.organizationId;

                try {
                    await queryClient.invalidateQueries({ queryKey: workspaceKeys.list(sessionUserId), exact: true });
                    const result = await queryClient.fetchQuery(workspacesQueryOptions(sessionUserId));
                    const workspace = result.workspaces.find((item) => item.id === acceptedWorkspaceId);
                    if (workspace) {
                        setActiveWorkspaceId(workspace.id);
                        setWorkspaceName(workspace.name);
                    }
                } catch {
                    // The invitation is already accepted; the shell will retry Workspace loading on entry.
                }

                setState("success");
            } catch (error) {
                setErrorKey(authErrorTranslationKey(error, "auth.invitation.errors.acceptFailed"));
                setState("error");
            }
        })();
    }, [invitationId, queryClient, sessionUserId, setActiveWorkspaceId]);

    if (isPending) return <AuthPageLoading />;
    if (!session && !sessionError) return <Navigate to={createLoginPath(returnTo)} replace />;

    if (!session) {
        return (
            <AuthPageShell eyebrow={t("auth.invitation.eyebrow")} title={t("auth.invitation.sessionTitle")} description={t("auth.invitation.sessionDescription")}>
                <Alert type="error" showIcon message={t("auth.invitation.errors.sessionFailed")} />
                <Button className="mt-6" onClick={() => void refetch()}>{t("auth.invitation.retrySession")}</Button>
            </AuthPageShell>
        );
    }

    if (!invitationId) {
        return <Navigate to="/" replace />;
    }

    if (state === "success") {
        return (
            <AuthPageShell eyebrow={t("auth.invitation.successEyebrow")} title={t("auth.invitation.successTitle")} description={t(workspaceName ? "auth.invitation.successNamedDescription" : "auth.invitation.successDescription", { name: workspaceName })}>
                <CircleCheck className="size-11 text-foreground" strokeWidth={1.5} aria-hidden />
                <Button type="primary" size="large" className="mt-7" onClick={() => navigate("/", { replace: true })}>
                    {t("auth.invitation.enterWorkspace")}
                </Button>
            </AuthPageShell>
        );
    }

    if (state === "error") {
        return (
            <AuthPageShell eyebrow={t("auth.invitation.errorEyebrow")} title={t("auth.invitation.errorTitle")} description={t("auth.invitation.errorDescription")}>
                <CircleX className="size-11 text-destructive" strokeWidth={1.5} aria-hidden />
                <Alert className="mt-5" type="error" showIcon message={t(errorKey)} />
                <Button className="mt-6" onClick={() => navigate("/", { replace: true })}>{t("auth.invitation.backHome")}</Button>
            </AuthPageShell>
        );
    }

    return (
        <AuthPageShell eyebrow={t("auth.invitation.eyebrow")} title={t("auth.invitation.acceptingTitle")} description={t("auth.invitation.acceptingDescription")}>
            <div className="h-1 w-28 overflow-hidden rounded-full bg-secondary" role="status" aria-label={t("auth.invitation.acceptingTitle")}>
                <div className="h-full w-1/2 animate-pulse rounded-full bg-foreground" />
            </div>
        </AuthPageShell>
    );
}
