import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  buildSourceTreeManifest,
  normalizeSourceTreeRelativePath,
  sha256Blob,
  type Digest,
  type SourceTreeLimits,
  type SourceTreeManifest,
  type SourceTreeManifestFile
} from "./artifacts.js";

const tarBlockSize = 512;

export interface NormalizedBundleResult {
  manifest: SourceTreeManifest;
  normalizedBundleDigest: Digest;
}

function writeOctal(buffer: Buffer, offset: number, length: number, value: number): void {
  const text = value.toString(8).padStart(length - 1, "0").slice(0, length - 1);
  buffer.write(text, offset, length - 1, "ascii");
  buffer[offset + length - 1] = 0;
}

function splitTarPath(relativePath: string): { name: string; prefix: string } {
  const bytes = Buffer.byteLength(relativePath);
  if (bytes <= 100) {
    return { name: relativePath, prefix: "" };
  }

  const segments = relativePath.split("/");
  for (let index = 1; index < segments.length; index += 1) {
    const prefix = segments.slice(0, index).join("/");
    const name = segments.slice(index).join("/");
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(name) <= 100) {
      return { name, prefix };
    }
  }

  throw new Error(`Source tree path is too long for normalized tar bundle: ${relativePath}`);
}

function tarHeader(file: SourceTreeManifestFile): Buffer {
  const header = Buffer.alloc(tarBlockSize, 0);
  const { name, prefix } = splitTarPath(file.path);
  const mode = file.executable ? 0o755 : 0o644;

  header.write(name, 0, 100, "utf8");
  writeOctal(header, 100, 8, mode);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, file.size);
  writeOctal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  header[156] = "0".charCodeAt(0);
  header.write("ustar", 257, 5, "ascii");
  header[262] = 0;
  header.write("00", 263, 2, "ascii");
  header.write("root", 265, 32, "ascii");
  header.write("root", 297, 32, "ascii");
  if (prefix) {
    header.write(prefix, 345, 155, "utf8");
  }

  let checksum = 0;
  for (const byte of header) {
    checksum += byte;
  }
  const checksumText = checksum.toString(8).padStart(6, "0").slice(0, 6);
  header.write(checksumText, 148, 6, "ascii");
  header[154] = 0;
  header[155] = 0x20;

  return header;
}

function paddingLength(size: number): number {
  const remainder = size % tarBlockSize;
  return remainder === 0 ? 0 : tarBlockSize - remainder;
}

function parseOctal(value: Buffer): number {
  const text = value.toString("ascii").replace(/\0.*$/, "").trim();
  return text ? Number.parseInt(text, 8) : 0;
}

function readTarPath(header: Buffer): string {
  const name = header.subarray(0, 100).toString("utf8").replace(/\0.*$/, "");
  const prefix = header.subarray(345, 500).toString("utf8").replace(/\0.*$/, "");
  return prefix ? `${prefix}/${name}` : name;
}

function isZeroBlock(block: Buffer): boolean {
  return block.every((byte) => byte === 0);
}

export async function createNormalizedSourceTreeBundle(input: {
  sourceTreeRoot: string;
  bundlePath: string;
  limits?: Partial<SourceTreeLimits>;
}): Promise<NormalizedBundleResult> {
  const sourceTree = await buildSourceTreeManifest(input.sourceTreeRoot, input.limits);
  const chunks: Buffer[] = [];

  for (const file of sourceTree.manifest.files) {
    const safePath = normalizeSourceTreeRelativePath(file.path, input.limits);
    const content = await readFile(path.join(input.sourceTreeRoot, ...safePath.split("/")));
    chunks.push(tarHeader(file), content);

    const padding = paddingLength(content.length);
    if (padding > 0) {
      chunks.push(Buffer.alloc(padding, 0));
    }
  }

  chunks.push(Buffer.alloc(tarBlockSize, 0), Buffer.alloc(tarBlockSize, 0));
  await mkdir(path.dirname(input.bundlePath), { recursive: true });
  await writeFile(input.bundlePath, Buffer.concat(chunks));

  const digest = await sha256Blob(input.bundlePath);
  return {
    manifest: sourceTree.manifest,
    normalizedBundleDigest: {
      algorithm: digest.algorithm,
      value: digest.value
    }
  };
}

export async function materializeNormalizedSourceTreeBundle(input: {
  bundlePath: string;
  targetDir: string;
  limits?: Partial<SourceTreeLimits>;
}): Promise<void> {
  const archive = await readFile(input.bundlePath);
  const seen = new Set<string>();
  let offset = 0;

  await mkdir(input.targetDir, { recursive: true });

  while (offset + tarBlockSize <= archive.length) {
    const header = archive.subarray(offset, offset + tarBlockSize);
    offset += tarBlockSize;

    if (isZeroBlock(header)) {
      break;
    }

    const type = String.fromCharCode(header[156] || 0);
    if (type !== "0" && type !== "\0") {
      throw new Error(`Unsupported normalized bundle entry type: ${type}`);
    }

    const relativePath = normalizeSourceTreeRelativePath(readTarPath(header), input.limits);
    if (seen.has(relativePath)) {
      throw new Error(`Duplicate normalized bundle entry: ${relativePath}`);
    }
    seen.add(relativePath);

    const size = parseOctal(header.subarray(124, 136));
    const mode = parseOctal(header.subarray(100, 108));
    const content = archive.subarray(offset, offset + size);
    if (content.length !== size) {
      throw new Error(`Truncated normalized bundle entry: ${relativePath}`);
    }

    const targetPath = path.join(input.targetDir, ...relativePath.split("/"));
    await mkdir(path.dirname(targetPath), { recursive: true });
    await writeFile(targetPath, content);
    await chmod(targetPath, mode & 0o111 ? 0o755 : 0o644);
    offset += size + paddingLength(size);
  }
}
