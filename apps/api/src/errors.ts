export type ErrorCode = "unauthorized" | "bad_request" | "validation_failed" | "internal_error";

export interface ApiErrorBody {
  error: {
    code: ErrorCode;
    message: string;
    field?: string;
  };
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: ErrorCode;
  readonly field: string | undefined;

  constructor(status: number, code: ErrorCode, message: string, field?: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.field = field;
  }

  toResponse(): Response {
    const body: ApiErrorBody = {
      error: {
        code: this.code,
        message: this.message,
        ...(this.field ? { field: this.field } : {}),
      },
    };
    return Response.json(body, { status: this.status });
  }
}

export class UnauthorizedError extends ApiError {
  constructor(message = "unauthorized") {
    super(401, "unauthorized", message);
    this.name = "UnauthorizedError";
  }
}

export class BadRequestError extends ApiError {
  constructor(message = "bad request") {
    super(400, "bad_request", message);
    this.name = "BadRequestError";
  }
}

export class ValidationError extends ApiError {
  constructor(message: string, field?: string) {
    super(400, "validation_failed", message, field);
    this.name = "ValidationError";
  }
}
