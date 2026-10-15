import { join } from "node:path";
import { expect, it } from "vitest";

import { AndroidAnalysisService } from "./AndroidAnalysisService.js";
import type { AndroidAnalysisPort } from "./AndroidAnalysisPort.js";
import { createAnalysisExecution } from "../AnalysisProvider.js";
import { AnalysisCancelledError } from "../../domain/analysisErrorCore.js";
import { projectAnalysisError } from "../../domain/analysisErrorProjection.js";
import { parseEvidence } from "../../domain/evidence.js";
import { ok } from "../../domain/result.js";
import { writeOrderedZip } from "../../../tests/fixtures/artifactEntryOrder.js";
import { createTestTempDirectory } from "../../../tests/fixtures/temporaryDirectory.js";

const identity = { id: "jadx", name: "Simulated JADX", version: "1" };

const packageObservation = {
  engine: {
    name: "fixture",
    version: "1",
    artifact_sha256: "a".repeat(64),
    source_revision: null,
    worker_count: 1,
    heap_limit_mib: null,
  },
  package_name: "example",
  version_name: null,
  version_code: null,
  min_sdk: null,
  target_sdk: null,
  permissions: [],
  manifest: { status: "complete", text: "", reported_total_bytes: 0 },
  class_count: 1,
  resource_count: 0,
  signature_verification: "not_performed",
};

const portCompleting = (onExecute: () => void): AndroidAnalysisPort => ({
  async inspectAvailability() {
    return { status: "available", code: null, reason: null, diagnostics: {} };
  },
  async close() {},
  async execute() {
    onExecute();
    return ok(createAnalysisExecution(packageObservation, identity));
  },
});

const writeApk = async (): Promise<string> => {
  const root = await createTestTempDirectory("rea-android-cancel-");
  const apk = join(root, "input.apk");
  await writeOrderedZip(apk, ["AndroidManifest.xml", "classes.dex"]);
  return apk;
};

// A provider that completes before the abort reaches it must not turn a
// cancelled request into a success (morluto/rea#3927).
it("returns cancelled with the completed Evidence when the engine finishes after cancellation", async () => {
  const apk = await writeApk();
  const controller = new AbortController();
  const service = new AndroidAnalysisService(
    portCompleting(() => controller.abort()),
  );
  const result = await service.execute(
    "inspect_android_package",
    { path: apk },
    { signal: controller.signal },
  );
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.error).toBeInstanceOf(AnalysisCancelledError);
  expect(projectAnalysisError(result.error)).toMatchObject({
    code: "cancelled",
  });
  const retained = parseEvidence(result.error.partialObservation);
  expect(retained.operation).toBe("inspect_android_package");
  expect(retained.provider).toEqual(identity);
  expect(retained.parameters).toEqual({ path: apk });
  expect(retained.normalized_result).toMatchObject({ package_name: "example" });
});

it("keeps successful Evidence while the request signal stays active", async () => {
  const apk = await writeApk();
  const service = new AndroidAnalysisService(portCompleting(() => undefined));
  const result = await service.execute(
    "inspect_android_package",
    { path: apk },
    { signal: new AbortController().signal },
  );
  if (!result.ok) throw result.error;
  expect(result.value.operation).toBe("inspect_android_package");
  expect(result.value.normalized_result).toMatchObject({
    package_name: "example",
  });
});
