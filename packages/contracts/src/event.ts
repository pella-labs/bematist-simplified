import { z } from "zod";

export const EVENT_KINDS = [
  "user_prompt",
  "assistant_response",
  "tool_call",
  "tool_result",
  "session_start",
  "session_end",
] as const;

export const EVENT_SOURCES = ["claude-code", "codex", "cursor"] as const;

const uuid = z.string().uuid();
const isoTimestamp = z.string().datetime({ offset: true });

export const UsageSchema = z
  .object({
    input_tokens: z.number().int().nonnegative(),
    output_tokens: z.number().int().nonnegative(),
    cache_read_tokens: z.number().int().nonnegative(),
    cache_creation_tokens: z.number().int().nonnegative(),
  })
  .strict();

export const UserPromptPayloadSchema = z
  .object({
    kind: z.literal("user_prompt"),
    text: z.string(),
  })
  .strict();

export const AssistantResponsePayloadSchema = z
  .object({
    kind: z.literal("assistant_response"),
    text: z.string(),
    stop_reason: z.string().nullable(),
  })
  .strict();

export const ToolCallPayloadSchema = z
  .object({
    kind: z.literal("tool_call"),
    tool_name: z.string(),
    tool_input: z.unknown(),
    tool_use_id: z.string().nullable(),
  })
  .strict();

export const ToolResultPayloadSchema = z
  .object({
    kind: z.literal("tool_result"),
    tool_name: z.string(),
    tool_output: z.unknown(),
    tool_use_id: z.string().nullable(),
    is_error: z.boolean().nullable(),
  })
  .strict();

export const SessionStartPayloadSchema = z
  .object({
    kind: z.literal("session_start"),
    source_session_id: z.string(),
  })
  .strict();

export const SessionEndPayloadSchema = z
  .object({
    kind: z.literal("session_end"),
    source_session_id: z.string(),
    reason: z.string().nullable(),
  })
  .strict();

export const PayloadSchema = z.discriminatedUnion("kind", [
  UserPromptPayloadSchema,
  AssistantResponsePayloadSchema,
  ToolCallPayloadSchema,
  ToolResultPayloadSchema,
  SessionStartPayloadSchema,
  SessionEndPayloadSchema,
]);

export const EventEnvelopeSchema = z
  .object({
    client_event_id: uuid,
    schema_version: z.literal(1),
    session_id: z.string().min(1),
    source_session_id: z.string().min(1),
    source: z.enum(EVENT_SOURCES),
    source_version: z.string().min(1),
    client_version: z.string().min(1),
    ts: isoTimestamp,
    event_seq: z.number().int().nonnegative(),
    kind: z.enum(EVENT_KINDS),
    payload: PayloadSchema,
    cwd: z.string().nullable(),
    git_branch: z.string().nullable(),
    git_sha: z.string().nullable(),
    model: z.string().nullable(),
    usage: UsageSchema.nullable(),
    duration_ms: z.number().int().nonnegative().nullable(),
    success: z.boolean().nullable(),
    raw: z.unknown(),
  })
  .strict()
  .refine((env) => env.kind === env.payload.kind, {
    message: "payload.kind must match envelope.kind",
    path: ["payload", "kind"],
  });

export const BATCH_MAX = 1000;

export const BatchSchema = z.array(EventEnvelopeSchema).min(1).max(BATCH_MAX);

export type Usage = z.infer<typeof UsageSchema>;
export type Payload = z.infer<typeof PayloadSchema>;
export type UserPromptPayload = z.infer<typeof UserPromptPayloadSchema>;
export type AssistantResponsePayload = z.infer<typeof AssistantResponsePayloadSchema>;
export type ToolCallPayload = z.infer<typeof ToolCallPayloadSchema>;
export type ToolResultPayload = z.infer<typeof ToolResultPayloadSchema>;
export type SessionStartPayload = z.infer<typeof SessionStartPayloadSchema>;
export type SessionEndPayload = z.infer<typeof SessionEndPayloadSchema>;
export type EventEnvelope = z.infer<typeof EventEnvelopeSchema>;
export type EventBatch = z.infer<typeof BatchSchema>;
export type EventKind = (typeof EVENT_KINDS)[number];
export type EventSource = (typeof EVENT_SOURCES)[number];
