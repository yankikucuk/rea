import { describe, expect } from "vitest";

import { workspaceCliTest as cliTest } from "../../support/cli/workspaceCliFixture.js";

const malformedEndpoint = "not a url";
const electronEndpoint = "http://127.0.0.1:9222";

// The browser and Inspector commands retain the rejected field and reason;
// the Electron siblings dropped them (morluto/rea#3865).
const invalidInputs = [
  {
    command: "list-electron-targets",
    arguments: [malformedEndpoint],
    operation: "list_electron_targets",
    issue: {
      path: ["cdp_endpoint"],
      reason: "invalid_value",
      message: "Invalid CDP endpoint URL",
    },
  },
  {
    command: "inspect-electron-page",
    arguments: [electronEndpoint, ""],
    operation: "inspect_electron_page",
    issue: { path: ["target_id"], reason: "out_of_range", minimum: 1 },
  },
] as const;

describe("Electron CLI input diagnostics", () => {
  cliTest.for(invalidInputs)(
    "$command retains the named contract's correction details",
    async (input, { cli, workspace }) => {
      const result = await cli.run({
        arguments: [input.command, ...input.arguments, "--json"],
        cwd: workspace.root,
        environment: { ...workspace.environment, REA_LOG_LEVEL: "silent" },
      });

      expect(result.exitCode).toBe(1);
      expect(result.json).toMatchObject({
        error: "Electron analysis failed",
        code: "invalid_request",
        category: "invalid_input",
        message:
          "Analysis input is invalid. Check the arguments and try again.",
        retryable: true,
        remediation: { action: "Correct the listed arguments and retry." },
        details: {
          operation: input.operation,
          issues: expect.arrayContaining([input.issue]),
        },
      });
      expect(result.stdout).not.toContain(malformedEndpoint);
      expect(result.stderr).not.toContain(malformedEndpoint);
    },
  );

  cliTest(
    "list-electron-targets does not echo rejected endpoint credentials",
    async ({ cli, workspace }) => {
      const endpoint =
        "http://rea-diagnostic-user:rea-diagnostic-secret@127.0.0.1:9222/";
      const result = await cli.run({
        arguments: ["list-electron-targets", endpoint, "--json"],
        cwd: workspace.root,
        environment: { ...workspace.environment, REA_LOG_LEVEL: "debug" },
      });

      expect(result.exitCode).toBe(1);
      expect(result.json).toMatchObject({
        code: "invalid_request",
        details: {
          issues: [
            {
              path: ["cdp_endpoint"],
              reason: "invalid_value",
              message:
                "CDP endpoint must be an explicit-port HTTP URL on 127.0.0.1 or ::1",
            },
          ],
        },
      });
      const output = result.stdout + result.stderr;
      expect(output).not.toContain(endpoint);
      expect(output).not.toContain("rea-diagnostic-user");
      expect(output).not.toContain("rea-diagnostic-secret");
    },
  );
});
