/**
 * Split command - splits downloaded part files into individual chapter MP3s
 * using TOC timestamps from metadata.json, with ID3 tags applied immediately.
 */

import { promises as fs } from 'fs';
import * as path from 'path';
import * as os from 'os';
import chalk from 'chalk';
import ffmpeg from 'fluent-ffmpeg';
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg';
import NodeID3 from 'node-id3';
import { BookService } from '../services/book-service';

ffmpeg.setFfmpegPath(ffmpegInstaller.path);

interface FullMetadata {
  metadata: {
    title: string;
    authors: string[];
    narrator?: string;
    narrators?: string[];
    coverUrl?: string;
    description?: string | { full: string; short: string };
  };
  chapters: unknown[];
  toc?: Array<{ title: string; part: number; startTime: number }>;
}

/**
 * Sanitize a chapter title for use in a filename.
 * Keeps alphanumerics, spaces→hyphens, removes everything else.
 */
function titleToFilename(title: string): string {
  return title
    .replace(/[^a-zA-Z0-9 ]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .substring(0, 60);
}

/**
 * Extract a segment from an audio file using ffmpeg (-c copy, no re-encode)
 */
function extractSegment(
  inputPath: string,
  outputPath: string,
  startTime: number,
  endTime: number | null
): Promise<void> {
  return new Promise((resolve, reject) => {
    const cmd = ffmpeg(inputPath).inputOptions(['-ss', String(startTime)]);
    if (endTime !== null) {
      cmd.inputOptions(['-to', String(endTime)]);
    }
    cmd
      .outputOptions(['-c', 'copy'])
      .output(outputPath)
      .on('end', () => resolve())
      .on('error', (err) => reject(err))
      .run();
  });
}

/**
 * Download cover art from URL, returns buffer or undefined
 */
async function downloadCoverArt(coverUrl?: string): Promise<Buffer | undefined> {
  if (!coverUrl) return undefined;
  try {
    const response = await fetch(coverUrl);
    if (!response.ok) return undefined;
    return Buffer.from(await response.arrayBuffer());
  } catch {
    return undefined;
  }
}

/**
 * Embed ID3 tags into a single MP3 file
 */
function tagFile(
  filePath: string,
  opts: {
    title: string;
    artist: string;
    album: string;
    narrator?: string;
    trackNumber: string;
    description?: string;
    coverBuffer?: Buffer;
  }
): void {
  const descriptionText = opts.description ?? '';

  const tags: NodeID3.Tags = {
    title: opts.title,
    artist: opts.artist,
    album: opts.album,
    performerInfo: opts.narrator || opts.artist,
    trackNumber: opts.trackNumber,
    genre: 'Audiobook',
  };

  if (descriptionText) {
    tags.comment = { language: 'eng', text: descriptionText };
  }

  if (opts.coverBuffer) {
    tags.image = {
      mime: 'image/jpeg',
      type: { id: 3, name: 'front cover' },
      description: 'Album cover',
      imageBuffer: opts.coverBuffer,
    };
  }

  NodeID3.write(tags, filePath);
}

/**
 * Split part files in a book folder into individual chapter MP3s based on TOC.
 */
export async function splitChapters(folderPath: string): Promise<void> {
  // Load metadata
  const metadataFiles = ['metadata.json', '.metadata.json', 'download.json'];
  let meta: FullMetadata | null = null;
  for (const filename of metadataFiles) {
    try {
      const content = await fs.readFile(path.join(folderPath, filename), 'utf-8');
      meta = JSON.parse(content);
      break;
    } catch {
      continue;
    }
  }

  if (!meta?.toc || meta.toc.length === 0) {
    console.log(
      chalk.yellow(
        'No TOC found in metadata. Re-download the book with the updated extension first.'
      )
    );
    return;
  }

  const toc = meta.toc;
  const bookTitle = meta.metadata.title;
  const artist = meta.metadata.authors.join(', ');
  const narrator = meta.metadata.narrator ?? meta.metadata.narrators?.[0];
  const description = meta.metadata.description;

  // Find and sort existing MP3 part files
  const files = await fs.readdir(folderPath);
  const mp3Files = files
    .filter((f) => f.endsWith('.mp3'))
    .sort((a, b) => {
      const numA = parseInt(a.match(/(\d+)/)?.[1] || '0', 10);
      const numB = parseInt(b.match(/(\d+)/)?.[1] || '0', 10);
      return numA - numB;
    });

  const partCount = Math.max(...toc.map((e) => e.part)) + 1;
  if (mp3Files.length < partCount) {
    console.log(
      chalk.red(`TOC references ${partCount} parts but only ${mp3Files.length} MP3 files found.`)
    );
    return;
  }

  if (mp3Files.length > partCount) {
    console.log(
      chalk.yellow(
        `Found ${mp3Files.length} MP3 files but only ${partCount} parts in TOC — may already be split.`
      )
    );
    const { default: inquirer } = await import('inquirer');
    const { proceed } = await inquirer.prompt<{ proceed: boolean }>([
      { type: 'confirm', name: 'proceed', message: 'Proceed anyway?', default: false },
    ]);
    if (!proceed) return;
  }

  // Download cover art once
  process.stdout.write(chalk.gray('Downloading cover art... '));
  const coverBuffer = await downloadCoverArt(meta.metadata.coverUrl);
  console.log(coverBuffer ? chalk.green('done') : chalk.yellow('skipped'));

  // Build split segments
  const segments = toc.map((entry, i) => {
    const nextInSamePart = toc.slice(i + 1).find((e) => e.part === entry.part);
    return {
      tocIndex: i,
      title: entry.title,
      partFile: mp3Files[entry.part],
      startTime: entry.startTime,
      endTime: nextInSamePart ? nextInSamePart.startTime : null,
    };
  });

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'libby-split-'));

  console.log(chalk.cyan(`\nSplitting ${partCount} parts into ${segments.length} chapters...\n`));

  try {
    for (const seg of segments) {
      const num = String(seg.tocIndex + 1).padStart(3, '0');
      const safeName = titleToFilename(seg.title);
      const filename = `${num}-${safeName}.mp3`;
      const tmpOut = path.join(tmpDir, filename);
      const inputPath = path.join(folderPath, seg.partFile);

      process.stdout.write(chalk.gray(`  [${num}] ${seg.title}... `));

      await extractSegment(inputPath, tmpOut, seg.startTime, seg.endTime);

      tagFile(tmpOut, {
        title: seg.title,
        artist,
        album: bookTitle,
        narrator,
        trackNumber: `${seg.tocIndex + 1}/${segments.length}`,
        description:
          typeof description === 'string' ? description : (description?.short ?? description?.full),
        coverBuffer,
      });

      console.log(chalk.green('done'));
    }

    // Move originals to parts/ subfolder
    const partsDir = path.join(folderPath, 'parts');
    await fs.mkdir(partsDir, { recursive: true });
    for (const f of mp3Files) {
      await fs.rename(path.join(folderPath, f), path.join(partsDir, f));
    }
    console.log(chalk.gray(`\n  Original parts moved to: parts/`));

    // Move new chapter files into place
    const tmpFiles = await fs.readdir(tmpDir);
    for (const f of tmpFiles) {
      await fs.rename(path.join(tmpDir, f), path.join(folderPath, f));
    }
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }

  console.log(chalk.green(`\n✓ Split into ${segments.length} tagged chapter files successfully.`));
}

/**
 * Split command entry point
 */
export async function splitCommand(folder?: string): Promise<void> {
  const bookService = new BookService();

  if (folder) {
    const book = await bookService.findBook(folder);
    await splitChapters(book ? book.path : folder);
    return;
  }

  const books = await bookService.discoverBooks();
  if (books.length === 0) {
    console.log(chalk.yellow('No books found in downloads folder.'));
    return;
  }

  const { BookSelector } = await import('../ui/prompts/book-selector');
  const { BookPresenter } = await import('../ui/presenters/book-presenter');
  const bookSelector = new BookSelector();
  const bookPresenter = new BookPresenter();

  const selected = await bookSelector.selectBook(books, {
    message: 'Which book do you want to split into chapters?',
  });

  if (!selected || Array.isArray(selected)) return;

  console.log(chalk.bold(`\n📖 ${bookPresenter.getTitle(selected)}\n`));
  await splitChapters(selected.path);
  console.log();
}
