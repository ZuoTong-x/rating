declare module "yauzl" {
  import type { Readable } from "node:stream";

  export type Entry = {
    fileName: string | Buffer;
    uncompressedSize: number;
  };

  export type Archive = {
    on(event: "entry", listener: (entry: Entry) => void): Archive;
    once(event: "end", listener: () => void): Archive;
    once(event: "error", listener: (error: Error) => void): Archive;
    readEntry(): void;
    close(): void;
    openReadStream(entry: Entry, callback: (error: Error | null, stream: Readable) => void): void;
  };

  const yauzl: {
    open(
      path: string,
      options: { lazyEntries: boolean; decodeStrings: boolean; autoClose: boolean },
      callback: (error: Error | null, archive: Archive) => void,
    ): void;
  };
  export default yauzl;
}
