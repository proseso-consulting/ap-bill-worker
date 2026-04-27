import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { geminiWithRetryAndFallback } from "../src/gemini.js";

const config = {
  gemini: {
    apiKey: "test-key",
    model: "gemini-2.5-pro",
    fallbackModel: "gemini-2.5-flash",
    cheapModel: "gemini-2.5-flash"
  }
};

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ candidates: [{ content: { parts: [{ text: "{}" }] } }] })
    }))
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("geminiWithRetryAndFallback model override", () => {
  it("uses the explicit model when passed via opts", async () => {
    await geminiWithRetryAndFallback(config, { contents: [] }, { model: "gemini-2.5-flash" });
    const url = String(globalThis.fetch.mock.calls[0][0]);
    expect(url).toContain("/models/gemini-2.5-flash:generateContent");
    expect(url).not.toContain("/models/gemini-2.5-pro:generateContent");
  });

  it("uses config.gemini.model when no override given", async () => {
    await geminiWithRetryAndFallback(config, { contents: [] });
    const url = String(globalThis.fetch.mock.calls[0][0]);
    expect(url).toContain("/models/gemini-2.5-pro:generateContent");
  });
});
