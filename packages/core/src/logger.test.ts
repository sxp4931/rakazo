import { describe, expect, it } from "vitest";
import { createLogger } from "./logger.js";

describe("createLogger", () => {
  it("tags loggers with the service name", () => {
    expect(createLogger("test-service").bindings().name).toBe("test-service");
  });

  it("returns the same instance for the same name", () => {
    expect(createLogger("test-service")).toBe(createLogger("test-service"));
  });

  it("is silent under test unless LOG_LEVEL is set", () => {
    const expected = process.env.LOG_LEVEL ?? "silent";
    expect(createLogger("test-service").level).toBe(expected);
  });
});
