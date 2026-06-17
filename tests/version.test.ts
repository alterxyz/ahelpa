import { describe, expect, test } from "bun:test";
import { VERSION } from "../src/version";
import pkg from "../package.json";

describe("version", () => {
  test("source version stays in sync with package.json", () => {
    expect(VERSION).toBe(pkg.version);
  });
});
