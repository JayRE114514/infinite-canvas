import { createTransport, type Transporter } from "nodemailer";

import type { AppConfig } from "../../config.js";

/** 身份模块只依赖这个接口，生产用 SMTP，测试注入内存实现。 */
export type Mailer = {
    sendVerification(email: string, url: string): Promise<void>;
    /** url 是完整的同源邀请接受地址，收件人可直接打开。 */
    sendWorkspaceInvitation(email: string, url: string): Promise<void>;
};

/** 使用已校验的 SMTP 配置，不在此处读取环境变量。 */
export function createSmtpMailer(config: AppConfig): Mailer {
    const transporter: Transporter = createTransport({
        host: config.smtp.host,
        port: config.smtp.port,
        secure: config.smtp.port === 465,
        auth: config.smtp.user ? { user: config.smtp.user, pass: config.smtp.password } : undefined,
    });

    const send = async (to: string, subject: string, text: string) => {
        await transporter.sendMail({ from: config.smtp.from, to, subject, text });
    };

    return {
        sendVerification: (email, url) => send(email, "验证你的邮箱", `请点击以下链接完成邮箱验证：\n${url}`),
        sendWorkspaceInvitation: (email, url) =>
            send(email, "工作区邀请", `你收到一个工作区邀请，请点击以下链接接受：\n${url}`),
    };
}
