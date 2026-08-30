import { Client } from "pg";

export class TaskEventNotifier {
    readonly #client: Client;
    readonly #subscribers = new Map<string, Set<() => void>>();

    constructor(connectionString: string) {
        this.#client = new Client({ connectionString });
    }

    async start(): Promise<void> {
        await this.#client.connect();
        this.#client.on("notification", (notification) => {
            if (!notification.payload) return;
            for (const subscriber of this.#subscribers.get(notification.payload) ?? []) subscriber();
        });
        await this.#client.query("listen ai_task_events");
    }

    subscribe(taskId: string, subscriber: () => void): () => void {
        const subscribers = this.#subscribers.get(taskId) ?? new Set<() => void>();
        subscribers.add(subscriber);
        this.#subscribers.set(taskId, subscribers);
        return () => {
            subscribers.delete(subscriber);
            if (subscribers.size === 0) this.#subscribers.delete(taskId);
        };
    }

    async close(): Promise<void> {
        this.#subscribers.clear();
        await this.#client.end();
    }
}
