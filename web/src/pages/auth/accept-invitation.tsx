import { useEffect } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Alert, Button } from "antd";
import { CircleCheck, CircleX } from "lucide-react";
import { Navigate, useNavigate, useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";

import { authClient, authErrorTranslationKey, createLoginPath } from "@/lib/auth-client";
import {
    acceptInvitationOnce,
    getAcceptedInvitation,
    InvitationSynchronizationError,
    synchronizeAcceptedWorkspace,
} from "@/pages/auth/invitation-acceptance";
import { AuthPageLoading, AuthPageShell } from "@/pages/auth/auth-page-shell";
import { useWorkspaceStore } from "@/stores/use-workspace-store";

export default function AcceptInvitationPage() {
    const { t } = useTranslation();
    const navigate = useNavigate();
    const queryClient = useQueryClient();
    const { invitationId = "" } = useParams();
    const { data: session, error: sessionError, isPending, refetch } = authClient.useSession();
    const setActiveWorkspaceId = useWorkspaceStore((state) => state.setActiveWorkspaceId);
    const sessionUserId = session?.user.id ?? "";
    const returnTo = `/accept-invitation/${encodeURIComponent(invitationId)}`;

    const synchronizeMutation = useMutation({
        mutationFn: ({ userId, organizationId }: { userId: string; organizationId: string }) => synchronizeAcceptedWorkspace(queryClient, userId, organizationId),
        onSuccess: (workspace) => setActiveWorkspaceId(workspace.id),
    });
    const synchronize = synchronizeMutation.mutate;
    const acceptMutation = useMutation({
        mutationFn: ({ userId, id }: { userId: string; id: string }) => acceptInvitationOnce(queryClient, userId, id),
        onSuccess: ({ organizationId }, { userId }) => synchronize({ userId, organizationId }),
    });
    const accept = acceptMutation.mutate;

    useEffect(() => {
        if (!sessionUserId || !invitationId) return;
        const accepted = getAcceptedInvitation(queryClient, sessionUserId, invitationId);
        if (accepted) synchronize({ userId: sessionUserId, organizationId: accepted.organizationId });
        else accept({ userId: sessionUserId, id: invitationId });
    }, [accept, invitationId, queryClient, sessionUserId, synchronize]);

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

    if (!invitationId) return <Navigate to="/" replace />;

    if (synchronizeMutation.isSuccess) {
        return (
            <AuthPageShell eyebrow={t("auth.invitation.successEyebrow")} title={t("auth.invitation.successTitle")} description={t("auth.invitation.successNamedDescription", { name: synchronizeMutation.data.name })}>
                <CircleCheck className="size-11 text-foreground" strokeWidth={1.5} aria-hidden />
                <Button type="primary" size="large" className="mt-7" onClick={() => navigate("/", { replace: true })}>
                    {t("auth.invitation.enterWorkspace")}
                </Button>
            </AuthPageShell>
        );
    }

    if (synchronizeMutation.isError) {
        const retryVariables = synchronizeMutation.variables;
        const errorKey = synchronizeMutation.error instanceof InvitationSynchronizationError
            ? "auth.invitation.errors.syncMissing"
            : "auth.invitation.errors.syncFailed";
        return (
            <AuthPageShell eyebrow={t("auth.invitation.syncErrorEyebrow")} title={t("auth.invitation.syncErrorTitle")} description={t("auth.invitation.syncErrorDescription")}>
                <CircleX className="size-11 text-destructive" strokeWidth={1.5} aria-hidden />
                <Alert className="mt-5" type="error" showIcon message={t(errorKey)} />
                <div className="mt-6 flex flex-wrap justify-center gap-2">
                    <Button type="primary" onClick={() => synchronize(retryVariables)}>{t("auth.invitation.retrySync")}</Button>
                    <Button onClick={() => navigate("/", { replace: true })}>{t("auth.invitation.backHome")}</Button>
                </div>
            </AuthPageShell>
        );
    }

    if (acceptMutation.isError) {
        const errorKey = authErrorTranslationKey(acceptMutation.error, "auth.invitation.errors.acceptFailed");
        return (
            <AuthPageShell eyebrow={t("auth.invitation.errorEyebrow")} title={t("auth.invitation.errorTitle")} description={t("auth.invitation.errorDescription")}>
                <CircleX className="size-11 text-destructive" strokeWidth={1.5} aria-hidden />
                <Alert className="mt-5" type="error" showIcon message={t(errorKey)} />
                <div className="mt-6 flex flex-wrap justify-center gap-2">
                    <Button type="primary" onClick={() => accept({ userId: sessionUserId, id: invitationId })}>{t("auth.invitation.retryAccept")}</Button>
                    <Button onClick={() => navigate("/", { replace: true })}>{t("auth.invitation.backHome")}</Button>
                </div>
            </AuthPageShell>
        );
    }

    const synchronizing = synchronizeMutation.isPending || acceptMutation.isSuccess;
    return (
        <AuthPageShell
            eyebrow={t("auth.invitation.eyebrow")}
            title={t(synchronizing ? "auth.invitation.synchronizingTitle" : "auth.invitation.acceptingTitle")}
            description={t(synchronizing ? "auth.invitation.synchronizingDescription" : "auth.invitation.acceptingDescription")}
        >
            <div className="h-1 w-28 overflow-hidden rounded-full bg-secondary" role="status" aria-label={t(synchronizing ? "auth.invitation.synchronizingTitle" : "auth.invitation.acceptingTitle")}>
                <div className="h-full w-1/2 animate-pulse rounded-full bg-foreground" />
            </div>
        </AuthPageShell>
    );
}
