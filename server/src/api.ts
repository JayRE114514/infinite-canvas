import { buildApp } from "./app.js";

const app = await buildApp();
const port = Number(process.env.PORT ?? 4000);

await app.listen({ port, host: process.env.HOST ?? "127.0.0.1" });
