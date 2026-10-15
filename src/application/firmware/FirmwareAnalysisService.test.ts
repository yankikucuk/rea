import { describe, expect, it } from "vitest";

import { FirmwareAnalysisService } from "./FirmwareAnalysisService.js";
import type { FirmwareAnalysisPort } from "./FirmwareAnalysisPort.js";
import type { AnalysisExecution } from "../AnalysisProvider.js";
import { projectAnalysisError } from "../../domain/analysisErrorProjection.js";
import { ok } from "../../domain/result.js";

const digest = "a".repeat(64);

const completedInspection: AnalysisExecution = {
  result: {
    engine: {
      name: "fixture-engine",
      version: "1.0.0",
      executable_path: "/opt/fixture/engine",
      executable_sha256: digest,
      source_revision: null,
      worker_count: 1,
    },
    input_size: 1,
    regions: [],
    coverage: "signature_scan",
  },
  rawResult: null,
  provider: { id: "fixture-firmware", name: "Fixture firmware", version: null },
  limitations: [],
  locations: [],
  subject: { path: "/artifacts/input.bin", sha256: digest, format: "file" },
};

/** A port whose engine completes only after the caller has cancelled. */
const lateCompletionPort = (
  controller: AbortController,
): FirmwareAnalysisPort => ({
  execute: async (_request, options) => {
    expect(options?.signal?.aborted).toBe(false);
    controller.abort();
    expect(options?.signal?.aborted).toBe(true);
    return ok(completedInspection);
  },
});

describe("FirmwareAnalysisService cancellation", () => {
  // A cancelled request whose engine still completed must not publish
  // success-shaped Evidence; the completed facts ride on the cancellation
  // (morluto/rea#3923).
  it("returns cancelled with the completed Evidence when the engine finishes after cancellation", async () => {
    const controller = new AbortController();
    const service = new FirmwareAnalysisService(lateCompletionPort(controller));
    const result = await service.execute(
      "inspect_firmware_regions",
      { path: "/artifacts/input.bin" },
      { signal: controller.signal },
    );
    if (result.ok) throw new Error("expected a cancelled result");
    expect(result.error._tag).toBe("AnalysisCancelledError");
    const projected = projectAnalysisError(result.error);
    expect(projected).toMatchObject({ code: "cancelled" });
    expect(projected.details).toMatchObject({
      partial_observation: {
        operation: "inspect_firmware_regions",
        normalized_result: { input_size: 1, coverage: "signature_scan" },
        subject: { digest: { sha256: digest }, format: "file" },
      },
    });
  });

  it("keeps successful Evidence when the request was never cancelled", async () => {
    const service = new FirmwareAnalysisService({
      execute: async () => ok(completedInspection),
    });
    const result = await service.execute(
      "inspect_firmware_regions",
      { path: "/artifacts/input.bin" },
      { signal: new AbortController().signal },
    );
    if (!result.ok) throw result.error;
    expect(result.value.operation).toBe("inspect_firmware_regions");
    expect(result.value.normalized_result).toMatchObject({ input_size: 1 });
  });
});
