export interface PhotoSummary {
  uuid: string;
  filename: string;
  date: string | null;
  title: string | null;
  favorite: boolean;
  hidden: boolean;
  isMissing: boolean;
  isPhoto: boolean;
  isMovie: boolean;
  width: number | null;
  height: number | null;
  albums: string[];
  keywords: string[];
  persons: string[];
}

/**
 * Camera/lens/exposure metadata Photos captured at import (PhotoInfo.exif_info).
 * Every field is nullable — Photos records no EXIF for manufacturer-app
 * uploads, scans, screenshots, etc. duration/fps/codec apply to videos.
 */
export interface ExifData {
  cameraMake: string | null;
  cameraModel: string | null;
  lensModel: string | null;
  iso: number | null;
  aperture: number | null;
  shutterSpeed: number | null;
  focalLength: number | null;
  exposureBias: number | null;
  flashFired: boolean | null;
  duration: number | null;
  fps: number | null;
  codec: string | null;
}

/** One comment on an iCloud shared-album photo. */
export interface SharedComment {
  user: string | null;
  text: string | null;
  date: string | null;
  isMine: boolean;
}

/** One like on an iCloud shared-album photo. */
export interface SharedLike {
  user: string | null;
  date: string | null;
  isMine: boolean;
}

/** A sibling frame of a burst set (get-photo burstPhotos=true). */
export interface BurstSibling {
  uuid: string;
  filename: string;
  date: string | null;
}

export interface PhotoDetail extends PhotoSummary {
  currentFilename: string;
  dateAdded: string | null;
  dateModified: string | null;
  description: string | null;
  isHDR: boolean;
  isLive: boolean;
  isScreenshot: boolean;
  isSelfie: boolean;
  isPanorama: boolean;
  isPortrait: boolean;
  isSlowMo: boolean;
  isTimeLapse: boolean;
  isBurst: boolean;
  isRaw: boolean;
  isEdited: boolean;
  originalWidth: number | null;
  originalHeight: number | null;
  uti: string | null;
  uti_original: string | null;
  originalFilesize: number | null;
  path: string | null;
  pathEdited: string | null;
  pathRaw: string | null;
  pathLivePhoto: string | null;
  labels: string[];
  location: { latitude: number; longitude: number } | null;
  place: { name: string | null; country: string | null } | null;
  /** null when Photos recorded no EXIF for this asset. */
  exif: ExifData | null;
  /** Photos' overall aesthetic score 0..1; null when unavailable. */
  score: number | null;
  /** Text Photos' OCR indexed for this photo; null when search info is unavailable. */
  detectedText: string[] | null;
  /** Shared-album owner name; null for non-shared assets. */
  owner: string | null;
  /** Shared-album comments ([] for non-shared assets). */
  comments: SharedComment[];
  /** Shared-album likes ([] for non-shared assets). */
  likes: SharedLike[];
  /** Present only when get-photo is called with burstPhotos=true. */
  burstPhotos?: BurstSibling[];
}

/** Result of the batch get-photos command. */
export interface PhotoBatchResult {
  /** Number of photos actually found and returned. */
  count: number;
  photos: PhotoDetail[];
  /** Requested UUIDs that matched nothing (neither library nor trash). */
  notFound: string[];
}

/** Result of the get-thumbnail command. */
export interface ThumbnailResult {
  uuid: string;
  /** Source file the bytes came from (a Photos derivative or the original). */
  path: string;
  width: number | null;
  height: number | null;
  mimeType: string;
  byteSize: number;
  /** True when a ready-made Photos derivative was used; false when the image was rendered (downscaled/converted) from the original. */
  isDerivative: boolean;
  base64: string;
}

/** One member of a duplicate group. */
export interface DuplicateMember {
  uuid: string;
  filename: string;
  date: string | null;
  size: number | null;
  width: number | null;
  height: number | null;
  isMovie: boolean;
}

/** One group of exact duplicates (Photos fingerprint match). */
export interface DuplicateGroup {
  uuids: string[];
  count: number;
  photos: DuplicateMember[];
}

/** Result of the find-duplicates command. */
export interface DuplicateGroupsResult {
  /** Total number of duplicate groups in the library (before the limit). */
  groupCount: number;
  /** Number of groups in this response. */
  returned: number;
  groups: DuplicateGroup[];
}

export interface LibraryInfo {
  libraryPath: string;
  dbVersion: string;
  photosVersion: string | number;
  photoCount: number;
  movieCount: number;
  totalCount: number;
  albumCount: number;
  folderCount: number;
  keywordCount: number;
  personCount: number;
}

export interface AlbumInfo {
  uuid: string;
  title: string;
  folder: string[];
  photoCount: number;
  isShared: boolean;
}

export interface FolderInfo {
  uuid: string;
  title: string;
  parent: string | null;
  albumCount: number;
  subfolderCount: number;
}

export interface KeywordCount {
  keyword: string;
  count: number;
}

export interface PersonCount {
  name: string;
  count: number;
}

export interface QueryResult {
  /** Total number of photos matching the query (before the limit is applied). */
  count: number;
  /** Number of photo summaries actually returned (post-limit page size). */
  returned: number;
  photos: PhotoSummary[];
}

export interface ExportResult {
  destination: string;
  exportedCount: number;
  skippedCount: number;
  exported: string[];
  skipped: { uuid: string; error: string }[];
}

export interface QueryFilters {
  uuid?: string[];
  album?: string[];
  keyword?: string[];
  person?: string[];
  fromDate?: string;
  toDate?: string;
  favorite?: boolean;
  notFavorite?: boolean;
  hidden?: boolean;
  notHidden?: boolean;
  photos?: boolean;
  movies?: boolean;
  title?: string;
  description?: string;
  limit?: number;
  addedAfter?: string;
  addedBefore?: string;
  addedInLast?: string;
  label?: string[];
  folder?: string[];
  place?: string[];
  /** true = only photos WITH GPS data; false = only photos WITHOUT. */
  hasLocation?: boolean;
  year?: number[];
  minSize?: number;
  maxSize?: number;
  noKeyword?: boolean;
  burst?: boolean;
  screenshot?: boolean;
  screenRecording?: boolean;
  selfie?: boolean;
  panorama?: boolean;
  live?: boolean;
  portrait?: boolean;
  timelapse?: boolean;
  slowMo?: boolean;
  /** Alias of movies (only videos). */
  video?: boolean;
  newestFirst?: boolean;
  /** GPS-radius post-filter: "lat,lon,radiusKm". */
  near?: string;
  /** Minimum Photos aesthetic score 0..1 (post-filter). */
  minScore?: number;
  /** Case-insensitive substring over Photos' OCR-indexed text (post-filter). */
  detectedText?: string;
}

/** Result of the get-selected-photos command. */
export interface SelectedPhotosResult {
  count: number;
  /** Same summary shape as query results. */
  photos: PhotoSummary[];
  /** Selected items the osxphotos library index doesn't know (yet). */
  notFound: { uuid: string; filename: string | null }[];
}

// ---------------------------------------------------------------------------
// Write-tool results (opt-in, gated behind APPLE_PHOTOS_MCP_ENABLE_WRITES)
// ---------------------------------------------------------------------------

/** The album an album-write acted on (photoscript projection). */
export interface WriteAlbumRef {
  uuid: string;
  name: string;
  /** Library path incl. the album name, "/"-separated (e.g. "Trips/2026/Camping"). */
  path: string;
}

export interface CreateAlbumResult {
  album: WriteAlbumRef;
  /** false when an album of that name already existed and was returned instead. */
  created: boolean;
}

export interface AddToAlbumResult {
  album: WriteAlbumRef;
  addedCount: number;
  added: string[];
  /** UUIDs that were already in the album (adding is idempotent). */
  alreadyPresent: string[];
  /** Requested UUIDs that don't exist in the library. */
  notFound: string[];
}

export interface RemoveFromAlbumResult {
  /** The album AFTER the operation — its uuid CHANGES when albumRecreated. */
  album: WriteAlbumRef;
  removedCount: number;
  removed: string[];
  /** Requested UUIDs that were not members of the album (no-ops). */
  notInAlbum: string[];
  /**
   * True when the album was rebuilt to effect the removal (Photos' AppleScript
   * has no remove verb); false when nothing needed removing.
   */
  albumRecreated: boolean;
  /** The album's uuid before the rebuild (present when albumRecreated). */
  previousAlbumUuid?: string;
}

export interface PhotoMetadataValues {
  title: string;
  description: string;
  favorite: boolean;
}

export interface SetPhotoMetadataResult {
  uuid: string;
  /** Which fields were written ("title" | "description" | "favorite"). */
  updated: string[];
  before: PhotoMetadataValues;
  after: PhotoMetadataValues;
}

export interface SetKeywordsResult {
  uuid: string;
  before: string[];
  after: string[];
  /** Keywords actually added (requested adds already present are omitted). */
  added: string[];
  /** Keywords actually removed (requested removes not present are omitted). */
  removed: string[];
  changed: boolean;
}

export interface SetPhotoDateResult {
  uuid: string;
  /** The photo's date before the operation (ISO 8601, local time). */
  before: string;
  /** The new date — the would-be date on a dry run, the written date otherwise. */
  after: string;
  /** Effective delta in seconds (after - before). */
  shiftSeconds: number;
  /** True only when the date was actually written (dryRun=false). */
  applied: boolean;
  dryRun: boolean;
}

export interface ImportPhotosResult {
  /** Number of validated source files handed to Photos. */
  requestedCount: number;
  importedCount: number;
  imported: { uuid: string; filename: string | null }[];
  /** Present when the import targeted an album. */
  album?: WriteAlbumRef;
}
