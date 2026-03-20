import { afterEach, describe, expect, it, vi } from "vitest";
import dns from "node:dns";
import { safeFetch, validateUrl } from "./ssrf-guard.js";

describe("ssrf-guard", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("rejects DNS resolutions to private addresses", async () => {
    vi.spyOn(dns.promises, "lookup").mockResolvedValue({
      address: "127.0.0.1",
      family: 4,
    });

    await expect(validateUrl("https://example.com/internal")).rejects.toThrow(
      "DNS rebinding blocked"
    );
  });

  it("pins HTTP fetches to the resolved IP and preserves the Host header", async () => {
    vi.spyOn(dns.promises, "lookup").mockResolvedValue({
      address: "93.184.216.34",
      family: 4,
    });

    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response("ok", {
        status: 200,
        headers: { "content-type": "text/plain" },
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    await safeFetch("http://example.com/demo?x=1", {
      headers: { Accept: "text/plain" },
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://93.184.216.34/demo?x=1");

    const headers = new Headers(init?.headers);
    expect(headers.get("host")).toBe("example.com");
    expect(headers.get("accept")).toBe("text/plain");
  });

  it("blocks redirects to localhost before a second fetch is attempted", async () => {
    vi.spyOn(dns.promises, "lookup").mockResolvedValue({
      address: "93.184.216.34",
      family: 4,
    });

    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(null, {
        status: 302,
        headers: { location: "http://localhost/admin" },
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(safeFetch("http://example.com/start")).rejects.toThrow(
      "Blocked host: localhost"
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
