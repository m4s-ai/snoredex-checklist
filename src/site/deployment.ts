type RecordValue = Record<string, unknown>;

export type PagesSmokeExpectations = Readonly<{
  appRevision?: string;
  producerRevision?: string;
  contractVersion?: string;
  catalogueFingerprint?: string;
  catalogueByteSha256?: string;
  catalogueByteLength?: number;
}>;

function isRecord(value: unknown): value is RecordValue {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isCommit(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{40}$/u.test(value);
}

function isDigest(value: unknown): value is string {
  return typeof value === 'string' && /^sha256:[0-9a-f]{64}$/u.test(value);
}

export function validatePagesDeployment(
  deployment: unknown,
  provenance: unknown,
  pageUrl: string,
  expected: PagesSmokeExpectations,
): boolean {
  const deploymentRecord = isRecord(deployment) ? deployment : {};
  const provenanceRecord = isRecord(provenance) ? provenance : {};
  const catalogue = isRecord(provenanceRecord.catalogue) ? provenanceRecord.catalogue : {};
  const expectedLength = expected.catalogueByteLength;

  if (
    !isCommit(expected.appRevision) ||
    !isCommit(expected.producerRevision) ||
    expected.contractVersion !== '1.0.0' ||
    !isDigest(expected.catalogueFingerprint) ||
    !isDigest(expected.catalogueByteSha256) ||
    typeof expectedLength !== 'number' ||
    !Number.isSafeInteger(expectedLength) ||
    expectedLength <= 0
  ) {
    return false;
  }

  return (
    deploymentRecord.schema === 'snoredex-checklist-deployment' &&
    deploymentRecord.schemaVersion === '1.0.0' &&
    deploymentRecord.pageUrl === pageUrl &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(
      typeof deploymentRecord.publishedAt === 'string' ? deploymentRecord.publishedAt : '',
    ) &&
    provenanceRecord.schema === 'snoredex-site-provenance' &&
    provenanceRecord.schemaVersion === '1.0.0' &&
    catalogue.mode === 'pinned-snapshot' &&
    deploymentRecord.appRevision === expected.appRevision &&
    deploymentRecord.appRevision === provenanceRecord.appRevision &&
    deploymentRecord.producerRevision === expected.producerRevision &&
    deploymentRecord.producerRevision === catalogue.sourceCommit &&
    deploymentRecord.contractVersion === expected.contractVersion &&
    deploymentRecord.contractVersion === catalogue.contractVersion &&
    deploymentRecord.catalogueFingerprint === expected.catalogueFingerprint &&
    deploymentRecord.catalogueFingerprint === catalogue.catalogueFingerprint &&
    deploymentRecord.catalogueByteSha256 === expected.catalogueByteSha256 &&
    deploymentRecord.catalogueByteSha256 === catalogue.catalogueByteSha256 &&
    deploymentRecord.catalogueByteLength === expectedLength &&
    deploymentRecord.catalogueByteLength === catalogue.catalogueByteLength
  );
}
