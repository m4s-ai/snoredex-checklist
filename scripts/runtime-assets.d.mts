export interface RuntimeTuple {
  readonly appRevision: string;
  readonly producerRevision: string;
  readonly contractVersion: '1.0.0';
  readonly catalogueFingerprint: string;
  readonly catalogueByteSha256: string;
  readonly catalogueByteLength: number;
  readonly migrationByteSha256: string;
  readonly migrationByteLength: number;
}

export interface RuntimeAssetSetPointer {
  readonly appRevision: string;
  readonly path: string;
  readonly manifestSha256: string;
  readonly manifestByteLength: number;
}

export function sha256(bytes: Uint8Array): string;
export function runtimeTupleFromProvenance(provenance: unknown): RuntimeTuple;
export function validateRuntimeTuple(value: unknown, expected?: RuntimeTuple): value is RuntimeTuple;
export function validateRuntimeAssetSetPointer(
  value: unknown,
  expectedAppRevision?: string,
): value is RuntimeAssetSetPointer;
export function validateRuntimeAssetSetManifest(value: unknown, expectedTuple?: RuntimeTuple): boolean;
export function writeRuntimeAssetSet(options: {
  assetsRoot: string;
  sourceRoot?: string;
  modulePaths: readonly string[];
  runtime: RuntimeTuple;
}): Promise<RuntimeAssetSetPointer>;
export function validateRuntimeAssetSetDirectory(
  assetsRoot: string,
  pointer: RuntimeAssetSetPointer,
  expectedTuple?: RuntimeTuple,
): Promise<boolean>;
