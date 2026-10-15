import { describe, expect, test } from "bun:test";
import { cosine, topK } from "./rank";

describe("cosine", () => {
  test("scores direction, not magnitude", () => {
    expect(cosine([1, 0], [5, 0])).toBeCloseTo(1);
    expect(cosine([1, 0], [0, 3])).toBeCloseTo(0);
    expect(cosine([1, 1], [-1, -1])).toBeCloseTo(-1);
  });

  test("returns 0 for zero vectors and mismatched lengths", () => {
    expect(cosine([0, 0], [1, 1])).toBe(0);
    expect(cosine([1, 2], [1, 2, 3])).toBe(0);
    expect(cosine([], [])).toBe(0);
  });
});

describe("topK", () => {
  const items = [
    { id: "a", vector: [0, 1] },
    { id: "b", vector: [1, 0] },
    { id: "c", vector: [1, 1] },
    { id: "d", vector: [1, 0] },
  ];

  test("returns the best k matches, best first", () => {
    expect(topK([1, 0], items, (item) => item.vector, 3).map(({ item }) => item.id)).toEqual(["b", "d", "c"]);
  });

  test("keeps input order for ties and tolerates k beyond the list", () => {
    expect(topK([1, 0], items, (item) => item.vector, 10).map(({ item }) => item.id)).toEqual(["b", "d", "c", "a"]);
    expect(topK([1, 0], items, (item) => item.vector, 0)).toEqual([]);
  });
});
