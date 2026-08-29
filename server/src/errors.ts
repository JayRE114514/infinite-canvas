export class AppError extends Error {
    constructor(
        readonly code: string,
        readonly statusCode: number,
        message: string,
        readonly retryable = false,
    ) {
        super(message);
        this.name = "AppError";
    }
}
