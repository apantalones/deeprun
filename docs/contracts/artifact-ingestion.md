# Artifact Ingestion Contract

Artifact ingestion separates the exact bytes received by DeepRun from the normalized source tree that governance evaluates.

## Ingested Artifact

```ts
interface IngestedArtifact {
  artifactId: string;
  mediaType: string;
  size: number;
  blobDigest: {
    algorithm: "sha256";
    value: string;
  };
  sourceTreeDigest: {
    algorithm: "sha256";
    value: string;
  };
  manifestHash: string;
  normalizedBundleDigest?: {
    algorithm: "sha256";
    value: string;
  };
}
```

`blobDigest` identifies the exact uploaded bytes. `sourceTreeDigest` identifies the deterministic source content extracted from those bytes. Source-code governance should use `sourceTreeDigest` as the primary subject identity and retain `blobDigest` as an artifact reference.

This means two differently packaged archives can govern the same source subject:

```text
project-a.zip -> blob hash A \
                             -> source-tree hash X
project-b.zip -> blob hash B /
```

`artifactId` is an organization-scoped authorization and lifecycle handle. It is not the artifact identity. Access control must pass through the owning organization and artifact handle; possession of a digest alone must not authorize access.

## Source Tree Manifest

`sourceTreeDigest` is the SHA-256 hash of the canonical source tree manifest.

```ts
interface SourceTreeManifest {
  schemaVersion: 1;
  files: Array<{
    path: string;
    size: number;
    sha256: string;
    executable: boolean;
  }>;
}
```

## Canonicalization Rules

The v1 source tree manifest uses:

- POSIX-style relative paths
- files sorted by normalized path
- no absolute paths
- no `..` traversal
- no duplicate normalized paths
- no case-colliding paths
- no symlinks
- no device, socket, or other special entries
- file-byte hashes without line-ending normalization
- no archive timestamp, compression, comment, or ownership metadata
- Unicode paths normalized to NFC
- no Windows drive-qualified paths
- no UNC paths
- no Windows reserved names such as `CON`, `NUL`, or `COM1`
- no alternate data stream syntax using `:`
- no trailing spaces or periods in path segments

## Initial Security Limits

The implementation defines default source tree limits for:

- maximum file count
- maximum total bytes
- maximum individual file bytes
- maximum relative path length

Hosted upload extraction must also enforce compressed-size, compression-ratio, extraction-timeout, and content-type checks before it is exposed as `/v1/artifacts`.

## Normalized Bundle

Validators should not repeatedly extract the original uploaded archive. Safe ingestion produces a canonical tree and a normalized bundle. Validation materializes from the normalized bundle, then recomputes the source tree digest before executing validators.

The current local normalized bundle uses deterministic USTAR output:

- sorted file entries
- fixed timestamps
- fixed uid/gid
- fixed owner/group names
- POSIX relative paths
- explicit executable bit
- file entries only
- two zero trailer blocks

The normalized bundle digest is persisted separately from both the original blob digest and the source tree digest.

## Logical Persistence Model

```text
artifact_blobs
  blob_digest PK
  storage_key
  media_type
  size_bytes
  created_at

source_trees
  source_tree_digest PK
  manifest_schema_version
  manifest_json
  manifest_hash
  normalized_bundle_digest
  file_count
  total_bytes
  created_at

artifacts
  artifact_id PK
  organization_id
  blob_digest FK
  source_tree_digest FK
  original_filename
  created_by
  created_at
```

Local filesystem blob storage is implemented behind an `ArtifactBlobStore` interface. Hosted storage providers should preserve the same put-if-absent semantics.
