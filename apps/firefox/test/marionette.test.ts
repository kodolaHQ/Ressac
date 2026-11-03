import { describe, expect, it } from "vitest";
import { decodeFrames, encodeFrame } from "../e2e/marionette";

describe("Marionette frames", () => {
  it("encodes then decodes a message", () => {
    expect(decodeFrames(encodeFrame([0, 1, "WebDriver:NewSession", {}]))).toEqual({
      messages: [[0, 1, "WebDriver:NewSession", {}]],
      rest: Buffer.alloc(0),
    });
  });

  it("two frames glued together", () => {
    const { messages } = decodeFrames(Buffer.concat([encodeFrame({ a: 1 }), encodeFrame({ b: 2 })]));
    expect(messages).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it("a frame split in two", () => {
    const frame = encodeFrame([1, 7, null, { value: "ok" }]);
    const start = decodeFrames(frame.subarray(0, 5));
    expect(start.messages).toEqual([]);
    expect(start.rest.length).toBe(5);
    expect(decodeFrames(Buffer.concat([start.rest, frame.subarray(5)])).messages).toEqual([[1, 7, null, { value: "ok" }]]);
  });

  it("length counts bytes, not characters", () => {
    expect(decodeFrames(encodeFrame({ text: "é😀" })).messages).toEqual([{ text: "é😀" }]);
  });
});
