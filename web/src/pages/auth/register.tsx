import { useState } from "react";
import { Alert, Button, Form, Input } from "antd";
import { CheckCircle2 } from "lucide-react";
import { Link, Navigate, useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";

import { AuthPageLoading, AuthPageShell } from "@/pages/auth/auth-page-shell";
import { authClient, authErrorTranslationKey, resolveSafeReturnTo, unwrapAuthResponse } from "@/lib/auth-client";

type RegisterValues = {
    name: string;
    email: string;
    password: string;
    confirmPassword: string;
};

export default function RegisterPage() {
    const { t } = useTranslation();
    const [searchParams] = useSearchParams();
    const { data: session, isPending } = authClient.useSession();
    const [submitting, setSubmitting] = useState(false);
    const [errorKey, setErrorKey] = useState("");
    const [verificationEmail, setVerificationEmail] = useState("");
    const returnTo = resolveSafeReturnTo(searchParams.get("returnTo"), window.location.origin);

    if (isPending) return <AuthPageLoading />;
    if (session) return <Navigate to={returnTo} replace />;

    async function submit({ confirmPassword: _confirmPassword, ...values }: RegisterValues) {
        setSubmitting(true);
        setErrorKey("");
        try {
            unwrapAuthResponse(
                await authClient.signUp.email({
                    ...values,
                    callbackURL: new URL(returnTo, window.location.origin).toString(),
                    fetchOptions: { credentials: "include" },
                }),
            );
            setVerificationEmail(values.email);
        } catch (error) {
            setErrorKey(authErrorTranslationKey(error, "auth.errors.registerFailed"));
        } finally {
            setSubmitting(false);
        }
    }

    if (verificationEmail) {
        return (
            <AuthPageShell eyebrow={t("auth.register.successEyebrow")} title={t("auth.register.successTitle")} description={t("auth.register.successDescription")}>
                <div className="flex size-11 items-center justify-center rounded-full bg-secondary text-foreground">
                    <CheckCircle2 className="size-5" aria-hidden />
                </div>
                <p className="mt-5 break-all text-sm font-medium text-foreground">{verificationEmail}</p>
                <p className="mt-2 text-sm leading-6 text-muted-foreground">{t("auth.register.successHint")}</p>
                <Link className="mt-7 inline-flex h-10 items-center justify-center rounded-lg bg-primary px-4 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-85" to={`/login?returnTo=${encodeURIComponent(returnTo)}`}>
                    {t("auth.register.backToLogin")}
                </Link>
            </AuthPageShell>
        );
    }

    return (
        <AuthPageShell eyebrow={t("auth.register.eyebrow")} title={t("auth.register.title")} description={t("auth.register.description")}>
            <Form<RegisterValues> layout="vertical" requiredMark={false} onFinish={(values) => void submit(values)}>
                {errorKey ? <Alert className="mb-5" type="error" showIcon message={t(errorKey)} /> : null}
                <Form.Item name="name" label={t("auth.fields.name")} rules={[{ required: true, message: t("auth.validation.name") }]}>
                    <Input size="large" autoComplete="name" placeholder={t("auth.fields.namePlaceholder")} />
                </Form.Item>
                <Form.Item name="email" label={t("auth.fields.email")} rules={[{ required: true, type: "email", message: t("auth.validation.email") }]}>
                    <Input size="large" autoComplete="email" inputMode="email" placeholder={t("auth.fields.emailPlaceholder")} />
                </Form.Item>
                <Form.Item name="password" label={t("auth.fields.password")} rules={[{ required: true, min: 8, message: t("auth.validation.passwordLength") }]}>
                    <Input.Password size="large" autoComplete="new-password" placeholder={t("auth.fields.passwordPlaceholder")} />
                </Form.Item>
                <Form.Item
                    name="confirmPassword"
                    label={t("auth.fields.confirmPassword")}
                    dependencies={["password"]}
                    rules={[
                        { required: true, message: t("auth.validation.confirmPassword") },
                        ({ getFieldValue }) => ({
                            validator(_, value) {
                                return !value || getFieldValue("password") === value ? Promise.resolve() : Promise.reject(new Error(t("auth.validation.passwordMismatch")));
                            },
                        }),
                    ]}
                >
                    <Input.Password size="large" autoComplete="new-password" placeholder={t("auth.fields.confirmPasswordPlaceholder")} />
                </Form.Item>
                <Button type="primary" htmlType="submit" size="large" block loading={submitting}>
                    {t("auth.register.submit")}
                </Button>
            </Form>
            <p className="mt-6 text-center text-sm text-muted-foreground">
                {t("auth.register.hasAccount")}{" "}
                <Link className="font-medium text-foreground underline-offset-4 hover:underline" to={`/login?returnTo=${encodeURIComponent(returnTo)}`}>
                    {t("auth.register.login")}
                </Link>
            </p>
        </AuthPageShell>
    );
}
