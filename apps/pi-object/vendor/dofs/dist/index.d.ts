import { n as SQLCursorLike, r as SQLStorageLike, t as DurableObjectStorageLike } from "./types-DxpMkQ_t.js";
import { a as Database, i as pinObjects, n as RecordingStorage, t as ExecutedStatement } from "./testing-recording-BreO6Dnq.js";
import { EventEmitter } from "node:events";
type WorkspaceErrorCode = "ENOENT" | "ENOTEMPTY" | "ENOTDIR" | "EISDIR" | "EEXIST" | "EINVAL" | "EACCES" | "EPERM" | "EROFS" | "ENOSYS" | "EBADF" | "ELOOP" | "EUNKNOWN_HASH" | "EIO";
interface WorkspaceFsError extends Error {
  code: WorkspaceErrorCode;
  path?: string;
}
export declare function createWorkspaceError(code: WorkspaceErrorCode, message: string, path?: string): WorkspaceFsError;
export declare function chmod(db: Database, path: string, mode: number, now: () => number): void;
interface WorkspaceFoundEntry {
  path: string;
  type: "file" | "dir";
}
interface FindOptions {
  /** Maximum matching entries to return. */
  limit?: number;
  /** Matching entries to skip in traversal order. */
  offset?: number;
  /**
   * Glob patterns whose matches are left out of the result. Matched
   * against the same directory-relative path as the inclusion glob and
   * applied first, so an exclusion always wins. An excluded directory
   * is pruned: neither it nor anything below it is visited.
   */
  exclude?: string[];
}
interface WorkspaceGrepContextLine {
  line: number;
  text: string;
  isMatch: boolean;
}
interface WorkspaceGrepMatch {
  path: string;
  line: number;
  text: string;
  context?: WorkspaceGrepContextLine[];
}
interface GrepOptions {
  /** Ignore letter case. Defaults to false. */
  ignoreCase?: boolean;
  /** Interpret the pattern as a regular expression. Defaults to false. */
  regex?: boolean;
  /** Lines of context to include before and after each match. */
  context?: number;
  /** Maximum matches to return. */
  limit?: number;
  /** Matching lines to skip before collecting results. */
  offset?: number;
  /** Glob relative to a searched directory that limits files. */
  include?: string;
  /**
   * Glob patterns whose matches are not searched. Matched against the
   * same directory-relative path as the inclusion glob and applied
   * first, so an exclusion always wins. An excluded directory is
   * pruned: neither it nor anything below it is read.
   */
  exclude?: string[];
}
interface MkdirOptions {
  recursive?: boolean;
  mode?: number;
}
interface WorkspaceDirentResult {
  name: string;
  parentPath: string;
  size: number;
  mtime: number;
  isFile: boolean;
  isDirectory: boolean;
  isSymbolicLink: boolean;
}
/**
 * One directory entry with what an `lstat` of it reports for type,
 * permission bits and inode, read with the listing rather than per entry.
 */
interface WorkspaceDirentEntry {
  name: string;
  type: "file" | "dir" | "symlink";
  /** Permission bits only (`& 0o7777`). */
  mode: number;
  /** 0 for a file still in a pending-create buffer, as `lstat` reports it. */
  inode: number;
}
interface ReaddirOptions {
  /** Maximum entries to return. */
  limit?: number;
  /** Number of entries to skip in name order. */
  offset?: number;
}
interface ReadFileOptions {
  encoding?: "utf8";
  /** First byte to return. Defaults to 0. */
  byteOffset?: number;
  /** Maximum bytes to return. Defaults to the rest of the file. */
  byteLength?: number;
}
interface RmOptions {
  recursive?: boolean;
  force?: boolean;
}
interface WorkspaceStatResult {
  name: string;
  inode: number;
  mode: number;
  mtime: number;
  size: number;
  isFile: boolean;
  isDirectory: boolean;
  isSymbolicLink: boolean;
}
export declare function stat(db: Database, path: string): WorkspaceStatResult;
export declare function lstat(db: Database, path: string): WorkspaceStatResult;
type WriteFileContent = string | Uint8Array | ReadableStream<Uint8Array>;
interface WriteFileOptions {
  mode?: number;
  /** Fail with EEXIST when the target already exists. */
  exclusive?: boolean;
}
interface WriteFileRange {
  start: number;
  end: number;
}
interface WorkspaceFilesystemOptions {
  now?: () => number;
}
export declare class WorkspaceFilesystem {
  readonly db: Database;
  readonly now: () => number;
  constructor(db: Database, options?: WorkspaceFilesystemOptions);
  readFile(path: string): Promise<ReadableStream<Uint8Array>>;
  readFile(path: string, encoding: "utf8"): Promise<string>;
  readFile(path: string, options: ReadFileOptions & {
    encoding?: undefined;
  }): Promise<ReadableStream<Uint8Array>>;
  readFile(path: string, options: ReadFileOptions & {
    encoding: "utf8";
  }): Promise<string>;
  readFile(path: string, options: ReadFileOptions): Promise<string | ReadableStream<Uint8Array>>;
  stat(path: string): Promise<WorkspaceStatResult>;
  lstat(path: string): Promise<WorkspaceStatResult>;
  readlink(path: string): Promise<string>;
  readdir(path: string, options?: ReaddirOptions): Promise<WorkspaceDirentResult[]>;
  find(directory: string, pattern?: string, options?: FindOptions): Promise<WorkspaceFoundEntry[]>;
  ls(prefix: string): Promise<string[]>;
  grep(pattern: string, path: string, options?: GrepOptions): Promise<WorkspaceGrepMatch[]>;
  writeFile(path: string, content: WriteFileContent, options?: WriteFileOptions): Promise<void>;
  mkdir(path: string, options?: MkdirOptions): Promise<void>;
  rm(path: string, options?: RmOptions): Promise<void>;
  rename(oldPath: string, newPath: string): Promise<void>;
  chmod(path: string, mode: number): Promise<void>;
  symlink(target: string, path: string): Promise<void>;
}
export declare function link(db: Database, existingPath: string, newPath: string): void;
export declare function invalidateReadOnlyMountCache(db: Database): void;
export declare function getReadOnlyMountRoots(db: Database): readonly string[];
export declare function assertNotReadOnly(db: Database, path: string): void;
export declare function readOnlyRootFor(db: Database, path: string): string | undefined;
export declare function readlink(db: Database, path: string): string;
export declare function rename(db: Database, oldPath: string, newPath: string): void;
export declare function symlink(db: Database, target: string, path: string, now: () => number): void;
interface WatchOptions {
  recursive?: boolean;
  signal?: AbortSignal;
  interval?: number;
}
interface WatchEvent {
  eventType: "rename" | "change";
  filename: string;
}
interface WatchHandle extends EventEmitter {
  close(): void;
}
interface SQLiteWorkspaceProviderOptions {
  now?: () => number;
  watchIntervalMs?: number;
}
interface VirtualStatsLike {
  dev: number;
  mode: number;
  nlink: number;
  uid: number;
  gid: number;
  rdev: number;
  blksize: number;
  ino: number;
  size: number;
  blocks: number;
  atimeMs: number;
  mtimeMs: number;
  ctimeMs: number;
  birthtimeMs: number;
  atime: Date;
  mtime: Date;
  ctime: Date;
  birthtime: Date;
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
  isBlockDevice(): boolean;
  isCharacterDevice(): boolean;
  isFIFO(): boolean;
  isSocket(): boolean;
}
interface VirtualDirentLike {
  name: string;
  parentPath: string;
  path: string;
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
  isBlockDevice(): boolean;
  isCharacterDevice(): boolean;
  isFIFO(): boolean;
  isSocket(): boolean;
}
export declare class SQLiteWorkspaceProvider {
  #private;
  readonly db: Database;
  readonly now: () => number;
  readonly readonly = false;
  readonly supportsSymlinks = true;
  readonly supportsWatch = true;
  readonly watchIntervalMs: number;
  constructor(db: Database, options?: SQLiteWorkspaceProviderOptions);
  open(path: string, flags?: string, mode?: number): Promise<number>;
  openSync(path: string, flags?: string, _mode?: number): number;
  stat(path: string, options?: {
    bigint?: boolean;
  }): Promise<VirtualStatsLike>;
  statSync(path: string, _options?: {
    bigint?: boolean;
  }): VirtualStatsLike;
  lstat(path: string, options?: {
    bigint?: boolean;
  }): Promise<VirtualStatsLike>;
  lstatSync(path: string, _options?: {
    bigint?: boolean;
  }): VirtualStatsLike;
  readdir(path: string, options?: {
    withFileTypes?: boolean;
  }): Promise<string[] | VirtualDirentLike[]>;
  readdirSync(path: string, options?: {
    withFileTypes?: boolean;
  }): string[] | VirtualDirentLike[];
  /**
   * The directory's entries with the type, permission bits and inode an
   * `lstat` of each reports, from one query. Not part of the
   * `@platformatic/vfs` provider surface.
   */
  readdirEntriesSync(path: string): WorkspaceDirentEntry[];
  mkdir(path: string, options?: MkdirOptions): Promise<string | undefined>;
  mkdirSync(path: string, options?: MkdirOptions): string | undefined;
  rmdir(path: string): Promise<void>;
  rmdirSync(path: string): void;
  unlink(path: string): Promise<void>;
  unlinkSync(path: string): void;
  link(existingPath: string, newPath: string): Promise<void>;
  linkSync(existingPath: string, newPath: string): void;
  rename(oldPath: string, newPath: string): Promise<void>;
  renameSync(oldPath: string, newPath: string): void;
  readFile(path: string, options?: BufferEncoding | {
    encoding?: BufferEncoding | null;
  } | null): Promise<Buffer | string>;
  readFileSync(path: string, options?: BufferEncoding | {
    encoding?: BufferEncoding | null;
  } | null): Buffer | string;
  writeFile(path: string, data: string | Buffer, options?: {
    encoding?: BufferEncoding;
    mode?: number;
  } | BufferEncoding): Promise<void>;
  writeFileSync(path: string, data: string | Buffer, options?: {
    encoding?: BufferEncoding;
    mode?: number;
  } | BufferEncoding): void;
  writeFileRangesSync(path: string, data: string | Buffer, ranges: WriteFileRange[], options?: {
    encoding?: BufferEncoding;
    mode?: number;
  } | BufferEncoding): void;
  createFileSync(path: string, options?: {
    mode?: number;
  }): void;
  writeRangeSync(path: string, data: string | Buffer | Uint8Array, offset: number, options?: {
    encoding?: BufferEncoding;
    mode?: number;
  } | BufferEncoding): number;
  truncateFileSync(path: string, len: number): void;
  openWriteBufferSync(path: string): void;
  openWriteBufferForCreateSync(path: string, options?: {
    mode?: number;
  }): void;
  releaseWriteBufferSync(path: string): void;
  chmodSync(path: string, mode: number): void;
  appendFile(_path: string, _data: string | Buffer, _options?: {
    encoding?: BufferEncoding;
    mode?: number;
  } | BufferEncoding): Promise<void>;
  appendFileSync(_path: string, _data: string | Buffer, _options?: {
    encoding?: BufferEncoding;
    mode?: number;
  } | BufferEncoding): void;
  exists(path: string): Promise<boolean>;
  existsSync(path: string): boolean;
  copyFile(_src: string, _dest: string, _mode?: number): Promise<void>;
  copyFileSync(_src: string, _dest: string, _mode?: number): void;
  internalModuleStat(_path: string): number;
  realpath(path: string, _options?: {
    encoding?: BufferEncoding;
  }): Promise<string>;
  realpathSync(path: string, _options?: {
    encoding?: BufferEncoding;
  }): string;
  access(path: string, _mode?: number): Promise<void>;
  accessSync(path: string, _mode?: number): void;
  closeSync(fd: number): void;
  readSync(fd: number, buffer: Buffer | Uint8Array, offset: number, length: number, position: number | null): number;
  readRangeSync(path: string, offset: number, length: number): Buffer;
  writeSync(fd: number, buffer: Buffer | Uint8Array, offset?: number, length?: number, position?: number | null): number;
  fstatSync(fd: number, _options?: {
    bigint?: boolean;
  }): VirtualStatsLike;
  truncateSync(path: string, len: number): void;
  ftruncateSync(fd: number, len: number): void;
  readlink(path: string, _options?: {
    encoding?: BufferEncoding;
  }): Promise<string>;
  readlinkSync(path: string, _options?: {
    encoding?: BufferEncoding;
  }): string;
  symlink(target: string, path: string, _type?: string): Promise<void>;
  symlinkSync(target: string, path: string, _type?: string): void;
  watch(path: string, options?: WatchOptions): WatchHandle;
  watchAsync(path: string, options?: WatchOptions): AsyncIterable<WatchEvent>;
  watchFile(_path: string, _options?: unknown, _listener?: (curr: VirtualStatsLike, prev: VirtualStatsLike) => void): unknown;
  unwatchFile(_path: string, _listener?: (curr: VirtualStatsLike, prev: VirtualStatsLike) => void): void;
}
export declare const SCHEMA_VERSION = 10;
export declare const ROOT_INODE = 1;
export declare function initializeSchema(db: Database, now: () => number): void;
type ChangeEntry = {
  kind: "file";
  rev: number;
  path: string;
  mode: number;
  mtime: number;
  size: number;
  chunks: {
    hash: Uint8Array;
    size: number;
  }[];
} | {
  kind: "dir";
  rev: number;
  path: string;
  mode: number;
  mtime: number;
} | {
  kind: "symlink";
  rev: number;
  path: string;
  target: string;
  mode: number;
  mtime: number;
} | {
  kind: "delete";
  rev: number;
  path: string;
  prior?: string;
};
export declare function materialiseChange(db: Database, path: string): ChangeEntry | null;
type WatermarkKey = "pushRev";
type ChangeCursor = {
  rev: number;
  path: string | null;
};
export declare function readWatermark(db: Database, key: WatermarkKey, backend?: string): number;
export declare function writeWatermark(db: Database, key: WatermarkKey, value: number, backend?: string): void;
export declare function readFetchCursor(db: Database, backend?: string): ChangeCursor;
export declare function readPushCursor(db: Database, backend?: string): ChangeCursor;
export declare function writePushCursor(db: Database, cursor: ChangeCursor, backend?: string): void;
export declare function writeFetchCursor(db: Database, cursor: ChangeCursor, backend?: string): void;
export declare function compareChangeCursors(a: ChangeCursor, b: ChangeCursor): number;
export declare function currentRev(db: Database): number;
export declare function pushWindowIsEmpty(db: Database, backend?: string): boolean;
interface SkippedEntry {
  path: string;
  mountRoot: string;
  op: "write" | "delete";
  reason: "read-only";
}
interface ApplyResult {
  applied: number;
  skipped: SkippedEntry[];
  minted?: number;
}
interface ApplyOptions {
  maxBytesPerBatch?: number;
  maxPathsPerBatch?: number;
  source?: "local" | "upstream";
  backend?: string;
  receivedCursor?: ChangeCursor;
}
export declare function applyChanges(db: Database, entries: Iterable<ChangeEntry> | AsyncIterable<ChangeEntry>, objects: Map<string, Uint8Array>, options?: ApplyOptions): Promise<ApplyResult>;
export declare function applyChangesSync(db: Database, entries: readonly ChangeEntry[], objects: Map<string, Uint8Array>, options?: ApplyOptions): ApplyResult;
export declare function stageBlob(db: Database, hash: Uint8Array, bytes: Uint8Array): void;
type SyncDirection = "pull" | "push";
type SyncMode = "entries" | "pack";
type SyncOperationStatus = "capturing" | "pending" | "failed" | "lost";
type TerminalStatus = "failed" | "lost";
interface BlockProfile {
  readonly maxEntries: number;
  readonly maxBytes: number;
}
export declare const DEFAULT_BLOCK_PROFILE: BlockProfile;
export declare const MIN_BLOCK_PROFILE: BlockProfile;
interface SyncOperation {
  readonly backend: string;
  readonly direction: SyncDirection;
  readonly generation: string;
  readonly status: SyncOperationStatus;
  readonly target?: ChangeCursor;
  readonly mode?: SyncMode;
  readonly runtimeId?: string;
  readonly blockAfter?: ChangeCursor;
  readonly blockStartedAt?: number;
  readonly profile: BlockProfile;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly lastError?: string;
}
interface SyncSkip {
  readonly generation: string;
  readonly path: string;
  readonly reason: string;
  readonly at: number;
}
export declare function readOperation(db: Database, backend?: string, direction?: SyncDirection): SyncOperation | undefined;
export declare function beginCapture(db: Database, backend?: string, direction?: SyncDirection, now?: number): string;
export declare function fixTarget(db: Database, backend: string, direction: SyncDirection, generation: string, input: {
  target: ChangeCursor;
  mode: SyncMode;
  runtimeId?: string;
}, now?: number): boolean;
interface OpenedOperation {
  readonly operation: SyncOperation;
  readonly joined: boolean;
}
export declare function openOperation(db: Database, backend?: string, direction?: SyncDirection, now?: number): OpenedOperation;
export declare function completeOperation(db: Database, backend: string, direction: SyncDirection, generation: string): boolean;
export declare function failOperation(db: Database, backend: string, direction: SyncDirection, generation: string, status: TerminalStatus, error: string, now?: number): boolean;
export declare function markBlockStarted(db: Database, backend: string, direction: SyncDirection, generation: string, after: ChangeCursor, now?: number): boolean;
export declare function clearBlockMarker(db: Database, backend: string, direction: SyncDirection, generation: string, now?: number): boolean;
export declare function shrinkBlockProfile(db: Database, backend: string, direction: SyncDirection, generation: string, now?: number): BlockProfile | undefined;
export declare function recordSkip(db: Database, backend: string, direction: SyncDirection, generation: string, path: string, reason: string, now?: number): void;
export declare function readSkips(db: Database, backend?: string, direction?: SyncDirection): SyncSkip[];
export declare function pruneSkips(db: Database, backend: string, direction: SyncDirection, generation: string): void;
export declare const PACK_THRESHOLD_ENTRIES = 20000;
export declare const PACK_THRESHOLD_BYTES: number;
interface BlockObject {
  readonly hash: Uint8Array;
  readonly size: number;
}
interface PlannedBlock {
  readonly entries: ChangeEntry[];
  readonly objects: BlockObject[];
  readonly objectBytes: number;
  readonly cursor: ChangeCursor;
  readonly drained: boolean;
}
interface PlanBlockRequest {
  readonly after: ChangeCursor;
  readonly through: ChangeCursor;
  readonly profile: BlockProfile;
  readonly ignore?: string[];
}
export declare function planBlock(db: Database, request: PlanBlockRequest): Promise<PlannedBlock>;
interface SelectModeRequest extends PlanBlockRequest {
  readonly thresholdEntries?: number;
  readonly thresholdBytes?: number;
}
interface ModeDecision {
  readonly mode: SyncMode;
  readonly firstBlock: PlannedBlock;
}
export declare function selectMode(db: Database, request: SelectModeRequest): Promise<ModeDecision>;
export declare const PACK_FORMAT_VERSION = 1;
export declare class PackProtocolError extends Error {
  readonly code = "EPACK_PROTOCOL";
  constructor(message: string);
}
interface PackFooter {
  readonly version: number;
  readonly generation: string;
  readonly after: ChangeCursor;
  readonly blockCursor: ChangeCursor;
  readonly target: ChangeCursor;
  readonly entryCount: number;
  readonly objectCount: number;
  readonly objectBytes: number;
  readonly digest: string;
}
interface EncodeChangePackInput {
  readonly block: PlannedBlock;
  readonly after: ChangeCursor;
  readonly target: ChangeCursor;
  readonly generation: string;
  readonly corruptEntryCount?: number;
}
interface DecodedChangePack {
  readonly footer: PackFooter;
  readonly entries: ChangeEntry[];
  readonly objects: Map<string, Uint8Array>;
}
export declare function encodeChangePack(db: Database, input: EncodeChangePackInput): ReadableStream<Uint8Array>;
interface DecodeChangePackOptions {
  readonly expectVersion?: number;
  readonly expectGeneration?: string;
}
export declare function decodeChangePack(stream: ReadableStream<Uint8Array>, options?: DecodeChangePackOptions): Promise<DecodedChangePack>;
export declare function readPackFooter(stream: ReadableStream<Uint8Array>): Promise<PackFooter>;
interface CoalesceOptions {
  ignore?: string[];
  through?: ChangeCursor;
}
export declare function coalesceChanges(db: Database, after: ChangeCursor | number, options?: CoalesceOptions): AsyncIterable<ChangeEntry>;
export declare function fetchChanges(db: Database, after: ChangeCursor | number, options?: {
  ignore?: string[];
}): AsyncIterable<ChangeEntry>;
export declare function fetchObjects(db: Database, hashes: Uint8Array[]): AsyncIterable<{
  hash: Uint8Array;
  bytes: Uint8Array;
}>;
export declare function hasObjects(db: Database, hashes: Uint8Array[]): Uint8Array[];
export declare const DEFAULT_IGNORE: string[];
export declare function isIgnored(path: string, patterns: string[]): boolean;
export declare function assertAppliedPushCursor(appliedPushCursor: ChangeCursor, pushCursor: ChangeCursor): void;
interface ManifestChunk {
  hash: Uint8Array;
  size: number;
}
export declare const MANIFEST_VERSION = 1;
export declare function buildManifest(db: Database, chunks: ManifestChunk[]): Uint8Array;
export declare function pushObjects(db: Database, hashes: Uint8Array[]): AsyncIterable<{
  hash: Uint8Array;
  bytes: Uint8Array;
}>;
export { type ApplyOptions, type ApplyResult, type BlockObject, type BlockProfile, type ChangeCursor, type ChangeEntry, type CoalesceOptions, Database, type DecodeChangePackOptions, type DecodedChangePack, type DurableObjectStorageLike, type EncodeChangePackInput, type ExecutedStatement, type FindOptions, type GrepOptions, type ManifestChunk, type MkdirOptions, type ModeDecision, type OpenedOperation, type PackFooter, type PlanBlockRequest, type PlannedBlock, type ReadFileOptions, type ReaddirOptions, RecordingStorage, type RmOptions, type SQLCursorLike, type SQLStorageLike, type SQLiteWorkspaceProviderOptions, type SelectModeRequest, type SkippedEntry, type SyncDirection, type SyncMode, type SyncOperation, type SyncOperationStatus, type SyncSkip, type TerminalStatus, type WatermarkKey, type WorkspaceDirentEntry, type WorkspaceDirentResult, type WorkspaceErrorCode, type WorkspaceFilesystemOptions, type WorkspaceFoundEntry, type WorkspaceFsError, type WorkspaceGrepContextLine, type WorkspaceGrepMatch, type WorkspaceStatResult, type WriteFileContent, type WriteFileOptions, pinObjects };
//# sourceMappingURL=index.d.ts.map