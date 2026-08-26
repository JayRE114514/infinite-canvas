import { useState } from "react";
import { Alert, Button, Checkbox, Form, Input } from "antd";
import { Link, Navigate, useNavigate, useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";

import { AuthPageLoading, AuthPageShell } from "@/pages/auth/auth-page-shell";
import { authClient, authErrorTranslationKey, resolveSafeReturnTo, unwrapAuthResponse } from "@/lib/auth-client";

type LoginValues = {
    email: string;
    password: string;
    rememberMe: boolean;
};

export default function LoginPage() {
    const { t } = useTranslation();
    const navigate = useNavigate();
    const [searchParams] = useSearchParams();
    const { data: session, isPending, refetch } = authClient.useSession();
    const [submitting, setSubmitting] = useState(false);
    const [errorKey, setErrorKey] = useState("");
    const returnTo = resolveSafeReturnTo(searchParams.get("returnTo"), window.location.origin);

    if (isPending) return <AuthPageLoading />;
    if (session) return <Navigate to={returnTo} replace />;

    async function submit(values: LoginValues) {
        setSubmitting(true);
        setErrorKey("");
        try {
            unwrapAuthResponse(
                await authClient.signIn.email({
                    ...values,
                    fetchOptions: { credentials: "include" },
                }),
            );
            await refetch();
            navigate(returnTo, { replace: true });
        } catch (error) {
            setErrorKey(authErrorTranslationKey(error, "auth.errors.loginFailed"));
        } finally {
            setSubmitting(false);
        }
    }

    return (
        <AuthPageShell eyebrow={t("auth.login.eyebrow")} title={t("auth.login.title")} description={t("auth.login.description")}>
            <Form<LoginValues> layout="vertical" requiredMark={false} initialValues={{ rememberMe: true }} onFinish={(values) => void submit(values)}>
                {errorKey ? <Alert className="mb-5" type="error" showIcon message={t(errorKey)} /> : null}
                <Form.Item name="email" label={t("auth.fields.email")} rules={[{ required: true, type: "email", message: t("auth.validation.email") }]}>
                    <Input size="large" autoComplete="email" inputMode="email" placeholder={t("auth.fields.emailPlaceholder")} />
                </Form.Item>
                <Form.Item name="password" label={t("auth.fields.password")} rules={[{ required: true, message: t("auth.validation.password") }]}>
                    <Input.Password size="large" autoComplete="current-password" placeholder={t("auth.fields.passwordPlaceholder")} />
                </Form.Item>
                <Form.Item name="rememberMe" valuePropName="checked" className="!mb-5">
                    <Checkbox>{t("auth.login.rememberMe")}</Checkbox>
                </Form.Item>
                <Button type="primary" htmlType="submit" size="large" block loading={submitting}>
                    {t("auth.login.submit")}
                </Button>
            </Form>
            <p className="mt-6 text-center text-sm text-muted-foreground">
                {t("auth.login.noAccount")}{" "}
                <Link className="font-medium text-foreground underline-offset-4 hover:underline" to={`/register?returnTo=${encodeURIComponent(returnTo)}`}>
                    {t("auth.login.register")}
                </Link>
            </p>
        </AuthPageShell>
    );
}
