import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";

import {
  inventoryFirmwareOutput,
  readFirmwareReport,
  snapshotFirmware,
} from "../../../src/firmware/FirmwareFiles.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

it.each([
  ["invalid leading byte", [0xff]],
  ["incomplete sequence", [0xe2, 0x82]],
  ["overlong sequence", [0xc0, 0xaf]],
  ["encoded surrogate", [0xed, 0xa0, 0x80]],
])(
  "rejects complete JSON containing %s without repairing producer bytes",
  async (_name, bytes) => {
    const root = await createTestTempDirectory("rea-firmware-report-");
    const path = join(root, "report.json");
    await writeFile(
      path,
      Buffer.concat([
        Buffer.from('{"description":"'),
        Buffer.from(bytes),
        Buffer.from('"}'),
      ]),
    );
    await expect(
      readFirmwareReport(path, "inspect_firmware_regions"),
    ).rejects.toMatchObject({
      _tag: "AnalysisOutputError",
      reason: "Tool report is not valid complete JSON",
    });
  },
);

it("preserves valid Unicode and a literal replacement character in producer JSON", async () => {
  const root = await createTestTempDirectory("rea-firmware-report-");
  const path = join(root, "report.json");
  const report = { description: "固件 🧩 \ufffd", path: "/输入/firmware.bin" };
  await writeFile(path, JSON.stringify(report));
  expect(await readFirmwareReport(path, "inspect_firmware_regions")).toEqual(
    report,
  );
});

it("orders extracted firmware paths by code point independently of host locale", async () => {
  const root = await createTestTempDirectory("rea-firmware-inventory-");
  await mkdir(join(root, "Lib"));
  for (const path of ["a.bin", "z.bin", "\u00e4.bin", "B.bin", "Lib/x.bin"])
    await writeFile(join(root, path), "");
  const entries = await inventoryFirmwareOutput(
    root,
    1024,
    16,
    "inspect_firmware_regions",
  );
  // Locale collation would interleave case and place "ä" by language rules.
  expect(entries.map(({ relativePath }) => relativePath)).toEqual([
    "B.bin",
    "Lib/x.bin",
    "a.bin",
    "z.bin",
    "\u00e4.bin",
  ]);
});

// A caller-selected FIFO without a writer must not block the firmware
// snapshot before its regular-file check; the rejection has to settle on its
// own and honour the request signal (morluto/rea#3887).
it.skipIf(process.platform === "win32")(
  "rejects a named-pipe firmware input promptly instead of blocking on open",
  async () => {
    const root = await createTestTempDirectory("rea-firmware-fifo-");
    const fifo = join(root, "input.fifo");
    await promisify(execFile)("mkfifo", [fifo]);
    const regular = join(root, "input.bin");
    await writeFile(regular, "firmware");
    const settled = await Promise.race([
      snapshotFirmware(
        { operation: "inspect_firmware_regions", input: { path: fifo } },
        join(root, "fifo-root"),
        AbortSignal.timeout(5_000),
      ).then(
        () => "fulfilled",
        (cause: unknown) => cause,
      ),
      new Promise<string>((resolve) =>
        setTimeout(() => resolve("pending"), 2_000),
      ),
    ]);
    expect(settled).toMatchObject({
      _tag: "AnalysisInputError",
      operation: "inspect_firmware_regions",
    });
    await mkdir(join(root, "regular-root"));
    const snapshot = await snapshotFirmware(
      { operation: "inspect_firmware_regions", input: { path: regular } },
      join(root, "regular-root"),
      AbortSignal.timeout(5_000),
    );
    expect(snapshot.size).toBe(8);
  },
);
