import { describe, expect, it } from "vitest";

import { parseCliArguments } from "./arguments.js";

describe("parseCliArguments", () => {
  it("uses safe defaults and resolves the input path", () => {
    expect(parseCliArguments(["diagram.svg"], "/work")).toEqual({
      help: false,
      format: "pptx",
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
          "slides/output.drawio",
          "--format",
          "drawio",
          "--layout",
          "standard",
          "--mode",
          "faithful",
          "--background",
          "#f8fafc",
        ],
        "/work",
      ),
    ).toEqual({
      backgroundColor: "#f8fafc",
      format: "drawio",
      help: false,
      inputPath: "/work/input.svg",
      layout: "standard",
      mode: "faithful",
      outputPath: "/work/slides/output.drawio",
    });
  });

  it("allows help without an input", () => {
    expect(parseCliArguments(["--help"])).toMatchObject({ help: true });
  });

  it.each([
    { args: [], message: "Missing input file" },
    { args: ["one.svg", "two.svg"], message: "Only one input file" },
    { args: ["one.svg", "--wat"], message: "Unknown option" },
    { args: ["one.svg", "--layout", "square"], message: "Invalid layout" },
    { args: ["one.svg", "--format", "pdf"], message: "Invalid format" },
    { args: ["one.svg", "--mode", "fast"], message: "Invalid mode" },
    { args: ["one.svg", "--background", "white"], message: "Invalid background" },
    { args: ["one.svg", "--background", "#fff"], message: "Invalid background" },
    { args: ["one.svg", "--output"], message: "Missing value" },
  ])("rejects invalid arguments: $message", ({ args, message }) => {
    expect(() => parseCliArguments(args)).toThrow(message);
  });
});
