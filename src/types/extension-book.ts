/**
 * Book and chapter data structures from Libby (Chrome Extension)
 */

export interface BookMetadata {
  title: string;
  authors: string[];
  narrators?: string[];
  coverUrl?: string;
  duration?: number;
  publisher?: string;
  publishDate?: string;
  description?: string;
}

export interface Chapter {
  index: number;
  title: string;
  url: string;
  duration: number;
  startTime?: number;
  endTime?: number;
}

/**
 * A single entry from the book's table of contents.
 * Each TOC entry maps to a position within one of the downloadable audio parts.
 */
export interface TocEntry {
  title: string;
  part: number; // zero-based index into the parts/chapters array
  startTime: number; // time offset in seconds within that part
}

export interface BookData {
  metadata: BookMetadata;
  chapters: Chapter[]; // downloadable audio parts (one per file)
  toc?: TocEntry[]; // actual book chapters with positions
}

/**
 * Crypto parameters extracted from Libby's odreadCmptParams
 */
export interface CryptoParams {
  b: {
    '-odread-cmpt-params': number[];
  };
}

/**
 * BIF (Book Information File) object structure from Libby
 */
export interface BIFObject {
  title: string;
  creator?: string[];
  narrator?: string[];
  spine: BIFSpineItem[];
  metadata?: {
    cover?: {
      href: string;
    };
    duration?: number;
    publisher?: string;
    pubdate?: string;
    description?: string;
  };
}

export interface BIFSpineItem {
  path: string;
  title: string;
  duration?: number;
  '-odread-spine-position'?: number;
}
