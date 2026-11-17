import type { ErrorRequestHandler } from "express";
import { ConversationBusy } from "@earendil-works/pi-durable";
import type { ErrorCode } from "../../dpi-sdk/src/api.js";
import { StateError } from "../../dpi-sdk/src/app-state.js";

const STATUS: Record<ErrorCode, number> = {
  unauthorized: 401,
  not_found: 404,
  invalid: 400,
  busy: 409,
  conflict: 409,
  ambiguous: 409,
  unavailable: 503,
  internal: 500,
  offline: 503,
};

export class ApiFault extends Error {
  readonly status: number;
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
    this.status = STATUS[code];
  }
}

export const invalid = (message: string) => new ApiFault("invalid", message);
export const notFound = (message: string) => new ApiFault("not_found", message);

export const errorMiddleware: ErrorRequestHandler = (err, req, res, _next) => {
  let fault: ApiFault;
  if (err instanceof ApiFault) fault = err;
  else if (err instanceof ConversationBusy) fault = new ApiFault("busy", "The agent is busy and the input asked to be rejected while busy");
  else if (err instanceof StateError) fault = new ApiFault(err.code, err.message);
  else if (err?.type === "entity.parse.failed") fault = invalid("Body must be valid JSON");
  else if (err?.type === "entity.too.large") fault = invalid("Body too large");
  else {
    console.error(`[dpi-backend] ${req.method} ${req.path}:`, err instanceof Error ? err.stack : err);
    fault = new ApiFault("internal", err instanceof Error ? err.message : "Internal error");
  }
  if (res.headersSent) return void res.end();
  res.status(fault.status).json({ error: { code: fault.code, message: fault.message } });
};
