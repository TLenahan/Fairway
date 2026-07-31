import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname, join, normalize, sep } from 'node:path';

import { CaptureRequest } from '@golf/types';

/**
 * Where clip bytes live. The database holds a path RELATIVE to this root so a
 * data-dir move (FAIRWAY_DATA_DIR) does not orphan every row; only this module
 * ever turns one back into an absolute path.
 *
 * Files are named after the capture request, not the clip row: the request id
 * exists before the bytes do, it is already unique and single-use, and naming
 * the file after it keeps a stray file on disk traceable to the ask that
 * produced it.
 */
export interface ClipStore {
  /** Bytes → disk. Returns the relative path to persist on the clip row. */
  write(request: CaptureRequest, bytes: Buffer): Promise<string>;
  /** Relative path → absolute, refusing anything that escapes the root. */
  resolve(relativePath: string): string;
}

/** A clip path that tried to leave the clips directory. */
export class ClipPathError extends Error {
  constructor(relativePath: string) {
    super(`Clip path escapes the clips directory: ${relativePath}`);
    this.name = 'ClipPathError';
  }
}

export function createClipStore(clipsDir: string): ClipStore {
  const resolve = (relativePath: string): string => {
    const absolute = normalize(join(clipsDir, relativePath));
    // The paths this store writes are always safe. This guards the read side,
    // where the id comes off the wire: a row is only as trustworthy as
    // whatever wrote it, and serving arbitrary files off the hub's disk is
    // not a failure worth risking on that.
    if (absolute !== clipsDir && !absolute.startsWith(clipsDir + sep)) {
      throw new ClipPathError(relativePath);
    }
    return absolute;
  };

  return {
    resolve,

    async write(request, bytes) {
      const relativePath = `${request.sessionId}/${request.id}.mp4`;
      const absolute = resolve(relativePath);
      await mkdir(dirname(absolute), { recursive: true });
      // Write-then-rename: a clip row points at a complete file or the row
      // does not exist. A half-written mp4 that the DB swears is 9 seconds of
      // swing would fail in the pose worker, a phase away from the cause.
      const partial = `${absolute}.part`;
      await writeFile(partial, bytes);
      await rename(partial, absolute);
      return relativePath;
    },
  };
}
