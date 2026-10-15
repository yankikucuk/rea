import { EventEmitter } from "node:events";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import { afterEach, expect, it } from "vitest";
import { z } from "zod";

import { RecordedCrashService } from "../../src/application/binaryDiagnostics/RecordedCrashService.js";
import { PwntoolsRecordedCrashProvider } from "../../src/native/pwntools/PwntoolsRecordedCrashProvider.js";
import { PWNTOOLS_PROVIDER_IDENTITY } from "../../src/native/pwntools/PwntoolsRelease.js";
import {
  cleanupOwnedProcessGroup,
  type OwnedProcessGroup,
  type ProcessTableEntry,
} from "../../src/process/ProcessOwnership.js";
import type { OwnedProviderProcessSpawnOptions } from "../../src/process/ProviderProcess.js";
import {
  recordedCrashFixture,
  recordedCrashFixtureBytes,
} from "../fixtures/binaryDiagnostics/recordedCrash.js";

// The optional debugger stage starts Python, which execs the configured GDB.
// Cleanup on cancellation must recognize that correctly owned debugger and
// retire it instead of rejecting it as a foreign command (morluto/rea#4011).

const replyRequestSchema = z.object({ reply_path: z.string() });

/** Minimal child handle: output streams, exit state and a guarded kill. */
class FakeChild extends EventEmitter {
  readonly pid = 41234;
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;

  kill(): boolean {
    throw new Error("kill must go through verified ownership cleanup");
  }

  finish(): void {
    this.exitCode = 0;
    this.stdout.end();
    this.stderr.end();
    this.emit("exit", 0, null);
    this.emit("close", 0, null);
  }
}

interface FakeEngine {
  readonly signals: string[];
  liveDebugger: boolean;
  rounds: number;
  retire: () => void;
}

const hostOverride = (
  platform: NodeJS.Platform,
  arch: string,
): (() => void) => {
  const originalPlatform = Object.getOwnPropertyDescriptor(
    process,
    "platform",
  )!;
  const originalArch = Object.getOwnPropertyDescriptor(process, "arch")!;
  Object.defineProperty(process, "platform", { value: platform });
  Object.defineProperty(process, "arch", { value: arch });
  return () => {
    Object.defineProperty(process, "platform", originalPlatform);
    Object.defineProperty(process, "arch", originalArch);
  };
};

/**
 * Provider whose first spawn answers the basic decoder and whose second spawn
 * is the debugger launcher: once it is live, its process-table command is the
 * configured GDB (the launcher exec'd it) and the request is cancelled.
 */
const createFakeProvider = (input: {
  readonly root: string;
  readonly controller: AbortController;
  readonly engine: FakeEngine;
  readonly payload: Record<string, unknown>;
  readonly liveParentPid: number;
}): PwntoolsRecordedCrashProvider => {
  const gdb = join(input.root, "gdb");
  return new PwntoolsRecordedCrashProvider(
    {
      REA_PWNTOOLS_PYTHON: process.execPath,
      REA_PWNDBG_GDB: gdb,
      REA_PWNDBG_GDBINIT: join(input.root, "gdbinit.py"),
      REA_PWNDBG_VENV_PATH: join(input.root, "venv"),
    },
    async (spawn: OwnedProviderProcessSpawnOptions) => {
      const basic = input.engine.rounds++ === 0;
      const child = new FakeChild();
      let live = true;
      const finish = (): void => {
        if (!live) return;
        live = false;
        if (!basic) input.engine.liveDebugger = false;
        child.finish();
      };
      const request = replyRequestSchema.parse(
        JSON.parse(await readFile(spawn.arguments.at(-1)!, "utf8")),
      );
      if (basic) {
        await writeFile(
          request.reply_path,
          JSON.stringify({
            ok: true,
            profile: PWNTOOLS_PROVIDER_IDENTITY.version,
            value: input.payload,
          }),
        );
        setImmediate(finish);
      } else {
        input.engine.liveDebugger = true;
        input.engine.retire = finish;
        setImmediate(() => input.controller.abort());
      }
      const ownership: OwnedProcessGroup = {
        runId: spawn.runId,
        leaderPid: child.pid,
        processGroupId: child.pid,
        expectedParentPid: process.pid,
        ...(spawn.expectedCommand === null
          ? {}
          : { expectedCommand: spawn.expectedCommand ?? spawn.command }),
      };
      const tableEntry = (): ProcessTableEntry => ({
        pid: child.pid,
        parentPid: basic ? process.pid : input.liveParentPid,
        processGroupId: child.pid,
        state: "S",
        command: basic
          ? `${spawn.command} -I core.py`
          : `${gdb} -nx -nh --batch --quiet`,
      });
      return {
        process: child as never,
        ownership,
        cleanup: () =>
          cleanupOwnedProcessGroup(ownership, {
            listProcesses: async () => (live ? [tableEntry()] : []),
            environment: async () => ({ REA_PROCESS_RUN_ID: spawn.runId }),
            signalGroup: (_pid, signal) => {
              input.engine.signals.push(signal);
              finish();
            },
          }),
      };
    },
    async () => {
      const path = join(input.root, "runtime");
      await mkdir(path);
      return { path, close: () => rm(path, { recursive: true }) };
    },
  );
};

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

const runCancelledDebuggerStage = async (liveParentPid: number) => {
  const root = join(
    tmpdir(),
    `rea-recorded-crash-debugger-cancel-${process.pid}-${liveParentPid}`,
  );
  roots.push(root);
  await mkdir(root, { recursive: true });
  const file = join(root, "sample.core");
  const report = recordedCrashFixture(file);
  await writeFile(file, recordedCrashFixtureBytes(report));
  await writeFile(join(root, "gdb"), "", { mode: 0o700 });
  await writeFile(join(root, "gdbinit.py"), "");
  await mkdir(join(root, "venv"), { recursive: true });
  const {
    artifact: _artifact,
    diagnostics: _diagnostics,
    debugger: _debugger,
    decoder_diagnostics: _decoderDiagnostics,
    ...payload
  } = report;
  const controller = new AbortController();
  const engine: FakeEngine = {
    signals: [],
    liveDebugger: false,
    rounds: 0,
    retire: () => undefined,
  };
  const provider = createFakeProvider({
    root,
    controller,
    engine,
    payload,
    liveParentPid,
  });
  const restoreHost = hostOverride("linux", "x64");
  try {
    const result = await new RecordedCrashService(provider).inspectAndClose(
      { path: file, include_debugger_context: true },
      { signal: controller.signal },
    );
    return { result, engine };
  } finally {
    engine.retire();
    await provider.close();
    restoreHost();
  }
};

it("retires the exec'd debugger on cancellation and reports plain cancellation", async () => {
  const { result, engine } = await runCancelledDebuggerStage(process.pid);
  expect(engine.rounds).toBe(2);
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("expected cancellation");
  expect(result.error._tag).toBe("AnalysisCancelledError");
  expect(result.error.cleanupIncomplete).toBe(false);
  expect(engine.signals).toEqual(["SIGKILL"]);
  expect(engine.liveDebugger).toBe(false);
});

it("still refuses a live debugger whose parent is not the owner", async () => {
  const { result, engine } = await runCancelledDebuggerStage(process.pid + 1);
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("expected a retained cleanup failure");
  expect(result.error.cleanupIncomplete).toBe(true);
  expect(JSON.stringify(result.error)).toContain(
    "owned launcher parent identity did not match",
  );
  expect(engine.signals).toEqual([]);
});
