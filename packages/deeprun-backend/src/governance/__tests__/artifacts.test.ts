import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { LocalArtifactBlobStore } from "../artifact-storage.js";
import {
  buildArtifactFromMaterializedTree,
  buildSourceTreeManifest,
  hashSourceTreeManifest,
  normalizeSourceTreeRelativePath,
  sha256Blob
} from "../artifacts.js";
import {
  createNormalizedSourceTreeBundle,
  materializeNormalizedSourceTreeBundle
} from "../normalized-bundle.js";

async function writeProject(root: string): Promise<void> {
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeFile(path.join(root, "package.json"), "{\"name\":\"demo\"}\n", "utf8");
  await writeFile(path.join(root, "src", "server.ts"), "export const ok = true;\n", "utf8");
}

test("source tree digest is stable across materialized copies", async () => {
  const tmpRoot = await mkdtemp(path.join(os.tmpdir(), "deeprun-artifacts-"));

  try {
    const left = path.join(tmpRoot, "left");
    const right = path.join(tmpRoot, "right");
    await mkdir(left, { recursive: true });
    await mkdir(right, { recursive: true });
    await writeProject(left);
    await writeProject(right);

    const leftDigest = await buildSourceTreeManifest(left);
    const rightDigest = await buildSourceTreeManifest(right);

    assert.equal(leftDigest.sourceTreeDigest.value, rightDigest.sourceTreeDigest.value);
    assert.deepEqual(
      leftDigest.manifest.files.map((file) => file.path),
      ["package.json", "src/server.ts"]
    );
  } finally {
    await rm(tmpRoot, { recursive: true, force: true });
  }
});

test("artifact identity separates blob digest from source tree digest", async () => {
  const tmpRoot = await mkdtemp(path.join(os.tmpdir(), "deeprun-artifact-identity-"));

  try {
    const tree = path.join(tmpRoot, "tree");
    await mkdir(tree, { recursive: true });
    await writeProject(tree);

    const blobA = path.join(tmpRoot, "archive-a.zip");
    const blobB = path.join(tmpRoot, "archive-b.zip");
    await writeFile(blobA, "wrapper-a", "utf8");
    await writeFile(blobB, "wrapper-b", "utf8");

    const artifactA = await buildArtifactFromMaterializedTree({
      artifactId: "art_a",
      blobPath: blobA,
      sourceTreeRoot: tree,
      mediaType: "application/zip"
    });
    const artifactB = await buildArtifactFromMaterializedTree({
      artifactId: "art_b",
      blobPath: blobB,
      sourceTreeRoot: tree,
      mediaType: "application/zip"
    });

    assert.notEqual(artifactA.blobDigest.value, artifactB.blobDigest.value);
    assert.equal(artifactA.sourceTreeDigest.value, artifactB.sourceTreeDigest.value);
    assert.equal(artifactA.manifestHash, artifactA.sourceTreeDigest.value);
  } finally {
    await rm(tmpRoot, { recursive: true, force: true });
  }
});

test("source tree manifest rejects oversized files", async () => {
  const tmpRoot = await mkdtemp(path.join(os.tmpdir(), "deeprun-artifacts-limits-"));

  try {
    await writeFile(path.join(tmpRoot, "large.txt"), "too large", "utf8");

    await assert.rejects(
      () => buildSourceTreeManifest(tmpRoot, { maxFileBytes: 4 }),
      /exceeds maximum size/
    );
  } finally {
    await rm(tmpRoot, { recursive: true, force: true });
  }
});

test("source tree manifest hash changes when file content changes", () => {
  const base = {
    schemaVersion: 1 as const,
    files: [
      {
        path: "src/server.ts",
        size: 1,
        sha256: "a",
        executable: false
      }
    ]
  };

  assert.notEqual(
    hashSourceTreeManifest(base),
    hashSourceTreeManifest({
      ...base,
      files: [
        {
          ...base.files[0],
          sha256: "b"
        }
      ]
    })
  );
});

test("source tree path normalization rejects cross-platform unsafe paths", () => {
  for (const unsafe of [
    "/absolute/path",
    "C:\\temp\\file.txt",
    "\\\\server\\share\\file.txt",
    "../escape.txt",
    "src/../escape.txt",
    "src//empty.txt",
    "src/./dot.txt",
    "src/NUL.txt",
    "src/COM1",
    "src/name:stream",
    "src/trailing-space ",
    "src/trailing-dot."
  ]) {
    assert.throws(() => normalizeSourceTreeRelativePath(unsafe), /Unsafe source tree path/);
  }

  assert.equal(normalizeSourceTreeRelativePath("src\\server.ts"), "src/server.ts");
  assert.equal(normalizeSourceTreeRelativePath("cafe\u0301.txt"), "café.txt");
});

test("normalized bundle materializes to the same source tree digest", async () => {
  const tmpRoot = await mkdtemp(path.join(os.tmpdir(), "deeprun-normalized-bundle-"));

  try {
    const source = path.join(tmpRoot, "source");
    const target = path.join(tmpRoot, "target");
    const bundlePath = path.join(tmpRoot, "bundle.tar");
    await mkdir(source, { recursive: true });
    await writeProject(source);

    const bundle = await createNormalizedSourceTreeBundle({
      sourceTreeRoot: source,
      bundlePath
    });
    await materializeNormalizedSourceTreeBundle({
      bundlePath,
      targetDir: target
    });

    const rematerialized = await buildSourceTreeManifest(target);

    assert.equal(bundle.normalizedBundleDigest.algorithm, "sha256");
    assert.equal(
      hashSourceTreeManifest(bundle.manifest),
      rematerialized.sourceTreeDigest.value
    );
  } finally {
    await rm(tmpRoot, { recursive: true, force: true });
  }
});

test("local artifact blob store persists objects with put-if-absent semantics", async () => {
  const tmpRoot = await mkdtemp(path.join(os.tmpdir(), "deeprun-artifact-store-"));

  try {
    const store = new LocalArtifactBlobStore(path.join(tmpRoot, "objects"));
    const blobPath = path.join(tmpRoot, "blob.bin");
    await writeFile(blobPath, "immutable object", "utf8");
    const digest = await sha256Blob(blobPath);
    const metadata = {
      mediaType: "application/octet-stream",
      sizeBytes: digest.size,
      kind: "uploaded_blob" as const
    };

    const first = await store.putIfAbsent(digest, blobPath, metadata);
    const second = await store.putIfAbsent(digest, blobPath, metadata);

    assert.equal(first.created, true);
    assert.equal(second.created, false);
    assert.equal(await store.exists(digest), true);
  } finally {
    await rm(tmpRoot, { recursive: true, force: true });
  }
});
