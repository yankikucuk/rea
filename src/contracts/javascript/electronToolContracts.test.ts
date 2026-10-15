import { describe, expect, it } from "vitest";

import { analyzeJavaScriptApplicationRequestSchema } from "./electronToolContracts.js";
import { analyzeJavaScriptApplicationInputSchema } from "../../domain/javascript/javascriptApplicationAnalysis.js";

describe("analyze_javascript_application MCP request contract", () => {
  // A relative input would select content by the MCP server's working
  // directory, which the caller does not choose (morluto/rea#3924).
  it.each(["app", "./app", "missing-app", "apps/app.asar"])(
    "rejects the relative input_path %j with the absolute-path requirement",
    (input_path) => {
      const parsed = analyzeJavaScriptApplicationRequestSchema.safeParse({
        input_path,
        format: "directory",
      });
      expect(parsed.success).toBe(false);
      if (parsed.success) return;
      expect(parsed.error.issues).toEqual([
        expect.objectContaining({
          path: ["input_path"],
          message: expect.stringContaining(
            "input_path must be an absolute local filesystem path",
          ),
        }),
      ]);
    },
  );

  it("accepts an absolute input_path and keeps the request defaults", () => {
    expect(
      analyzeJavaScriptApplicationRequestSchema.safeParse({
        input_path: "/Applications/Example.app/Contents/Resources/app.asar",
      }),
    ).toMatchObject({
      success: true,
      data: {
        input_path: "/Applications/Example.app/Contents/Resources/app.asar",
        format: "auto",
        detail: "complete",
      },
    });
  });

  it("leaves the shared domain schema shape-neutral for the CLI route", () => {
    // The CLI resolves its path argument before it reaches this schema.
    expect(
      analyzeJavaScriptApplicationInputSchema.safeParse({
        input_path: "relative/app.asar",
      }).success,
    ).toBe(true);
  });
});
