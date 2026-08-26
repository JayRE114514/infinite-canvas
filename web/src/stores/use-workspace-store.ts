import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

type WorkspaceStore = {
    activeWorkspaceId: string | null;
    setActiveWorkspaceId: (activeWorkspaceId: string) => void;
    clearWorkspace: () => void;
};

export const useWorkspaceStore = create<WorkspaceStore>()(
    persist(
        (set) => ({
            activeWorkspaceId: null,
            setActiveWorkspaceId: (activeWorkspaceId) => set({ activeWorkspaceId }),
            clearWorkspace: () => set({ activeWorkspaceId: null }),
        }),
        {
            name: "infinite-canvas:active-workspace",
            storage: createJSONStorage(() => sessionStorage),
            partialize: ({ activeWorkspaceId }) => ({ activeWorkspaceId }),
        },
    ),
);
