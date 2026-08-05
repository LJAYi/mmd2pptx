import { describe, expect, it } from "vitest";

import {
  createPkceChallenge,
  createPkceVerifier,
  extractMermaidMarkdownBlocks,
  mermaidComplexityError,
  normalizeBrokerOrigin,
} from "../src/github-source.js";

describe("GitHub source integration helpers", () => {
  it("accepts secure broker origins and local HTTP development", () => {
    expect(normalizeBrokerOrigin("https://broker.example/ ")).toBe("https://broker.example");
    expect(normalizeBrokerOrigin("http://localhost:8787")).toBe("http://localhost:8787");
    expect(normalizeBrokerOrigin("http://example.com")).toBeNull();
    expect(normalizeBrokerOrigin("https://broker.example/path")).toBeNull();
    expect(normalizeBrokerOrigin(undefined)).toBeNull();
  });

  it("generates RFC 7636-compatible PKCE values", async () => {
    const verifier = createPkceVerifier();
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{64}$/u);
    await expect(createPkceChallenge(
      "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk",
    )).resolves.toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  });

  it("extracts only non-empty Mermaid fenced blocks from Markdown", () => {
    const blocks = extractMermaidMarkdownBlocks([
      "# Architecture",
      "```ts",
      "const ignored = true;",
      "```",
      "```mermaid",
      "flowchart LR",
      "  A --> B",
      "```",
      "~~~MERMAID title=second",
      "sequenceDiagram",
      "  A->>B: Hello",
      "~~~~",
    ].join("\n"));

    expect(blocks).toEqual([
      { label: "Mermaid block 1", source: "flowchart LR\n  A --> B" },
      { label: "Mermaid block 2", source: "sequenceDiagram\n  A->>B: Hello" },
    ]);
  });

  it("rejects GitHub sources outside the renderer complexity budget", () => {
    expect(mermaidComplexityError("flowchart LR\nA --> B")).toBeNull();
    expect(mermaidComplexityError(Array.from({ length: 2_001 }, (_, index) => `N${index}`).join("\n")))
      .toContain("2,000 statements");
    expect(mermaidComplexityError(`flowchart LR\n${"x".repeat(16 * 1024 + 1)}`))
      .toContain("16 KiB");
    expect(mermaidComplexityError(Array.from({ length: 5_001 }, () => "%% comment").join("\n")))
      .toContain("5,000 lines");
  });
});
