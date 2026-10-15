import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { AnalysisCancelledError } from "../domain/analysisErrorCore.js";
import type { AnalysisError } from "../domain/analysisErrorBase.js";
import type { JsonValue } from "../domain/jsonValue.js";
import { ok, type Result } from "../domain/result.js";
import type { NativeCallTrace, NativeCallTracer } from "./LldbCallTracer.js";
import { observeNativeCalls } from "./NativeCallObservation.js";
import { nativeMachoTarget } from "../../tests/fixtures/nativeCommands.js";
import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";

class NeverStartedTracer implements NativeCallTracer {
  calls = 0;

  trace(): Promise<Result<NativeCallTrace, AnalysisError>> {
    this.calls += 1;
    throw new Error("tracer must not run after hash cancellation");
  }

  close(): Promise<Result<null, AnalysisError>> {
    return Promise.resolve(ok(null));
  }
}

describe("native call target digest cancellation", () => {
  it("returns tagged cancellation when hashing aborts after a chunk", async () => {
    const directory = await createTestTempDirectory("rea-native-digest-");
    const path = join(directory, "fixture");
    const bytes = "selected executable";
    await writeFile(path, bytes);
    const target = {
      ...nativeMachoTarget(path),
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
    const signal = new AbortController();
    const tracer = new NeverStartedTracer();

    const observed = await observeNativeCalls(
      target,
      { breakpoints: [{ kind: "function", name: "main" }] } satisfies Record<
        string,
        JsonValue
      >,
      tracer,
      signal.signal,
      async () => {
        signal.abort();
        throw new DOMException("read aborted", "AbortError");
      },
    );

    expect(!observed.ok && observed.error).toBeInstanceOf(
      AnalysisCancelledError,
    );
    expect(tracer.calls).toBe(0);
  });
});

const completedTrace = (
  request: Parameters<NativeCallTracer["trace"]>[0],
): NativeCallTrace => ({
  debugger: { path: "/usr/bin/lldb", sha256: "b".repeat(64), version: "fx" },
  run: {
    status: "traced",
    version: "fx",
    pid: 99,
    outcome: "exited",
    exit_status: 0,
    exit_description: null,
    killed: false,
    terminated: true,
    target_identity: {
      loaded_image_sha256: null,
      selected_file_sha256: request.expectedSha256,
      file_device: "1",
      file_inode: "2",
      module_path: request.executable,
      module_uuid: "fixture-uuid",
      stable: true,
    },
    elapsed_ms: 1,
    breakpoints: request.input.breakpoints.map((_, index) => ({
      index,
      location_count: 1,
      locations: [],
    })),
    events: [],
    resource_limit_reached: false,
    target_output: {
      stdout_bytes: 0,
      stderr_bytes: 0,
      stdout_truncated: false,
      stderr_truncated: false,
      stdout_complete: true,
      stderr_complete: true,
    },
    other_stops: [],
  },
  stdout: { text: "", bytes: 0, truncated: false, complete: true },
  stderr: { text: "", bytes: 0, truncated: false, complete: true },
  terminated: true,
});

// A tracer can finish after the caller cancelled; the completed run must be
// reported as a cancelled observation, not published (morluto/rea#4009).
describe("native call cancellation during finalization", () => {
  it.each([true, false])(
    "reports cancellation with the completed trace retained (abort=%s)",
    async (abort) => {
      const directory = await createTestTempDirectory("rea-native-final-");
      const path = join(directory, "fixture");
      const bytes = "selected executable";
      await writeFile(path, bytes);
      const target = {
        ...nativeMachoTarget(path),
        sha256: createHash("sha256").update(bytes).digest("hex"),
      };
      const controller = new AbortController();
      const tracer: NativeCallTracer = {
        trace(request) {
          if (abort) controller.abort();
          return Promise.resolve(ok(completedTrace(request)));
        },
        close: () => Promise.resolve(ok(null)),
      };
      const observed = await observeNativeCalls(
        target,
        { breakpoints: [{ kind: "function", name: "main" }] } satisfies Record<
          string,
          JsonValue
        >,
        tracer,
        controller.signal,
      );
      if (abort) {
        if (observed.ok) throw new Error("expected cancellation");
        expect(observed.error).toBeInstanceOf(AnalysisCancelledError);
        expect(observed.error.partialObservation).toMatchObject({
          target: { path, sha256: target.sha256 },
          process: { pid: 99 },
        });
      } else {
        if (!observed.ok) throw observed.error;
        expect(observed.value.process.outcome).toBe("exited");
      }
    },
  );
});
