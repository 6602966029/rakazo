import { afterEach, describe, expect, it, vi } from "vitest";
import { prepareImageFile } from "./prepare-image-file.js";

afterEach(() => vi.restoreAllMocks());
afterEach(() => vi.unstubAllGlobals());

function browserImage(width: number, height: number) {
  const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:photo");
  vi.stubGlobal(
    "Image",
    class {
      naturalWidth = width;
      naturalHeight = height;
      onload = () => {};
      set src(_value: string) {
        this.onload();
      }
    },
  );
  const drawImage = vi.fn();
  const canvas = {
    width: 0,
    height: 0,
    getContext: vi.fn(() => ({ drawImage })),
    toBlob: vi.fn((callback: BlobCallback, type: string) =>
      callback(new Blob(["small"], { type })),
    ),
  };
  vi.stubGlobal("document", { createElement: vi.fn(() => canvas) });
  return { canvas, drawImage, revoke };
}

describe("prepareImageFile", () => {
  it.each([
    [4000, 3000, 1600, 1200],
    [2000, 4000, 800, 1600],
  ])(
    "fits a %i by %i photo into %i by %i pixels",
    async (width, height, expectedWidth, expectedHeight) => {
      const { canvas, drawImage, revoke } = browserImage(width, height);
      const file = new File([new Uint8Array(100)], "photo.jpg", {
        type: "image/jpeg",
        lastModified: 123,
      });
      const result = await prepareImageFile(file);
      expect([canvas.width, canvas.height]).toEqual([expectedWidth, expectedHeight]);
      expect(drawImage).toHaveBeenCalledWith(
        expect.anything(),
        0,
        0,
        expectedWidth,
        expectedHeight,
      );
      expect(canvas.toBlob).toHaveBeenCalledWith(expect.any(Function), "image/jpeg", 0.7);
      expect([result.name, result.type, result.lastModified]).toEqual([file.name, file.type, 123]);
      expect(await result.text()).toBe("small");
      expect(revoke).toHaveBeenCalledWith("blob:photo");
    },
  );

  it("keeps PNG encoding and infers it from the name", async () => {
    const { canvas } = browserImage(3200, 1600);
    const result = await prepareImageFile(new File([new Uint8Array(100)], "photo.png"));
    expect(result.type).toBe("image/png");
    expect(canvas.toBlob).toHaveBeenCalledWith(expect.any(Function), "image/png", 0.7);
  });

  it("leaves small images byte-for-byte unchanged and releases the URL", async () => {
    const { canvas, revoke } = browserImage(1600, 1200);
    const file = new File(["original"], "small.png", { type: "image/png" });
    expect(await prepareImageFile(file)).toBe(file);
    expect(canvas.toBlob).not.toHaveBeenCalled();
    expect(revoke).toHaveBeenCalledWith("blob:photo");
  });

  it.each(["image/gif", "image/webp", "application/pdf"])(
    "preserves %s without decoding",
    async (type) => {
      const file = new File(["original"], "attachment", { type });
      expect(await prepareImageFile(file)).toBe(file);
    },
  );

  it.each(["decode", "context", "encode", "empty", "larger"])(
    "falls back after %s failure",
    async (failure) => {
      const { canvas, revoke } = browserImage(4000, 3000);
      if (failure === "decode")
        vi.stubGlobal(
          "Image",
          class {
            set src(_value: string) {
              throw new Error("decode failed");
            }
          },
        );
      if (failure === "context") canvas.getContext.mockReturnValue(null!);
      if (failure === "encode")
        canvas.toBlob.mockImplementation(() => {
          throw new Error("encode failed");
        });
      if (failure === "empty") canvas.toBlob.mockImplementation((callback) => callback(null));
      if (failure === "larger")
        canvas.toBlob.mockImplementation((callback) =>
          callback(new Blob([new Uint8Array(200)], { type: "image/jpeg" })),
        );
      const file = new File([new Uint8Array(100)], "photo.jpg", { type: "image/jpeg" });
      expect(await prepareImageFile(file)).toBe(file);
      expect(revoke).toHaveBeenCalledWith("blob:photo");
    },
  );
});
