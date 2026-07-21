import { describe, expect, it } from "vitest";

import { parseCliArguments } from "./arguments.js";

describe("parseCliArguments", () => {
  it("uses safe defaults and resolves the input path", () => {
    expect(parseCliArguments(["diagram.svg"], "/work")).toEqual({
      help: false,
      inputPath: "/work/diagram.svg",
      layout: "wide",
    });
  });

  it("parses all conversion options", () => {
    expect(
      parseCliArguments(
        [
          "input.svg",
          "--output",
          "slides/output.pptx",
          "--layout",
          "standard",
          "--background",
          "#f8fafc",
        ],
        "/work",
      ),
    ).toEqual({
      backgroundColor: "#f8fafc",
      help: false,
      inputPath: "/work/input.svg",
      layout: "standard",
      outputPath: "/work/slides/output.pptx",
    });
  });

  it("allows help without an input", () => {
    expect(parseCliArguments(["--help"])).toMatchObject({ help: true });
  });

  it.each([
    { args: [], message: "Missing input SVG file" },
    { args: ["one.svg", "two.svg"], message: "Only one input SVG" },
    { args: ["one.svg", "--wat"], message: "Unknown option" },
    { args: ["one.svg", "--layout", "square"], message: "Invalid layout" },
    { args: ["one.svg", "--output"], message: "Missing value" },
  ])("rejects invalid arguments: $message", ({ args, message }) => {
    expect(() => parseCliArguments(args)).toThrow(message);
  });
});
