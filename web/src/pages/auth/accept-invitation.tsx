import { useEffect, useRef } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Alert, Button } from "antd";
import { CircleCheck, CircleX } from "lucide-react";
import { Navigate, useNavigate, useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";

import { authClient, authErrorTranslationKey, createLoginPath } from "@/lib/auth-client";
import {
    acceptInvitationOnce,
    clearWorkspaceSessionMemory,
    getAcceptedInvitation,
    InvitationSynchronizationError,
    isInvitationLifecycleActive,
    synchronizeAcceptedWorkspace,
} from "@/services/api/invitation-acceptance";
import { AuthPageLoading, AuthPageShell } from "@/pages/auth/auth-page-shell";
import { useUserStore } from "@/stores/use-user-store";
import { useWorkspaceStore } from "@/stores/use-workspace-store";

type InvitationAcceptanceFlowProps = {
    userId: string;
    invitationId: string;
};

function InvitationAcceptanceFlow({ userId, invitationId }: InvitationAcceptanceFlowProps) {
    const { t } = useTranslation();
    const navigate = useNavigate();
    const queryClient = useQueryClient();
    const flowActive = useRef(true);
    const setActiveWorkspaceId = useWorkspaceStore((state) => state.setActiveWorkspaceId);

    const synchronizeMutation = useMutation({
        mutationFn: ({ scopedUserId, organizationId }: { scopedUserId: string; organizationId: string }) => synchronizeAcceptedWorkspace(queryClient, scopedUserId, organizationId),
        onSuccess: ({ workspace, generation }) => {
            if (flowActive.current && isInvitationLifecycleActive(generation)) setActiveWorkspaceId(workspace.id);
        },
    });
    const synchronize = synchronizeMutation.mutate;
    const acceptMutation = useMutation({
        mutationFn: ({ scopedUserId, scopedInvitationId }: { scopedUserId: string; scopedInvitationId: string }) => acceptInvitationOnce(queryClient, scopedUserId, scopedInvitationId),
        onSuccess: ({ organizationId, generation }, { scopedUserId }) => {
            if (flowActive.current && isInvitationLifecycleActive(generation)) synchronize({ scopedUserId, organizationId });
        },
    });
    const accept = acceptMutation.mutate;

    useEffect(() => {
        flowActive.current = true;
        const accepted = getAcceptedInvitation(userId, invitationId);
        if (accepted) synchronize({ scopedUserId: userId, organizationId: accepted.organizationId });
        else accept({ scopedUserId: userId, scopedInvitationId: invitationId });
        return () => {
            flowActive.current = false;
        };
    }, [accept, invitationId, synchronize, userId]);

    if (synchronizeMutation.isSuccess && isInvitationLifecycleActive(synchronizeMutation.data.generation)) {
        return (
            <AuthPageShell eyebrow={t("auth.invitation.successEyebrow")} title={t("auth.invitation.successTitle")} description={t("auth.invitation.successNamedDescription", { name: synchronizeMutation.data.workspace.name })}>
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
                    <Button type="primary" onClick={() => accept({ scopedUserId: userId, scopedInvitationId: invitationId })}>{t("auth.invitation.retryAccept")}</Button>
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

export default function AcceptInvitationPage() {
    const { t } = useTranslation();
    const navigate = useNavigate();
    const queryClient = useQueryClient();
    const { invitationId = "" } = useParams();
    const { data: session, error: sessionError, isPending, refetch } = authClient.useSession();
    const anonymousSessionHandled = useRef(false);
    const clearUser = useUserStore((state) => state.clearUser);
    const clearWorkspace = useWorkspaceStore((state) => state.clearWorkspace);
    const userId = session?.user.id ?? "";
    const returnTo = `/accept-invitation/${encodeURIComponent(invitationId)}`;
    const loginPath = createLoginPath(returnTo);
    const anonymousSession = !isPending && !session && !sessionError;

    useEffect(() => {
        if (!anonymousSession || anonymousSessionHandled.current) return;
        anonymousSessionHandled.current = true;
        clearUser();
        clearWorkspace();
        void clearWorkspaceSessionMemory(queryClient).then(() => navigate(loginPath, { replace: true }));
    }, [anonymousSession, clearUser, clearWorkspace, loginPath, navigate, queryClient]);

    if (isPending) return <AuthPageLoading />;
    if (anonymousSession) return <AuthPageLoading />;

    if (!session) {
        return (
            <AuthPageShell eyebrow={t("auth.invitation.eyebrow")} title={t("auth.invitation.sessionTitle")} description={t("auth.invitation.sessionDescription")}>
                <Alert type="error" showIcon message={t("auth.invitation.errors.sessionFailed")} />
                <Button className="mt-6" onClick={() => void refetch()}>{t("auth.invitation.retrySession")}</Button>
            </AuthPageShell>
        );
    }

    if (!invitationId) return <Navigate to="/" replace />;

    return <InvitationAcceptanceFlow key={JSON.stringify([userId, invitationId])} userId={userId} invitationId={invitationId} />;
}
