import { create } from "zustand";

export type AuthenticatedUser = {
    id: string;
    name: string;
    email: string;
    image: string | null;
};

type UserStore = {
    user: AuthenticatedUser | null;
    setUser: (user: AuthenticatedUser) => void;
    clearUser: () => void;
};

export const useUserStore = create<UserStore>()((set) => ({
    user: null,
    setUser: (user) => set({ user }),
    clearUser: () => set({ user: null }),
}));
