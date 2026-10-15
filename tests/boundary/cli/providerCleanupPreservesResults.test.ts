import { Cli } from "incur";
import pino from "pino";
import { expect, it } from "vitest";

import type { ApktoolResourceAnalysisPort } from "../../../src/application/apktool/ApktoolResourceAnalysisPort.js";
import type { WasmArtifactService } from "../../../src/application/wasm/WasmArtifactService.js";
import { createAnalysisExecution } from "../../../src/application/AnalysisProvider.js";
import { registerApktoolCommands } from "../../../src/cli/apktoolCommands.js";
import { registerWasmCommands } from "../../../src/cli/wasmCommands.js";
import type { CliInstance } from "../../../src/cli/types.js";
import { presentOmittableDefaults } from "../../../src/cli/omittableDefaults.js";
import { AnalysisUnsupportedTargetError } from "../../../src/domain/analysisErrorCore.js";
import { ProviderCleanupError } from "../../../src/domain/providerCleanupError.js";
import { err, ok } from "../../../src/domain/result.js";

// A failed workspace cleanup used to replace the completed Evidence or the
// primary diagnostics with a generic cleanup response (morluto/rea#3935).

const silent = pino({ level: "silent" });

const serve = async (
  register: (cli: CliInstance) => void,
  argv: readonly string[],
): Promise<Record<string, unknown>> => {
  const cli = Cli.create("rea", { sync: false });
  register(cli);
  presentOmittableDefaults(cli);
  let stdout = "";
  await cli.serve([...argv], {
    env: {},
    exit: () => {},
    stdout: (text) => {
      stdout += text;
    },
  });
  return JSON.parse(stdout) as Record<string, unknown>;
};

const blockedWorkspace = (providerId: string): ProviderCleanupError =>
  new ProviderCleanupError(
    providerId,
    ["/tmp/retained-workspace"],
    { reason: "workspace removal was denied" },
    { operation: "close" },
  );

const apktoolCli =
  (provider: ApktoolResourceAnalysisPort) =>
  (cli: CliInstance): void =>
    registerApktoolCommands(cli, silent, {}, provider);

it("keeps completed apktool Evidence when workspace cleanup fails", async () => {
  const provider: ApktoolResourceAnalysisPort = {
    async inspectAvailability() {
      throw new Error("unexpected provider probe");
    },
    async close() {
      throw blockedWorkspace("apktool");
    },
    async execute() {
      return ok(
        createAnalysisExecution(
          { strings: [{ name: "marker", value: "completed-observation" }] },
          { id: "apktool", name: "Apktool", version: null },
        ),
      );
    },
  };
  const output = await serve(apktoolCli(provider), [
    "decode-android-resources",
    "/targets/app.apk",
    "--json",
  ]);
  expect(output).toMatchObject({
    code: "cleanup_incomplete",
    details: {
      resources: ["/tmp/retained-workspace"],
      partial_observation: { operation: "decode_android_resources" },
    },
  });
  expect(JSON.stringify(output)).toContain("completed-observation");
});

it("keeps the primary apktool failure when workspace cleanup also fails", async () => {
  const provider: ApktoolResourceAnalysisPort = {
    async inspectAvailability() {
      throw new Error("unexpected provider probe");
    },
    async close() {
      throw blockedWorkspace("apktool");
    },
    async execute() {
      return err(
        new AnalysisUnsupportedTargetError(
          "decode_android_resources",
          "/targets/app.apk",
          "primary-decode-failure-marker",
        ),
      );
    },
  };
  const output = await serve(apktoolCli(provider), [
    "decode-android-resources",
    "/targets/app.apk",
    "--json",
  ]);
  expect(output.message).toContain("primary-decode-failure-marker");
  expect(JSON.stringify(output.details)).toContain("/tmp/retained-workspace");
  expect(JSON.stringify(output)).toContain("workspace removal was denied");
});

it("keeps completed WASM Evidence when the toolchain workspace cannot be removed", async () => {
  const service = {
    async inspect() {
      return ok(
        createAnalysisExecution(
          { wat: "(module)" },
          { id: "wabt-artifact", name: "WABT", version: "1.0.42" },
        ),
      );
    },
    async close() {
      throw new Error("EACCES: permission denied, rmdir");
    },
  } as unknown as WasmArtifactService;
  const output = await serve(
    (cli) => registerWasmCommands(cli, silent, {}, service),
    ["inspect-wasm-artifact", "/targets/module.wasm", "--json"],
  );
  expect(output).toMatchObject({
    code: "cleanup_incomplete",
    details: {
      partial_observation: {
        provider: { id: "wabt-artifact" },
        result: { wat: "(module)" },
      },
    },
  });
  expect(JSON.stringify(output)).toContain("(module)");
  expect(JSON.stringify(output)).toContain("permission denied");
});
