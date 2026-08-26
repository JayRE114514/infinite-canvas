import { useState } from "react";
import type { CreateWorkspaceBody } from "@infinite-canvas/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { App, Dropdown, Form, Input, Modal, type MenuProps } from "antd";
import { Building2, ChevronDown, House, LogOut, Plus, Users } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";

import { WorkspaceMembersModal } from "@/components/layout/workspace-members-modal";
import { authClient, authErrorTranslationKey, unwrapAuthResponse } from "@/lib/auth-client";
import { clearWorkspaceSessionMemory } from "@/services/api/invitation-acceptance";
import { platformErrorTranslationKey } from "@/services/api/platform-client";
import { createWorkspace, workspaceKeys, workspacesQueryOptions } from "@/services/api/workspaces";
import { useUserStore } from "@/stores/use-user-store";
import { useWorkspaceStore } from "@/stores/use-workspace-store";

export function WorkspaceSwitcher() {
    const { t } = useTranslation();
    const { message } = App.useApp();
    const navigate = useNavigate();
    const queryClient = useQueryClient();
    const [form] = Form.useForm<CreateWorkspaceBody>();
    const [createOpen, setCreateOpen] = useState(false);
    const [membersOpen, setMembersOpen] = useState(false);
    const [signingOut, setSigningOut] = useState(false);
    const user = useUserStore((state) => state.user);
    const clearUser = useUserStore((state) => state.clearUser);
    const activeWorkspaceId = useWorkspaceStore((state) => state.activeWorkspaceId);
    const setActiveWorkspaceId = useWorkspaceStore((state) => state.setActiveWorkspaceId);
    const clearWorkspace = useWorkspaceStore((state) => state.clearWorkspace);
    const workspaceQuery = useQuery({ ...workspacesQueryOptions(user?.id ?? ""), enabled: Boolean(user?.id) });
    const workspaces = workspaceQuery.data?.workspaces ?? [];
    const activeWorkspace = workspaces.find((workspace) => workspace.id === activeWorkspaceId) ?? workspaces.find((workspace) => workspace.type === "personal") ?? workspaces[0];

    const createMutation = useMutation({
        mutationFn: createWorkspace,
        onSuccess: async ({ workspace }) => {
            if (user) await queryClient.invalidateQueries({ queryKey: workspaceKeys.list(user.id), exact: true });
            setActiveWorkspaceId(workspace.id);
            form.resetFields();
            setCreateOpen(false);
            message.success(t("workspace.create.success"));
        },
        onError: (error) => message.error(t(platformErrorTranslationKey(error, "workspace.errors.createFailed"))),
    });

    async function signOut() {
        setSigningOut(true);
        try {
            unwrapAuthResponse(await authClient.signOut({ fetchOptions: { credentials: "include" } }));
            await clearWorkspaceSessionMemory(queryClient);
            clearUser();
            clearWorkspace();
            navigate("/login", { replace: true });
        } catch (error) {
            message.error(t(authErrorTranslationKey(error, "auth.errors.signOutFailed")));
        } finally {
            setSigningOut(false);
        }
    }

    const items: MenuProps["items"] = [
        {
            type: "group",
            label: t("workspace.switcher.title"),
            children: workspaces.map((workspace) => ({
                key: `workspace:${workspace.id}`,
                icon: workspace.type === "personal" ? <House className="size-4" /> : <Building2 className="size-4" />,
                label: (
                    <div className="min-w-0 py-0.5">
                        <p className="max-w-56 truncate text-sm">{workspace.name}</p>
                        <p className="text-[11px] text-muted-foreground">{t(`workspace.roles.${workspace.role}`)}</p>
                    </div>
                ),
            })),
        },
        { type: "divider" },
        { key: "members", icon: <Users className="size-4" />, label: t("workspace.switcher.members") },
        { key: "create", icon: <Plus className="size-4" />, label: t("workspace.switcher.create") },
        { type: "divider" },
        { key: "account", disabled: true, label: <div className="max-w-56 py-0.5"><p className="truncate text-xs font-medium text-foreground">{user?.name}</p><p className="truncate text-[11px] text-muted-foreground">{user?.email}</p></div> },
        { key: "signout", icon: <LogOut className="size-4" />, label: t("auth.signOut"), disabled: signingOut },
    ];

    function handleMenuClick({ key }: { key: string }) {
        if (key.startsWith("workspace:")) {
            setActiveWorkspaceId(key.slice("workspace:".length));
            return;
        }
        if (key === "members") setMembersOpen(true);
        if (key === "create") setCreateOpen(true);
        if (key === "signout") void signOut();
    }

    if (!activeWorkspace) return null;
    const ActiveIcon = activeWorkspace.type === "personal" ? House : Building2;

    return (
        <>
            <Dropdown trigger={["click"]} placement="bottomRight" menu={{ items, onClick: handleMenuClick, selectedKeys: [`workspace:${activeWorkspace.id}`] }}>
                <button
                    type="button"
                    className="inline-flex h-8 min-w-0 items-center gap-1.5 rounded-md px-2 text-sm text-stone-600 transition-colors hover:bg-black/5 hover:text-stone-950 dark:text-stone-300 dark:hover:bg-white/10 dark:hover:text-white"
                    aria-label={t("workspace.switcher.open", { name: activeWorkspace.name })}
                    aria-haspopup="menu"
                >
                    <ActiveIcon className="size-4 shrink-0" />
                    <span className="hidden max-w-32 truncate sm:inline">{activeWorkspace.name}</span>
                    <ChevronDown className="hidden size-3.5 shrink-0 opacity-55 sm:block" />
                </button>
            </Dropdown>

            <Modal
                open={createOpen}
                title={t("workspace.create.title")}
                okText={t("workspace.create.submit")}
                cancelText={t("common.cancel")}
                confirmLoading={createMutation.isPending}
                onOk={() => form.submit()}
                onCancel={() => setCreateOpen(false)}
                afterClose={() => form.resetFields()}
            >
                <p className="mb-5 text-sm leading-6 text-muted-foreground">{t("workspace.create.description")}</p>
                <Form<CreateWorkspaceBody> form={form} layout="vertical" requiredMark={false} onFinish={(values) => createMutation.mutate(values)}>
                    <Form.Item name="name" label={t("workspace.create.name")} rules={[{ required: true, message: t("workspace.create.nameRequired") }]}>
                        <Input autoComplete="organization" maxLength={120} placeholder={t("workspace.create.namePlaceholder")} />
                    </Form.Item>
                    <Form.Item
                        name="slug"
                        label={t("workspace.create.slug")}
                        extra={t("workspace.create.slugHint")}
                        rules={[
                            { required: true, message: t("workspace.create.slugRequired") },
                            { pattern: /^[a-z0-9]+(?:-[a-z0-9]+)*$/, message: t("workspace.create.slugInvalid") },
                        ]}
                    >
                        <Input autoCapitalize="none" autoCorrect="off" maxLength={120} placeholder={t("workspace.create.slugPlaceholder")} />
                    </Form.Item>
                </Form>
            </Modal>

            <WorkspaceMembersModal open={membersOpen} workspace={activeWorkspace} onClose={() => setMembersOpen(false)} />
        </>
    );
}
