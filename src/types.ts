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
}
