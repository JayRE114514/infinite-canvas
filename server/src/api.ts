import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";

const config = loadConfig(process.env);
const app = await buildApp({ config });

// 监听失败也要走 close，否则 buildApp 自建的连接池不会被释放。
try {
    await app.listen({ port: config.port, host: process.env.HOST ?? "127.0.0.1" });
} catch (error) {
    await app.close().catch(() => {});
    throw error;
}
