// PortChecker: checkPortAvailable — real TCP, no mocking (a throwaway bind/close).
//   npx playwright test -c playwright.unit.config.ts tests/services/PortChecker.test.ts
import "./_stub-server-only";
import { test, expect } from "@playwright/test";
import net from "node:net";
import { checkPortAvailable } from "../../src/core/service/PortChecker";

test.describe("checkPortAvailable", () => {
  test("returns true for a random high port that is currently free", async () => {
    // Ports above 40000 are extremely unlikely to be in use in a test sandbox.
    const port = 40000 + Math.floor(Math.random() * 10000);
    expect(await checkPortAvailable(port)).toBe(true);
  });

  test("returns true for port 0 (the OS assigns an ephemeral port)", async () => {
    expect(await checkPortAvailable(0)).toBe(true);
  });

  test("returns false when the port is already bound", async () => {
    const server = net.createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (typeof address === "string" || address === null) throw new Error("expected an AddressInfo");
    const port = address.port;
    try {
      expect(await checkPortAvailable(port, "127.0.0.1")).toBe(false);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
