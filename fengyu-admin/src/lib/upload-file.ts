export type UploadFileLike = {
  name?: string;
  type?: string;
  size?: number;
  arrayBuffer: () => Promise<ArrayBuffer>;
};

export function isUploadFileLike(value: unknown): value is UploadFileLike {
  return (
    !!value &&
    typeof value === "object" &&
    "arrayBuffer" in value &&
    typeof (value as { arrayBuffer?: unknown }).arrayBuffer === "function"
  );
}

export function bufferToUploadFileLike(buffer: Buffer, name: string, type = "application/octet-stream"): UploadFileLike {
  return {
    name,
    type,
    size: buffer.byteLength,
    async arrayBuffer() {
      return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;
    },
  };
}
