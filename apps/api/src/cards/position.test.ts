import { describe, expect, it } from "vitest";
import { between } from "./position.js";

describe("between", () => {
  it("matches the contract examples", () => {
    expect(between(null, null)).toBe("m");
    expect(between("a", "c")).toBe("b");
    expect(between("a", "b")).toBe("an");
  });

  it("handles open ends and shared prefixes", () => {
    for (const [lo, hi] of [[null, "m"], ["m", null], [null, "b"], ["az", "b"], ["a", "ab"], ["mz", "n"], ["zz", null]] as const) {
      const p = between(lo, hi);
      if (lo !== null) expect(p > lo).toBe(true);
      if (hi !== null) expect(p < hi).toBe(true);
      expect(p.endsWith("a")).toBe(false);
    }
  });

  it("rejects lo >= hi", () => {
    expect(() => between("b", "b")).toThrow(RangeError);
    expect(() => between("c", "b")).toThrow(RangeError);
  });

  it("1,000 random inserts stay strictly ordered", () => {
    const keys: string[] = [];
    for (let n = 0; n < 1000; n++) {
      const i = Math.floor(Math.random() * (keys.length + 1));
      keys.splice(i, 0, between(keys[i - 1] ?? null, keys[i] ?? null));
    }
    for (let i = 1; i < keys.length; i++) expect(keys[i - 1] < keys[i]).toBe(true);
    expect(new Set(keys).size).toBe(1000);
  });

  it("repeated inserts at the head stay ordered", () => {
    let head = between(null, null);
    for (let n = 0; n < 200; n++) {
      const next = between(null, head);
      expect(next < head).toBe(true);
      head = next;
    }
  });
});
