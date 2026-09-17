import { describe, expect, it, vi } from "vitest";
import {
  classifySerenityEndpointTrust,
  normalizeSerenityEndpoint,
  parseSerenityEndpoint,
  probeSerenity,
  serenityEndpointRequiresDeploymentOwner,
} from "./serenity-client.js";

const TOKEN = "serenity_test_token";

describe("serenity endpoint helpers", () => {
  it("appends /mcp when missing", () => {
    expect(normalizeSerenityEndpoint("http://127.0.0.1:8787")).toBe("http://127.0.0.1:8787/mcp");
    expect(normalizeSerenityEndpoint("https://serenity.example.test/mcp")).toBe(
      "https://serenity.example.test/mcp",
    );
  });

  it("rejects credentials, queries, and fragments", () => {
    expect(() => parseSerenityEndpoint("https://user:pass@serenity.example.test/mcp")).toThrow(
      /credentials/,
    );
    expect(() => parseSerenityEndpoint("https://serenity.example.test/mcp?x=1")).toThrow(/query/);
    expect(() => parseSerenityEndpoint("https://serenity.example.test/mcp#frag")).toThrow(
      /fragment/,
    );
  });

  it("requires deployment-owner trust for loopback, private LAN, and private DNS", () => {
    expect(serenityEndpointRequiresDeploymentOwner("http://127.0.0.1:8787/mcp")).toBe(true);
    expect(serenityEndpointRequiresDeploymentOwner("http://192.168.1.10:8787/mcp")).toBe(true);
    expect(serenityEndpointRequiresDeploymentOwner("https://192.168.1.10:8787/mcp")).toBe(true);
    expect(serenityEndpointRequiresDeploymentOwner("https://serenity.internal/mcp")).toBe(true);
    expect(serenityEndpointRequiresDeploymentOwner("https://serenity.example.test/mcp")).toBe(
      false,
    );
  });

  it("rejects public HTTP endpoints and private-LAN cleartext HTTP", () => {
    expect(() => normalizeSerenityEndpoint("http://serenity.example.test/mcp")).toThrow(/loopback/);
    expect(() => normalizeSerenityEndpoint("http://192.168.1.10:8787/mcp")).toThrow(/loopback/);
  });
});

describe("serenity SSRF fetch path", () => {
  it("rejects public HTTPS when DNS returns a private address", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    const result = await probeSerenity(
      { endpoint: "https://serenity.example.test/mcp", token: TOKEN },
      undefined,
      {
        fetch: fetchMock,
        resolveHostname: async () => [{ address: "10.1.2.3", family: 4 as const }],
      },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/private address/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("allows public HTTPS when DNS returns a public address (safe fetch runs)", async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error("safe-path-fetch-reached");
    });
    let resolved = false;
    const result = await probeSerenity(
      { endpoint: "https://serenity.example.test/mcp", token: TOKEN },
      undefined,
      {
        fetch: fetchMock,
        resolveHostname: async () => {
          resolved = true;
          return [{ address: "203.0.113.10", family: 4 as const }];
        },
      },
    );
    expect(resolved).toBe(true);
    expect(fetchMock).toHaveBeenCalled();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/safe-path-fetch-reached|Could not reach/);
  });

  it("uses plain fetch for loopback without DNS pinning", async () => {
    let resolved = false;
    const fetchMock = vi.fn(async () => {
      throw new Error("plain-fetch-reached");
    });
    const result = await probeSerenity(
      { endpoint: "http://127.0.0.1:8787/mcp", token: TOKEN },
      undefined,
      {
        fetch: fetchMock,
        resolveHostname: async () => {
          resolved = true;
          return [{ address: "10.1.2.3", family: 4 as const }];
        },
      },
    );
    expect(resolved).toBe(false);
    expect(fetchMock).toHaveBeenCalled();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/plain-fetch-reached/);
  });

  it("rejects public-looking HTTPS when DNS is private unless prepare marked trust", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    const result = await probeSerenity(
      { endpoint: "https://serenity.example.test/mcp", token: TOKEN },
      undefined,
      {
        fetch: fetchMock,
        resolveHostname: async () => [{ address: "10.8.0.2", family: 4 as const }],
      },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/private address/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("pins private-trust HTTPS hostnames and rejects metadata rebinding", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    const result = await probeSerenity(
      {
        endpoint: "https://serenity.example.test/mcp",
        token: TOKEN,
        endpointTrust: "private",
      },
      undefined,
      {
        fetch: fetchMock,
        resolveHostname: async () => [{ address: "169.254.169.254", family: 4 as const }],
      },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/blocked address/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("pins private-trust HTTPS to the first DNS answer within a request", async () => {
    let resolveCalls = 0;
    const fetchMock = vi.fn(async () => {
      throw new Error("pinned-first-answer-fetch-reached");
    });
    const result = await probeSerenity(
      {
        endpoint: "https://serenity.example.test/mcp",
        token: TOKEN,
        endpointTrust: "private",
      },
      undefined,
      {
        fetch: fetchMock,
        resolveHostname: async () => {
          resolveCalls += 1;
          if (resolveCalls === 1) {
            return [{ address: "10.8.0.2", family: 4 as const }];
          }
          return [{ address: "10.9.9.9", family: 4 as const }];
        },
      },
    );
    expect(resolveCalls).toBe(1);
    expect(fetchMock).toHaveBeenCalled();
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.error).toMatch(/pinned-first-answer-fetch-reached|Could not reach/);
  });

  it("pins private-trust HTTPS hostnames and rejects public rebinding", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    const result = await probeSerenity(
      {
        endpoint: "https://serenity.example.test/mcp",
        token: TOKEN,
        endpointTrust: "private",
      },
      undefined,
      {
        fetch: fetchMock,
        resolveHostname: async () => [{ address: "203.0.113.10", family: 4 as const }],
      },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/no longer resolves to a private address/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("pins private-trust HTTPS hostnames to private LAN answers", async () => {
    let resolved = false;
    const fetchMock = vi.fn(async () => {
      throw new Error("private-resolving-dns-fetch-reached");
    });
    const result = await probeSerenity(
      {
        endpoint: "https://serenity.example.test/mcp",
        token: TOKEN,
        endpointTrust: "private",
      },
      undefined,
      {
        fetch: fetchMock,
        resolveHostname: async () => {
          resolved = true;
          return [{ address: "10.8.0.2", family: 4 as const }];
        },
      },
    );
    expect(resolved).toBe(true);
    expect(fetchMock).toHaveBeenCalled();
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.error).toMatch(/private-resolving-dns-fetch-reached|Could not reach/);
  });

  it("classifies private-resolving HTTPS hostnames as private trust", async () => {
    await expect(
      classifySerenityEndpointTrust("https://serenity.example.test/mcp", async () => [
        { address: "10.8.0.2", family: 4 as const },
      ]),
    ).resolves.toBe("private");
    await expect(
      classifySerenityEndpointTrust("https://serenity.example.test/mcp", async () => [
        { address: "203.0.113.10", family: 4 as const },
      ]),
    ).resolves.toBe("public");
  });
  it("pins private DNS HTTPS and allows private LAN answers", async () => {
    let resolved = false;
    const fetchMock = vi.fn(async () => {
      throw new Error("private-dns-fetch-reached");
    });
    const result = await probeSerenity(
      { endpoint: "https://serenity.internal/mcp", token: TOKEN },
      undefined,
      {
        fetch: fetchMock,
        resolveHostname: async () => {
          resolved = true;
          return [{ address: "10.1.2.3", family: 4 as const }];
        },
      },
    );
    expect(resolved).toBe(true);
    expect(fetchMock).toHaveBeenCalled();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/private-dns-fetch-reached|Could not reach/);
  });

  it("uses plain fetch for private LAN HTTPS without assertPublicAddresses", async () => {
    let resolved = false;
    const fetchMock = vi.fn(async () => {
      throw new Error("private-lan-fetch-reached");
    });
    const result = await probeSerenity(
      { endpoint: "https://192.168.1.10:8787/mcp", token: TOKEN },
      undefined,
      {
        fetch: fetchMock,
        resolveHostname: async () => {
          resolved = true;
          return [{ address: "203.0.113.10", family: 4 as const }];
        },
      },
    );
    expect(resolved).toBe(false);
    expect(fetchMock).toHaveBeenCalled();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/private-lan-fetch-reached/);
  });
});
