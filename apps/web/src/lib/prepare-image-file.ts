import { inferAttachmentMimeType } from "@rakazo/core";

const MAX_IMAGE_EDGE = 1_600;

/** Match mobile photo uploads while preserving animated and unsupported formats. */
export async function prepareImageFile(file: File): Promise<File> {
  const mimeType = inferAttachmentMimeType(file.name, file.type);
  if (mimeType !== "image/jpeg" && mimeType !== "image/png") return file;

  let url: string | undefined;
  try {
    url = URL.createObjectURL(file);
    const image = new Image();
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error("Could not decode image"));
      image.src = url!;
    });
    const edge = Math.max(image.naturalWidth, image.naturalHeight);
    if (edge <= MAX_IMAGE_EDGE) return file;

    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round((image.naturalWidth * MAX_IMAGE_EDGE) / edge));
    canvas.height = Math.max(1, Math.round((image.naturalHeight * MAX_IMAGE_EDGE) / edge));
    const context = canvas.getContext("2d");
    if (!context) return file;
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, mimeType, 0.7));
    if (!blob || blob.type !== mimeType || blob.size >= file.size) return file;
    return new File([blob], file.name, { type: mimeType, lastModified: file.lastModified });
  } catch {
    // A failed conversion should leave the attachment available to send.
    return file;
  } finally {
    if (url) URL.revokeObjectURL(url);
  }
}
