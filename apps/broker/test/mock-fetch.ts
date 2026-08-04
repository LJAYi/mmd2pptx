import { expect, vi } from "vitest";

interface MockRoute {
  method: string;
  url: string;
  status: number;
  response: unknown;
  headers?: Record<string, string>;
  responseHeaders?: Record<string, string>;
}

export class MockFetchRouter {
  private readonly routes: MockRoute[] = [];

  constructor() {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const request = new Request(input, init);
      const index = this.routes.findIndex(
        (route) =>
          route.method === request.method &&
          route.url === request.url &&
          Object.entries(route.headers ?? {}).every(
            ([name, value]) => request.headers.get(name) === value,
          ),
      );
      if (index < 0) throw new Error(`No outbound mock for ${request.method} ${request.url}`);
      const route = this.routes.splice(index, 1)[0];
      if (!route) throw new Error("Outbound mock disappeared");
      return Response.json(route.response, {
        status: route.status,
        ...(route.responseHeaders ? { headers: route.responseHeaders } : {}),
      });
    });
  }

  json(
    method: string,
    url: string,
    status: number,
    response: unknown,
    headers?: Record<string, string>,
    responseHeaders?: Record<string, string>,
  ): void {
    this.routes.push({
      method,
      url,
      status,
      response,
      ...(headers ? { headers } : {}),
      ...(responseHeaders ? { responseHeaders } : {}),
    });
  }

  assertDone(): void {
    expect(this.routes, "unconsumed outbound request mocks").toEqual([]);
  }
}
