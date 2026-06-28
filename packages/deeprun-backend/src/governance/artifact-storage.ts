import { createReadStream } from "node:fs";
import { copyFile, mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Readable } from "node:stream";
import { sha256Blob, type Digest } from "./artifacts.js";

export interface BlobMetadata {
  mediaType: string;
  sizeBytes: number;
  kind: "uploaded_blob" | "normalized_bundle" | "source_tree_manifest" | "evidence_artifact";
}

export interface StoredBlob {
  digest: Digest;
  storageKey: string;
  mediaType: string;
  sizeBytes: number;
  created: boolean;
}

export interface ArtifactBlobStore {
  putIfAbsent(digest: Digest, sourcePath: string, metadata: BlobMetadata): Promise<StoredBlob>;
  open(digest: Digest): Promise<Readable>;
  exists(digest: Digest): Promise<boolean>;
}

function assertSha256Digest(digest: Digest): void {
  if (digest.algorithm !== "sha256" || !/^[a-f0-9]{64}$/i.test(digest.value)) {
    throw new Error("Artifact blob store requires a sha256 digest.");
  }
}

export class LocalArtifactBlobStore implements ArtifactBlobStore {
  constructor(private readonly rootDir: string) {}

  private storageKey(digest: Digest): string {
    assertSha256Digest(digest);
    return path.join("sha256", digest.value.slice(0, 2), digest.value);
  }

  private absolutePath(digest: Digest): string {
    return path.join(this.rootDir, this.storageKey(digest));
  }

  private metadataPath(digest: Digest): string {
    return `${this.absolutePath(digest)}.json`;
  }

  async putIfAbsent(digest: Digest, sourcePath: string, metadata: BlobMetadata): Promise<StoredBlob> {
    assertSha256Digest(digest);
    const actual = await sha256Blob(sourcePath);
    if (actual.value !== digest.value) {
      throw new Error("Source object digest does not match expected digest.");
    }
    if (actual.size !== metadata.sizeBytes) {
      throw new Error("Source object size does not match metadata.");
    }

    const targetPath = this.absolutePath(digest);
    const storageKey = this.storageKey(digest);
    await mkdir(path.dirname(targetPath), { recursive: true });

    let created = false;
    try {
      await copyFile(sourcePath, targetPath, 1);
      await writeFile(this.metadataPath(digest), `${JSON.stringify(metadata, null, 2)}\n`, {
        encoding: "utf8",
        flag: "wx"
      });
      created = true;
    } catch (error) {
      const maybeError = error as NodeJS.ErrnoException;
      if (maybeError.code !== "EEXIST") {
        throw error;
      }
    }

    return {
      digest,
      storageKey,
      mediaType: metadata.mediaType,
      sizeBytes: metadata.sizeBytes,
      created
    };
  }

  async open(digest: Digest): Promise<Readable> {
    assertSha256Digest(digest);
    if (!(await this.exists(digest))) {
      throw new Error("Artifact blob does not exist.");
    }
    return createReadStream(this.absolutePath(digest));
  }

  async exists(digest: Digest): Promise<boolean> {
    assertSha256Digest(digest);
    try {
      const entry = await stat(this.absolutePath(digest));
      return entry.isFile();
    } catch (error) {
      const maybeError = error as NodeJS.ErrnoException;
      if (maybeError.code === "ENOENT") {
        return false;
      }
      throw error;
    }
  }
}
