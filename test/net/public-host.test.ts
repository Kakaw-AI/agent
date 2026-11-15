import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertPublicHost,
  assertPublicUrl,
  isBlockedAddress,
} from "../../src/net/public-host.js";

describe("isBlockedAddress", () => {
  it.each([
    "127.0.0.1",
    "10.1.2.3",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "169.254.169.254", // cloud metadata
    "100.64.0.1",
    "0.0.0.0",
    "::1",
    "fd00::1",
    "fe80::1",
    "::ffff:127.0.0.1", // IPv4-mapped loopback
    "::ffff:10.0.0.1",
    "not-an-ip",
  ])("blocks %s", (address) => {
    expect(isBlockedAddress(address)).toBe(true);
  });

  it.each(["8.8.8.8", "1.1.1.1", "172.32.0.1", "2606:4700:4700::1111"])(
    "allows %s",
    (address) => {
      expect(isBlockedAddress(address)).toBe(false);
    },
  );
});

describe("the guard", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("is off outside production so local development can reach localhost", async () => {
    vi.stubEnv("NODE_ENV", "development");
    await expect(assertPublicHost("127.0.0.1")).resolves.toBeUndefined();
  });

  it("rejects private targets in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    await expect(assertPublicHost("169.254.169.254")).rejects.toThrow(/private/);
    await expect(assertPublicHost("localhost")).rejects.toThrow(/private/);
    await expect(assertPublicUrl("http://[::1]:11434/v1")).rejects.toThrow(/private/);
    await expect(assertPublicUrl("file:///etc/passwd")).rejects.toThrow(/http/);
    await expect(assertPublicHost("8.8.8.8")).resolves.toBeUndefined();
  });

  it("can be switched off for self-hosted installs", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("ALLOW_PRIVATE_HOSTS", "true");
    await expect(assertPublicHost("10.0.0.5")).resolves.toBeUndefined();
  });
});
