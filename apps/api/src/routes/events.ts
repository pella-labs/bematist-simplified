import type { Sql } from "postgres";
import { verifyIngestKey } from "../auth/verifyIngestKey";
import { BadRequestError } from "../errors";
import { insertEvents } from "../pipeline/insertEvents";
import { validateBatch } from "../pipeline/validate";

export async function eventsRoute(req: Request, sql: Sql): Promise<Response> {
  const verified = await verifyIngestKey(sql, req.headers.get("authorization"));

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    throw new BadRequestError("request body is not valid JSON");
  }

  const batch = validateBatch(body);
  const result = await insertEvents(sql, verified.orgId, verified.developerId, batch);
  return Response.json(result);
}
