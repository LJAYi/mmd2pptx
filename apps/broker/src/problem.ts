export class BrokerProblem extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly rateLimit?: { retryAfterSeconds?: number; resetAt?: string },
  ) {
    super(message);
    this.name = "BrokerProblem";
  }
}

export function problemResponse(problem: BrokerProblem, requestId: string, origin?: string): Response {
  const headers = new Headers({
    "Cache-Control": "no-store",
    "Content-Type": "application/problem+json; charset=utf-8",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Request-Id": requestId,
  });
  if (origin) {
    headers.set("Access-Control-Allow-Origin", origin);
    headers.set("Access-Control-Expose-Headers", "Retry-After, X-Request-Id");
    headers.set("Vary", "Origin");
  }
  const retryAfter = problem.rateLimit?.retryAfterSeconds ??
    (problem.code === "BROKER_RATE_LIMITED" ? 60 : undefined);
  if (retryAfter !== undefined) headers.set("Retry-After", String(retryAfter));
  return Response.json(
    {
      type: "about:blank",
      title: problem.message,
      status: problem.status,
      detail: problem.message,
      code: problem.code,
      request_id: requestId,
      ...(problem.rateLimit?.resetAt ? { reset_at: problem.rateLimit.resetAt } : {}),
    },
    { status: problem.status, headers },
  );
}
