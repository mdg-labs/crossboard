import { zValidator } from "@hono/zod-validator";
import type { ValidationTargets } from "hono";
import type { ZodType } from "zod";
import { errorResponse } from "./errors.js";

export function validate<
  Target extends keyof ValidationTargets,
  Schema extends ZodType,
>(target: Target, schema: Schema) {
  return zValidator(target, schema, (result, c) => {
    if (!result.success) {
      const message = result.error.issues
        .map((issue) =>
          issue.path.length > 0
            ? `${issue.path.join(".")}: ${issue.message}`
            : issue.message,
        )
        .join("; ");
      return errorResponse(c, 400, "invalid_request", message);
    }
  });
}
