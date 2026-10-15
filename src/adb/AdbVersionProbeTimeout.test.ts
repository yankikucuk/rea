import { describe, expect, it, vi } from "vitest";

import { AdbProvider } from "./AdbProvider.js";
import { inspectAdbClient } from "./AdbConfiguration.js";
import { AnalysisTimeoutError } from "../domain/analysisErrorCore.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";

// The real probe deadline is ten seconds; the exec boundary is replaced so
// the version probe reports the same stop failure the real one produces.
vi.mock("../process/ExecFileOutput.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../process/ExecFileOutput.js")>();
  return {
    ...actual,
    execFileOutput: async (command: string, args: readonly string[]) => {
      if (args[0] === "version") {
        const error = new Error(`Command timed out after 10000 ms: ${command}`);
        Reflect.set(error, "code", "ETIMEDOUT");
        Reflect.set(error, "killed", true);
        Reflect.set(error, "signal", "SIGTERM");
        Reflect.set(error, "stdout", "");
        Reflect.set(error, "stderr", "");
        throw error;
      }
      return actual.execFileOutput(command, args);
    },
  };
});

const selection = {
  binary: "/opt/adb/adb",
  pathSource: "environment",
} as const;

describe("adb version probe deadline", () => {
  // A probe stopped at its deadline used to become a nonretryable
  // version_unresolved capability failure (morluto/rea#3886).
  it("reports the probe deadline as a typed timeout with its diagnostics", async () => {
    const rejected = await inspectAdbClient(selection).catch(
      (cause: unknown) => cause,
    );
    expect(rejected).toBeInstanceOf(AnalysisTimeoutError);
    if (!(rejected instanceof AnalysisTimeoutError)) throw rejected;
    expect(rejected.operation).toBe("inspect_adb_client");
    expect(rejected.timeoutMs).toBe(10_000);
    expect(rejected.diagnostics).toMatchObject({
      selected_binary: "/opt/adb/adb",
      path_source: "environment",
    });
  });

  it("projects a timed-out client inspection as provider_timeout", async () => {
    const provider = new AdbProvider({
      environment: { REA_ADB_PATH: "/opt/adb/adb" },
    });
    const result = await provider.execute({
      operation: "inspect_adb_client",
      input: {},
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const projected = projectAnalysisError(result.error);
    expect(projected).toMatchObject({
      code: "provider_timeout",
      category: "timeout",
      details: { operation: "inspect_adb_client", timeout_ms: 10_000 },
    });
    expect(projected.code).not.toBe("capability_unavailable");
  });

  it("reports the client unavailable for now instead of failing readiness", async () => {
    const provider = new AdbProvider({
      environment: { REA_ADB_PATH: "/opt/adb/adb" },
    });
    expect(await provider.inspectAvailability()).toMatchObject({
      status: "unavailable",
      code: "runtime_unavailable",
      diagnostics: { selected_binary: "/opt/adb/adb", timeout_ms: 10_000 },
    });
  });
});
