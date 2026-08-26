import type { ReactNode } from "react";
import { Spin } from "antd";
import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";

import { UserStatusActions } from "@/components/layout/user-status-actions";

type AuthPageShellProps = {
    eyebrow: string;
    title: string;
    description: string;
    children: ReactNode;
};

export function AuthPageShell({ eyebrow, title, description, children }: AuthPageShellProps) {
    const { t } = useTranslation();

    return (
        <div className="relative h-dvh overflow-y-auto bg-background text-foreground">
            <div aria-hidden className="pointer-events-none fixed inset-0 bg-[radial-gradient(circle,var(--border)_1px,transparent_1px)] opacity-70 [background-size:22px_22px] [mask-image:linear-gradient(to_bottom,black,transparent_88%)]" />
            <header className="relative z-10 mx-auto flex h-16 w-full max-w-6xl items-center justify-between px-5 sm:px-8">
                <Link to="/" className="inline-flex items-center gap-2 text-sm font-medium tracking-tight text-foreground">
                    <span
                        aria-hidden
                        className="size-5 bg-current"
                        style={{
                            mask: "url(/logo.svg) center / contain no-repeat",
                            WebkitMask: "url(/logo.svg) center / contain no-repeat",
                        }}
                    />
                    <span>{t("meta.title")}</span>
                </Link>
                <UserStatusActions showConfig={false} />
            </header>

            <main className="relative z-10 mx-auto grid min-h-[calc(100dvh-4rem)] w-full max-w-6xl items-center gap-14 px-5 py-10 sm:px-8 lg:grid-cols-[1fr_25rem] lg:py-16">
                <section className="hidden max-w-xl lg:block">
                    <p className="text-xs font-medium uppercase tracking-[0.22em] text-muted-foreground">{t("auth.shell.eyebrow")}</p>
                    <h2 className="mt-5 max-w-lg text-5xl font-medium leading-[1.08] tracking-[-0.045em]">{t("auth.shell.title")}</h2>
                    <p className="mt-6 max-w-md text-base leading-7 text-muted-foreground">{t("auth.shell.description")}</p>
                    <div className="mt-10 h-px w-20 bg-border" />
                </section>

                <section className="w-full rounded-2xl border border-border bg-background/90 p-6 backdrop-blur-sm sm:p-8" aria-labelledby="auth-page-title">
                    <p className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">{eyebrow}</p>
                    <h1 id="auth-page-title" className="mt-3 text-3xl font-medium tracking-[-0.035em]">{title}</h1>
                    <p className="mt-3 text-sm leading-6 text-muted-foreground">{description}</p>
                    <div className="mt-7">{children}</div>
                </section>
            </main>
        </div>
    );
}

export function AuthPageLoading() {
    const { t } = useTranslation();
    return (
        <div className="flex h-dvh items-center justify-center bg-background text-foreground" role="status" aria-label={t("auth.checkingSession")}>
            <Spin size="small" />
        </div>
    );
}
