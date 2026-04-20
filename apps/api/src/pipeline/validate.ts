import { BATCH_MAX, BatchSchema, type EventBatch } from "@bematist/contracts";
import { ValidationError } from "../errors";

export function validateBatch(input: unknown): EventBatch {
  if (!Array.isArray(input)) {
    throw new ValidationError("request body must be an array of events");
  }
  if (input.length === 0) {
    throw new ValidationError("batch must contain at least one event");
  }
  if (input.length > BATCH_MAX) {
    throw new ValidationError(`batch exceeds maximum size of ${BATCH_MAX}`);
  }
  const parsed = BatchSchema.safeParse(input);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const field = first ? first.path.join(".") : undefined;
    const msg = first ? first.message : "invalid event batch";
    throw new ValidationError(field ? `${field}: ${msg}` : msg, field);
  }
  return parsed.data;
}
