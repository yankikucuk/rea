import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { expect, it } from "vitest";

import { AnalysisProviderRegistry } from "../../../src/application/binary/AnalysisProviderRegistry.js";
import { composeBinarySession } from "../../../src/application/binary/BinarySessionComposition.js";
import { parseConfig } from "../../../src/config/parseConfig.js";
import { AnalysisCancelledError } from "../../../src/domain/analysisErrorCore.js";
import { err } from "../../../src/domain/result.js";
import { GhidraClient } from "../../../src/ghidra/GhidraClient.js";
import { ghidraProfileInstallationHost } from "../../../src/ghidra/GhidraInstallation.fixture.js";
import { GhidraProvider } from "../../../src/ghidra/GhidraProvider.js";
import { silentLogger } from "../../../src/logger.js";
import { createServer } from "../../../src/server/createServer.js";
import { elf } from "../../../src/domain/binaryTarget.fixture.js";
import { parseMcpToolError } from "../../fixtures/mcpToolError.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

// Only installation inspection and the launcher are simulated: the launcher
// holds cold startup open until its signal aborts. Requests use the production
// provider, client and public MCP session routing (morluto/rea#3983).
const gate = () => {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

const sharedStartupFixture = async () => {
  const entered = gate();
  const secondEntered = gate();
  const runtimeRoots: string[] = [];
  const clients: GhidraClient[] = [];
  let calls = 0;
  let waiterSettled = false;
  let startupSignal: AbortSignal | undefined;
  const config = parseConfig({
    GHIDRA_INSTALL_DIR: resolve("fixture-ghidra-install"),
    REA_GHIDRA_STARTUP_TIMEOUT_MS: "5000",
  });
  if (!config.ok) throw config.error;
  const provider = new GhidraProvider(
    config.value,
    silentLogger,
    {},
    ghidraProfileInstallationHost,
    (options) => {
      const raw = new GhidraClient({
        ...options,
        platform: process.platform,
        launcher: {
          async launch(launchSession, launchOptions) {
            runtimeRoots.push(launchSession.runtimeRoot);
            entered.resolve();
            const signal = launchOptions?.signal;
            startupSignal = signal;
            await new Promise<void>((resolve) => {
              if (signal?.aborted) resolve();
              else
                signal?.addEventListener("abort", () => resolve(), {
                  once: true,
                });
            });
            return err(new AnalysisCancelledError("open_binary"));
          },
        },
      });
      clients.push(raw);
      return {
        start: raw.start.bind(raw),
        close: raw.close.bind(raw),
        callTool: (...args: Parameters<GhidraClient["callTool"]>) => {
          const pending = raw.callTool(...args);
          if (++calls === 2) {
            secondEntered.resolve();
            return pending.finally(() => {
              waiterSettled = true;
            });
          }
          return pending;
        },
      };
    },
  );
  const session = composeBinarySession(
    new AnalysisProviderRegistry([provider]),
  );
  const server = createServer(
    { kind: "session", session },
    { logger: silentLogger },
  );
  const directory = await createTestTempDirectory("rea-ghidra-startup-");
  const target = join(directory, "target.elf");
  await writeFile(target, elf(2, 1, 62));
  const mcp = new Client({ name: "startup-cancellation", version: "1.0.0" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await mcp.connect(clientTransport);
  const opened = await mcp.callTool({
    name: "open_binary",
    arguments: { path: target, provider_id: "ghidra" },
  });
  expect(opened.isError, JSON.stringify(opened.content)).not.toBe(true);
  const owner = new AbortController();
  const waiter = new AbortController();
  const first = mcp
    .callTool({ name: "list_strings", arguments: {} }, { signal: owner.signal })
    .catch((error: unknown) => ({ clientAbort: (error as Error).message }));
  await entered.promise;
  const second = mcp.callTool(
    { name: "list_strings", arguments: {} },
    { signal: waiter.signal },
  );
  void second.catch(() => undefined);
  await secondEntered.promise;
  const errorOf = (result: Awaited<typeof second>) =>
    parseMcpToolError(result).error;
  const close = async () => {
    owner.abort();
    waiter.abort();
    await Promise.allSettled([first, second]);
    await Promise.allSettled([mcp.close(), server.close()]);
    await session.close();
    for (const root of runtimeRoots) expect(existsSync(root)).toBe(false);
  };
  return {
    owner,
    waiter,
    first,
    second,
    errorOf,
    close,
    session,
    clients,
    waiterSettled: () => waiterSettled,
    startupAborted: () => startupSignal?.aborted === true,
  };
};

const waitUntil = async (
  predicate: () => boolean,
  budgetMs: number,
): Promise<boolean> => {
  const end = Date.now() + budgetMs;
  while (!predicate() && Date.now() < end) await delay(10);
  return predicate();
};

// The SDK rejects a cancelled client call at once, so these tests observe the
// server-side provider operation and the startup gate, not the client promise.
it("settles a cancelled follower while the initiator keeps the shared startup", async () => {
  const fixture = await sharedStartupFixture();
  try {
    fixture.waiter.abort(new Error("cancel follower"));
    expect(await waitUntil(fixture.waiterSettled, 2_000)).toBe(true);
    expect(fixture.startupAborted()).toBe(false);
  } finally {
    await fixture.close();
  }
});

it("keeps an uncancelled follower waiting when only the initiator cancels", async () => {
  const fixture = await sharedStartupFixture();
  try {
    fixture.owner.abort(new Error("cancel initiator"));
    await delay(150);
    expect(fixture.startupAborted()).toBe(false);
    expect(fixture.waiterSettled()).toBe(false);
    // The follower's own cancellation ends its wait and, as the last
    // interested caller, abandons the startup.
    fixture.waiter.abort(new Error("cancel follower"));
    expect(await waitUntil(fixture.startupAborted, 2_000)).toBe(true);
    expect(await waitUntil(fixture.waiterSettled, 2_000)).toBe(true);
  } finally {
    await fixture.close();
  }
});

it("reports a startup stopped by close as a provider failure, not the follower's cancellation", async () => {
  const fixture = await sharedStartupFixture();
  try {
    fixture.owner.abort(new Error("cancel initiator"));
    await delay(50);
    expect(fixture.startupAborted()).toBe(false);
    const [client] = fixture.clients;
    if (client === undefined) throw new Error("no Ghidra client was created");
    const closing = client.close();
    const error = fixture.errorOf(await fixture.second);
    expect(fixture.waiter.signal.aborted).toBe(false);
    expect(error.code).not.toBe("cancelled");
    expect(error.category).not.toBe("cancelled");
    await closing;
  } finally {
    await fixture.close();
  }
});
