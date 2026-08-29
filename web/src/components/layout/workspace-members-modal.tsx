import type { CreateWorkspaceInvitationBody, WorkspaceSummary } from "@infinite-canvas/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { App, Alert, Avatar, Button, Empty, Form, Input, Modal, Popconfirm, Select, Spin, Tag } from "antd";
import { MailPlus, UserMinus, X } from "lucide-react";
import { useTranslation } from "react-i18next";

import { platformErrorTranslationKey } from "@/services/api/platform-client";
import {
    cancelWorkspaceInvitation,
    inviteWorkspaceMember,
    removeWorkspaceMember,
    workspaceInvitationsQueryOptions,
    workspaceKeys,
    workspaceMembersQueryOptions,
} from "@/services/api/workspaces";
import { useUserStore } from "@/stores/use-user-store";

type WorkspaceMembersModalProps = {
    open: boolean;
    workspace: WorkspaceSummary | undefined;
    onClose: () => void;
};

export function WorkspaceMembersModal({ open, workspace, onClose }: WorkspaceMembersModalProps) {
    const { t } = useTranslation();
    const { message } = App.useApp();
    const queryClient = useQueryClient();
    const [form] = Form.useForm<CreateWorkspaceInvitationBody>();
    const userId = useUserStore((state) => state.user?.id ?? "");
    const workspaceId = workspace?.id ?? "";
    const canManage = workspace?.role === "owner" || workspace?.role === "admin";
    const isTeam = workspace?.type === "team";
    const membersQuery = useQuery({ ...workspaceMembersQueryOptions(userId, workspaceId), enabled: open && Boolean(userId && workspaceId) });
    const invitationsQuery = useQuery({ ...workspaceInvitationsQueryOptions(userId, workspaceId), enabled: open && Boolean(userId && workspaceId) && Boolean(isTeam && canManage) });

    const inviteMutation = useMutation({
        mutationFn: (values: CreateWorkspaceInvitationBody) => inviteWorkspaceMember(workspaceId, values),
        onSuccess: async () => {
            form.resetFields();
            await queryClient.invalidateQueries({ queryKey: workspaceKeys.invitations(userId, workspaceId), exact: true });
            message.success(t("workspace.members.inviteSent"));
        },
        onError: (error) => message.error(t(platformErrorTranslationKey(error, "workspace.errors.inviteFailed"))),
    });

    const cancelMutation = useMutation({
        mutationFn: (invitationId: string) => cancelWorkspaceInvitation(workspaceId, invitationId),
        onSuccess: async () => {
            await queryClient.invalidateQueries({ queryKey: workspaceKeys.invitations(userId, workspaceId), exact: true });
            message.success(t("workspace.members.invitationCanceled"));
        },
        onError: (error) => message.error(t(platformErrorTranslationKey(error, "workspace.errors.cancelInvitationFailed"))),
    });

    const removeMutation = useMutation({
        mutationFn: (memberId: string) => removeWorkspaceMember(workspaceId, memberId),
        onSuccess: async () => {
            await Promise.all([
                queryClient.invalidateQueries({ queryKey: workspaceKeys.members(userId, workspaceId), exact: true }),
                queryClient.invalidateQueries({ queryKey: workspaceKeys.lists }),
            ]);
            message.success(t("workspace.members.memberRemoved"));
        },
        onError: (error) => message.error(t(platformErrorTranslationKey(error, "workspace.errors.removeMemberFailed"))),
    });

    return (
        <Modal
            open={open}
            title={t("workspace.members.title", { name: workspace?.name ?? "" })}
            width={680}
            footer={null}
            onCancel={onClose}
            afterClose={() => form.resetFields()}
        >
            <div className="space-y-6">
                {workspace?.type === "personal" ? <Alert type="info" showIcon message={t("workspace.members.personalTitle")} description={t("workspace.members.personalDescription")} /> : null}

                {isTeam && canManage ? (
                    <section aria-labelledby="workspace-invite-title">
                        <div className="mb-3">
                            <h3 id="workspace-invite-title" className="text-sm font-medium text-foreground">{t("workspace.members.inviteTitle")}</h3>
                            <p className="mt-1 text-xs leading-5 text-muted-foreground">{t("workspace.members.inviteDescription")}</p>
                        </div>
                        <Form<CreateWorkspaceInvitationBody> form={form} layout="vertical" requiredMark={false} initialValues={{ role: "member" }} onFinish={(values) => inviteMutation.mutate(values)}>
                            <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_8.5rem_auto] sm:items-end">
                                <Form.Item name="email" label={t("auth.fields.email")} className="!mb-0" rules={[{ required: true, type: "email", message: t("auth.validation.email") }]}>
                                    <Input prefix={<MailPlus className="size-4 text-muted-foreground" />} autoComplete="email" inputMode="email" placeholder={t("workspace.members.emailPlaceholder")} />
                                </Form.Item>
                                <Form.Item name="role" label={t("workspace.members.role")} className="!mb-0">
                                    <Select
                                        options={[
                                            { value: "member", label: t("workspace.roles.member") },
                                            { value: "admin", label: t("workspace.roles.admin") },
                                        ]}
                                    />
                                </Form.Item>
                                <Button htmlType="submit" type="primary" loading={inviteMutation.isPending}>{t("workspace.members.invite")}</Button>
                            </div>
                        </Form>
                    </section>
                ) : null}

                <section aria-labelledby="workspace-member-list-title">
                    <div className="mb-3 flex items-center justify-between">
                        <h3 id="workspace-member-list-title" className="text-sm font-medium text-foreground">{t("workspace.members.listTitle")}</h3>
                        {membersQuery.data ? <span className="text-xs text-muted-foreground">{t("workspace.members.count", { count: membersQuery.data.total })}</span> : null}
                    </div>
                    {membersQuery.isPending ? (
                        <div className="flex min-h-28 items-center justify-center"><Spin size="small" /></div>
                    ) : membersQuery.error ? (
                        <Alert
                            type="error"
                            showIcon
                            message={t(platformErrorTranslationKey(membersQuery.error, "workspace.errors.membersLoadFailed"))}
                            action={<Button size="small" onClick={() => void membersQuery.refetch()}>{t("common.retry")}</Button>}
                        />
                    ) : membersQuery.data?.members.length ? (
                        <div className="divide-y divide-border rounded-xl border border-border" role="list">
                            {membersQuery.data.members.map((member) => (
                                <div key={member.id} className="flex items-center gap-3 px-4 py-3" role="listitem">
                                    <Avatar src={member.user.image || undefined}>{member.user.name.slice(0, 1).toUpperCase()}</Avatar>
                                    <div className="min-w-0 flex-1">
                                        <p className="truncate text-sm font-medium text-foreground">{member.user.name}</p>
                                        <p className="truncate text-xs text-muted-foreground">{member.user.email}</p>
                                    </div>
                                    <Tag bordered={false}>{t(`workspace.roles.${member.role}`)}</Tag>
                                    {canManage && member.role !== "owner" ? (
                                        <Popconfirm
                                            title={t("workspace.members.removeTitle")}
                                            description={t("workspace.members.removeDescription", { name: member.user.name })}
                                            okText={t("workspace.members.remove")}
                                            cancelText={t("common.cancel")}
                                            onConfirm={() => removeMutation.mutate(member.id)}
                                        >
                                            <Button
                                                type="text"
                                                danger
                                                shape="circle"
                                                icon={<UserMinus className="size-4" />}
                                                loading={removeMutation.isPending && removeMutation.variables === member.id}
                                                aria-label={t("workspace.members.removeNamed", { name: member.user.name })}
                                            />
                                        </Popconfirm>
                                    ) : null}
                                </div>
                            ))}
                        </div>
                    ) : (
                        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t("workspace.members.empty")} />
                    )}
                </section>

                {isTeam && canManage ? (
                    <section aria-labelledby="workspace-invitation-list-title">
                        <h3 id="workspace-invitation-list-title" className="mb-3 text-sm font-medium text-foreground">{t("workspace.members.pendingInvitations")}</h3>
                        {invitationsQuery.isPending ? (
                            <div className="flex min-h-20 items-center justify-center"><Spin size="small" /></div>
                        ) : invitationsQuery.error ? (
                            <Alert
                                type="error"
                                showIcon
                                message={t(platformErrorTranslationKey(invitationsQuery.error, "workspace.errors.invitationsLoadFailed"))}
                                action={<Button size="small" onClick={() => void invitationsQuery.refetch()}>{t("common.retry")}</Button>}
                            />
                        ) : invitationsQuery.data?.length ? (
                            <div className="divide-y divide-border rounded-xl border border-border" role="list">
                                {invitationsQuery.data.map((invitation) => (
                                    <div key={invitation.id} className="flex items-center gap-3 px-4 py-3" role="listitem">
                                        <div className="min-w-0 flex-1">
                                            <p className="truncate text-sm text-foreground">{invitation.email}</p>
                                            <p className="mt-0.5 text-xs text-muted-foreground">{t(`workspace.roles.${invitation.role}`)}</p>
                                        </div>
                                        <Popconfirm
                                            title={t("workspace.members.cancelTitle")}
                                            description={t("workspace.members.cancelDescription", { email: invitation.email })}
                                            okText={t("workspace.members.cancelInvitation")}
                                            cancelText={t("common.cancel")}
                                            onConfirm={() => cancelMutation.mutate(invitation.id)}
                                        >
                                            <Button
                                                type="text"
                                                danger
                                                icon={<X className="size-4" />}
                                                loading={cancelMutation.isPending && cancelMutation.variables === invitation.id}
                                                aria-label={t("workspace.members.cancelNamed", { email: invitation.email })}
                                            >
                                                {t("workspace.members.cancelInvitation")}
                                            </Button>
                                        </Popconfirm>
                                    </div>
                                ))}
                            </div>
                        ) : (
                            <p className="rounded-xl border border-dashed border-border px-4 py-5 text-center text-sm text-muted-foreground">{t("workspace.members.noPendingInvitations")}</p>
                        )}
                    </section>
                ) : null}
            </div>
        </Modal>
    );
}
