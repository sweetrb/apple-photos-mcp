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
  count: number;
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
}
