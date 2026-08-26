import { rename as defaultRename, rm as defaultRemove } from "node:fs/promises";

type RenamePath = (source: string, destination: string) => Promise<void>;
type RemovePath = (path: string, options: { recursive: boolean; force: boolean }) => Promise<void>;

export interface ReplaceOutputOptions {
  output: string;
  previous: string;
  staging: string;
  renamePath?: RenamePath;
  removePath?: RemovePath;
}

function errorCode(value: unknown): unknown {
  return value && typeof value === "object" && "code" in value ? value.code : undefined;
}

function describe(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}

/** Replace the published output while retaining a recoverable previous copy on failure. */
export async function replaceOutput({
  output,
  previous,
  staging,
  renamePath = defaultRename,
  removePath = defaultRemove,
}: ReplaceOutputOptions): Promise<void> {
  let hadPrevious = false;
  try {
    await renamePath(output, previous);
    hadPrevious = true;
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
  }

  try {
    await renamePath(staging, output);
  } catch (error) {
    if (hadPrevious) {
      try {
        await renamePath(previous, output);
      } catch (restoreError) {
        throw new AggregateError(
          [error, restoreError],
          `site output replacement failed (${describe(error)}); restoring the previous output also failed (${describe(restoreError)}). ` +
          `The last-known-good output is preserved at ${previous}.`,
        );
      }
    }
    throw error;
  }

  if (hadPrevious) await removePath(previous, { recursive: true, force: true });
}
