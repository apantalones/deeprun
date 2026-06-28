import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readdir, readFile } from "node:fs/promises";
import path from "node:path";

export const SOURCE_TREE_MANIFEST_SCHEMA_VERSION = 1 as const;

export interface Digest {
  algorithm: "sha256";
  value: string;
}

export interface SourceTreeManifestFile {
  path: string;
  size: number;
  sha256: string;
  executable: boolean;
}

export interface SourceTreeManifest {
  schemaVersion: typeof SOURCE_TREE_MANIFEST_SCHEMA_VERSION;
  files: SourceTreeManifestFile[];
}

export interface SourceTreeLimits {
  maxFiles: number;
  maxTotalBytes: number;
  maxFileBytes: number;
  maxPathLength: number;
}

export interface SourceTreeDigestResult {
  manifest: SourceTreeManifest;
  sourceTreeDigest: Digest;
  manifestHash: string;
}

export interface IngestedArtifact {
  artifactId: string;
  mediaType: string;
  size: number;
  blobDigest: Digest;
  sourceTreeDigest: Digest;
  manifestHash: string;
  normalizedBundleDigest?: Digest;
}

export const defaultSourceTreeLimits: SourceTreeLimits = {
  maxFiles: 10_000,
  maxTotalBytes: 250 * 1024 * 1024,
  maxFileBytes: 20 * 1024 * 1024,
  maxPathLength: 240
};

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  }

  const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) =>
    left.localeCompare(right)
  );
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
}

const windowsReservedNames = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

export function normalizeSourceTreeRelativePath(inputPath: string, limits: Partial<SourceTreeLimits> = {}): string {
  const resolvedLimits = {
    ...defaultSourceTreeLimits,
    ...limits
  };
  const raw = inputPath.normalize("NFC").replaceAll("\\", "/");

  if (!raw || raw === "." || raw.length > resolvedLimits.maxPathLength) {
    throw new Error(`Unsafe source tree path length: ${raw || "<empty>"}`);
  }

  if (
    raw.startsWith("/") ||
    raw.startsWith("//") ||
    /^[A-Za-z]:/.test(raw) ||
    raw.includes("\0")
  ) {
    throw new Error(`Unsafe source tree path: ${raw}`);
  }

  const segments = raw.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    throw new Error(`Unsafe source tree path segments: ${raw}`);
  }

  for (const segment of segments) {
    if (
      segment.endsWith(" ") ||
      segment.endsWith(".") ||
      segment.includes(":") ||
      windowsReservedNames.test(segment)
    ) {
      throw new Error(`Unsafe source tree path segment: ${raw}`);
    }
  }

  return segments.join("/");
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  const stream = createReadStream(filePath);

  await new Promise<void>((resolve, reject) => {
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolve);
  });

  return hash.digest("hex");
}

async function walkSourceTree(input: {
  root: string;
  current: string;
  limits: SourceTreeLimits;
  files: SourceTreeManifestFile[];
  totals: { bytes: number };
}): Promise<void> {
  const entries = await readdir(input.current, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));

  for (const entry of entries) {
    const absolutePath = path.join(input.current, entry.name);
    const relativePath = normalizeSourceTreeRelativePath(path.relative(input.root, absolutePath), input.limits);

    const stat = await lstat(absolutePath);

    if (stat.isSymbolicLink()) {
      throw new Error(`Symlinks are not supported in source tree manifests: ${relativePath}`);
    }

    if (stat.isDirectory()) {
      await walkSourceTree({
        ...input,
        current: absolutePath
      });
      continue;
    }

    if (!stat.isFile()) {
      throw new Error(`Unsupported source tree entry type: ${relativePath}`);
    }

    if (stat.size > input.limits.maxFileBytes) {
      throw new Error(`Source tree file exceeds maximum size: ${relativePath}`);
    }

    input.totals.bytes += stat.size;
    if (input.totals.bytes > input.limits.maxTotalBytes) {
      throw new Error("Source tree exceeds maximum total size.");
    }

    input.files.push({
      path: relativePath,
      size: stat.size,
      sha256: await sha256File(absolutePath),
      executable: (stat.mode & 0o111) !== 0
    });

    if (input.files.length > input.limits.maxFiles) {
      throw new Error("Source tree exceeds maximum file count.");
    }
  }
}

function assertNoDuplicateOrCaseCollidingPaths(files: SourceTreeManifestFile[]): void {
  const exact = new Set<string>();
  const folded = new Map<string, string>();

  for (const file of files) {
    if (exact.has(file.path)) {
      throw new Error(`Duplicate source tree path: ${file.path}`);
    }
    exact.add(file.path);

    const lower = file.path.toLowerCase();
    const existing = folded.get(lower);
    if (existing && existing !== file.path) {
      throw new Error(`Case-colliding source tree paths: ${existing}, ${file.path}`);
    }
    folded.set(lower, file.path);
  }
}

export function hashSourceTreeManifest(manifest: SourceTreeManifest): string {
  return createHash("sha256").update(canonicalJson(manifest)).digest("hex");
}

export async function buildSourceTreeManifest(
  rootDir: string,
  limits: Partial<SourceTreeLimits> = {}
): Promise<SourceTreeDigestResult> {
  const root = path.resolve(rootDir);
  const resolvedLimits = {
    ...defaultSourceTreeLimits,
    ...limits
  };
  const rootStat = await lstat(root);

  if (!rootStat.isDirectory()) {
    throw new Error("Source tree root must be a directory.");
  }

  const files: SourceTreeManifestFile[] = [];
  await walkSourceTree({
    root,
    current: root,
    limits: resolvedLimits,
    files,
    totals: { bytes: 0 }
  });

  files.sort((left, right) => left.path.localeCompare(right.path));
  assertNoDuplicateOrCaseCollidingPaths(files);

  const manifest: SourceTreeManifest = {
    schemaVersion: SOURCE_TREE_MANIFEST_SCHEMA_VERSION,
    files
  };
  const manifestHash = hashSourceTreeManifest(manifest);

  return {
    manifest,
    sourceTreeDigest: {
      algorithm: "sha256",
      value: manifestHash
    },
    manifestHash
  };
}

export async function sha256Blob(filePath: string): Promise<Digest & { size: number }> {
  const hash = createHash("sha256");
  const stream = createReadStream(filePath);
  let size = 0;

  await new Promise<void>((resolve, reject) => {
    stream.on("data", (chunk) => {
      size += chunk.length;
      hash.update(chunk);
    });
    stream.on("error", reject);
    stream.on("end", resolve);
  });

  return {
    algorithm: "sha256",
    value: hash.digest("hex"),
    size
  };
}

export async function buildArtifactFromMaterializedTree(input: {
  artifactId: string;
  blobPath: string;
  sourceTreeRoot: string;
  mediaType: string;
  limits?: Partial<SourceTreeLimits>;
}): Promise<IngestedArtifact> {
  const [blob, sourceTree] = await Promise.all([
    sha256Blob(input.blobPath),
    buildSourceTreeManifest(input.sourceTreeRoot, input.limits)
  ]);

  return {
    artifactId: input.artifactId,
    mediaType: input.mediaType,
    size: blob.size,
    blobDigest: {
      algorithm: blob.algorithm,
      value: blob.value
    },
    sourceTreeDigest: sourceTree.sourceTreeDigest,
    manifestHash: sourceTree.manifestHash
  };
}

export async function readSourceTreeManifest(manifestPath: string): Promise<SourceTreeManifest> {
  const parsed = JSON.parse(await readFile(manifestPath, "utf8")) as SourceTreeManifest;
  if (parsed.schemaVersion !== SOURCE_TREE_MANIFEST_SCHEMA_VERSION || !Array.isArray(parsed.files)) {
    throw new Error("Invalid source tree manifest.");
  }
  return parsed;
}
