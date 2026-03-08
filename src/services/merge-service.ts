/**
 * MergeService - Combines MP3 chapters into a single M4B audiobook
 */

import { promises as fs } from 'fs';
import * as path from 'path';
import * as os from 'os';
import ffmpeg from 'fluent-ffmpeg';
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg';
import { Listr } from 'listr2';
import chalk from 'chalk';

// Set ffmpeg path to bundled binary
ffmpeg.setFfmpegPath(ffmpegInstaller.path);

interface BookMetadata {
  metadata: {
    title: string;
    authors: string[];
    narrator?: string;
    narrators?: string[];
    coverUrl?: string;
    description?: string | { full: string; short: string };
  };
  chapters: Array<{
    index: number;
    title: string;
    duration: number;
  }>;
  toc?: Array<{
    title: string;
    part: number;
    startTime: number;
  }>;
}

interface ChapterInfo {
  file: string;
  filePath: string;
  index: number;
  title: string;
  startTime: number;
  endTime: number;
  duration: number;
}

interface MergeContext {
  folderPath: string;
  metadata?: BookMetadata;
  chapterFiles?: string[];
  chapters?: ChapterInfo[];
  tmpDir?: string;
  concatFilePath?: string;
  metadataFilePath?: string;
  coverArtPath?: string | null;
  outputPath?: string;
  outputFilename?: string;
}

export class MergeService {
  /**
   * Merge all chapter MP3 files in a folder into a single M4B audiobook
   */
  async mergeFolder(folderPath: string): Promise<string> {
    const ctx: MergeContext = { folderPath };

    const tasks = new Listr<MergeContext>(
      [
        {
          title: 'Validating folder',
          task: async (ctx) => {
            const stat = await fs.stat(ctx.folderPath);
            if (!stat.isDirectory()) {
              throw new Error(`Not a directory: ${ctx.folderPath}`);
            }
          },
        },
        {
          title: 'Preparing audiobook',
          task: (_ctx, task) =>
            task.newListr(
              [
                {
                  title: 'Loading metadata',
                  task: async (ctx, task) => {
                    ctx.metadata = await this.loadMetadata(ctx.folderPath);
                    task.title = `Loading metadata: ${chalk.cyan(ctx.metadata.metadata.title)}`;
                  },
                },
                {
                  title: 'Finding chapter files',
                  task: async (ctx, task) => {
                    ctx.chapterFiles = await this.findChapterFiles(ctx.folderPath);
                    task.title = `Finding chapter files: ${chalk.green(`${ctx.chapterFiles.length} found`)}`;
                  },
                },
                {
                  title: 'Calculating chapter timestamps',
                  task: async (ctx) => {
                    if (!ctx.metadata || !ctx.chapterFiles) {
                      throw new Error('Missing metadata or chapter files');
                    }
                    ctx.chapters = await this.calculateChapterInfo(
                      ctx.folderPath,
                      ctx.chapterFiles,
                      ctx.metadata
                    );
                  },
                },
                {
                  title: 'Creating temporary directory',
                  task: async (ctx) => {
                    ctx.tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'libby-merge-'));
                  },
                },
                {
                  title: 'Generating merge files',
                  task: (_ctx, task) =>
                    task.newListr([
                      {
                        title: 'Creating concat file',
                        task: async (ctx) => {
                          if (!ctx.chapterFiles || !ctx.tmpDir) {
                            throw new Error('Missing chapter files or tmp dir');
                          }
                          ctx.concatFilePath = path.join(ctx.tmpDir, 'concat.txt');
                          await this.createConcatFile(
                            ctx.chapterFiles,
                            ctx.folderPath,
                            ctx.concatFilePath
                          );
                        },
                      },
                      {
                        title: 'Creating metadata file',
                        task: async (ctx) => {
                          if (!ctx.metadata || !ctx.chapters || !ctx.tmpDir) {
                            throw new Error('Missing metadata, chapters, or tmp dir');
                          }
                          ctx.metadataFilePath = path.join(ctx.tmpDir, 'metadata.txt');
                          await this.generateMetadataFile(
                            ctx.metadata,
                            ctx.chapters,
                            ctx.metadataFilePath
                          );
                        },
                      },
                      {
                        title: 'Downloading cover art',
                        enabled: (ctx) => !!ctx.metadata?.metadata.coverUrl,
                        task: async (ctx, task) => {
                          if (!ctx.metadata || !ctx.tmpDir) {
                            throw new Error('Missing metadata or tmp dir');
                          }
                          const coverArtPath = path.join(ctx.tmpDir, 'cover.jpg');
                          ctx.coverArtPath = await this.downloadCoverArt(
                            ctx.metadata.metadata.coverUrl,
                            coverArtPath
                          );
                          if (ctx.coverArtPath) {
                            task.title = 'Downloading cover art: ' + chalk.green('✓ Downloaded');
                          } else {
                            task.title = 'Downloading cover art: ' + chalk.yellow('⚠ Skipped');
                          }
                        },
                      },
                    ]),
                },
                {
                  title: 'Preparing output file',
                  task: async (ctx) => {
                    if (!ctx.metadata) {
                      throw new Error('Missing metadata');
                    }
                    const sanitizedTitle = this.sanitizeFilename(ctx.metadata.metadata.title);
                    ctx.outputFilename = `${sanitizedTitle}.m4b`;
                    ctx.outputPath = path.join(ctx.folderPath, ctx.outputFilename);

                    // Check if output file already exists
                    try {
                      await fs.access(ctx.outputPath);
                      throw new Error(`Output file already exists: ${ctx.outputFilename}`);
                    } catch (error) {
                      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
                        throw error;
                      }
                    }
                  },
                },
              ],
              { concurrent: false }
            ),
        },
        {
          title: 'Merging chapters into M4B',
          task: async (ctx, task) => {
            if (!ctx.concatFilePath || !ctx.metadataFilePath || !ctx.outputPath || !ctx.metadata) {
              throw new Error('Missing required merge files');
            }

            const totalDuration = ctx.chapters
              ? ctx.chapters.reduce((sum, ch) => sum + ch.duration, 0)
              : 0;
            const hours = Math.floor(totalDuration / 3600);
            const minutes = Math.floor((totalDuration % 3600) / 60);

            task.title = `Merging chapters (${hours}h ${minutes}m total)`;

            await this.executeMerge(
              ctx.concatFilePath,
              ctx.metadataFilePath,
              ctx.coverArtPath || null,
              ctx.outputPath,
              (timemark) => {
                task.output = `Progress: ${chalk.cyan(timemark)} / 64kbps AAC`;
              }
            );

            task.title = `Merging chapters: ${chalk.green('✓ Complete')}`;
          },
        },
        {
          title: 'Cleaning up',
          task: async (ctx, task) => {
            if (ctx.tmpDir) {
              try {
                await fs.rm(ctx.tmpDir, { recursive: true, force: true });
                task.title = 'Cleaning up: ' + chalk.green('✓ Complete');
              } catch {
                task.title = 'Cleaning up: ' + chalk.yellow('⚠ Partial cleanup');
              }
            }
          },
        },
      ],
      {
        rendererOptions: {
          collapseSubtasks: false,
        },
      }
    );

    await tasks.run(ctx);

    if (!ctx.outputPath || !ctx.outputFilename) {
      throw new Error('Merge completed but output path is missing');
    }

    // Show final success message
    const fileSize = (await fs.stat(ctx.outputPath)).size;
    const fileSizeMB = (fileSize / 1024 / 1024).toFixed(1);
    console.log(
      chalk.green(`\n✔ Successfully created: ${ctx.outputFilename} (${fileSizeMB} MB)\n`)
    );

    return ctx.outputPath;
  }

  /**
   * Load and validate book metadata from metadata.json
   */
  private async loadMetadata(folderPath: string): Promise<BookMetadata> {
    const metadataFiles = ['metadata.json', '.metadata.json', 'download.json'];

    for (const filename of metadataFiles) {
      try {
        const metadataPath = path.join(folderPath, filename);
        const content = await fs.readFile(metadataPath, 'utf-8');
        const metadata = JSON.parse(content) as BookMetadata;

        // Validate required fields
        if (!metadata.metadata?.title) {
          throw new Error(`${filename} missing required field: title`);
        }
        if (!metadata.metadata?.authors || metadata.metadata.authors.length === 0) {
          throw new Error(`${filename} missing required field: authors`);
        }
        if (!metadata.chapters || metadata.chapters.length === 0) {
          throw new Error(`${filename} has no chapters`);
        }

        // Normalize narrators -> narrator
        if (!metadata.metadata.narrator && metadata.metadata.narrators?.length) {
          metadata.metadata.narrator = metadata.metadata.narrators[0];
        }

        return metadata;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw error;
        }
      }
    }

    throw new Error('metadata.json not found. Download book metadata first.');
  }

  /**
   * Find and validate all chapter MP3 files
   */
  private async findChapterFiles(folderPath: string): Promise<string[]> {
    const files = await fs.readdir(folderPath);
    const mp3Files = files.filter((f) => f.endsWith('.mp3'));

    if (mp3Files.length === 0) {
      throw new Error('No chapter MP3 files found. Download chapters first.');
    }

    // If files use chapter-NNN.mp3 naming, sort numerically
    const chapterNamed = mp3Files.filter((f) => f.startsWith('chapter-'));
    if (chapterNamed.length > 0) {
      return chapterNamed.sort((a, b) => {
        const numA = parseInt(a.match(/chapter-(\d+)/)?.[1] || '0', 10);
        const numB = parseInt(b.match(/chapter-(\d+)/)?.[1] || '0', 10);
        return numA - numB;
      });
    }

    // Otherwise sort by modification time (sequential download order)
    const fileStats = await Promise.all(
      mp3Files.map(async (f) => ({
        name: f,
        mtime: (await fs.stat(path.join(folderPath, f))).mtimeMs,
      }))
    );
    return fileStats.sort((a, b) => a.mtime - b.mtime).map((f) => f.name);
  }

  /**
   * Get duration of an MP3 file using ffprobe
   */
  private async getAudioDuration(filePath: string): Promise<number> {
    return new Promise((resolve, reject) => {
      ffmpeg.ffprobe(filePath, (err, metadata) => {
        if (err) {
          reject(new Error(`Failed to probe ${filePath}: ${err.message}`));
          return;
        }

        const duration = metadata.format.duration;
        if (!duration) {
          reject(new Error(`Could not determine duration for ${filePath}`));
          return;
        }

        resolve(duration);
      });
    });
  }

  /**
   * Calculate chapter info with timestamps
   */
  private async calculateChapterInfo(
    folderPath: string,
    chapterFiles: string[],
    metadata: BookMetadata
  ): Promise<ChapterInfo[]> {
    // Get actual duration of each part file
    const partDurations: number[] = [];
    for (let i = 0; i < chapterFiles.length; i++) {
      const filePath = path.join(folderPath, chapterFiles[i]);
      try {
        partDurations.push(await this.getAudioDuration(filePath));
      } catch {
        partDurations.push(metadata.chapters[i]?.duration || 0);
      }
    }

    // Use toc entries for chapter markers if available
    if (metadata.toc && metadata.toc.length > 0) {
      return this.buildChaptersFromToc(chapterFiles, folderPath, partDurations, metadata.toc);
    }

    // Fallback: one chapter per audio file
    const chapters: ChapterInfo[] = [];
    let currentTime = 0;
    for (let i = 0; i < chapterFiles.length; i++) {
      const file = chapterFiles[i];
      const duration = partDurations[i];
      const startTimeMs = Math.floor(currentTime * 1000);
      const endTimeMs = Math.floor((currentTime + duration) * 1000);
      chapters.push({
        file,
        filePath: path.join(folderPath, file),
        index: i,
        title: metadata.chapters[i]?.title || `Part ${i + 1}`,
        startTime: startTimeMs,
        endTime: endTimeMs,
        duration,
      });
      currentTime += duration;
    }
    return chapters;
  }

  /**
   * Build chapter info from TOC entries with absolute timestamps
   */
  private buildChaptersFromToc(
    chapterFiles: string[],
    folderPath: string,
    partDurations: number[],
    toc: Array<{ title: string; part: number; startTime: number }>
  ): ChapterInfo[] {
    // Calculate cumulative start time for each part
    const partStartTimes: number[] = [];
    let cumulative = 0;
    for (const d of partDurations) {
      partStartTimes.push(cumulative);
      cumulative += d;
    }
    const totalDuration = cumulative;

    const chapters: ChapterInfo[] = [];
    for (let i = 0; i < toc.length; i++) {
      const entry = toc[i];
      const absStart = (partStartTimes[entry.part] ?? 0) + entry.startTime;
      const nextEntry = toc[i + 1];
      const absEnd = nextEntry
        ? (partStartTimes[nextEntry.part] ?? 0) + nextEntry.startTime
        : totalDuration;

      // Use the part file that contains this chapter as the reference file
      const file = chapterFiles[entry.part] ?? chapterFiles[0];
      chapters.push({
        file,
        filePath: path.join(folderPath, file),
        index: i,
        title: entry.title,
        startTime: Math.floor(absStart * 1000),
        endTime: Math.floor(absEnd * 1000),
        duration: absEnd - absStart,
      });
    }
    return chapters;
  }

  /**
   * Create concat file listing all chapter MP3s
   */
  private async createConcatFile(
    chapterFiles: string[],
    folderPath: string,
    outputPath: string
  ): Promise<string> {
    const lines = chapterFiles.map((file) => {
      const fullPath = path.join(folderPath, file);
      // Escape single quotes in path
      const escapedPath = fullPath.replace(/'/g, "'\\''");
      return `file '${escapedPath}'`;
    });

    const content = lines.join('\n');
    await fs.writeFile(outputPath, content, 'utf-8');

    return outputPath;
  }

  /**
   * Generate FFmpeg metadata file (FFMETADATA1 format) with chapter markers
   */
  private async generateMetadataFile(
    metadata: BookMetadata,
    chapters: ChapterInfo[],
    outputPath: string
  ): Promise<string> {
    const lines: string[] = [';FFMETADATA1'];

    // Global metadata
    lines.push(`title=${metadata.metadata.title}`);
    lines.push(`artist=${metadata.metadata.authors.join(', ')}`);
    lines.push(`album=${metadata.metadata.title}`);
    lines.push('genre=Audiobook');

    if (metadata.metadata.narrator) {
      lines.push(`album_artist=${metadata.metadata.narrator}`);
    }

    // Description
    const description =
      typeof metadata.metadata.description === 'string'
        ? metadata.metadata.description
        : metadata.metadata.description?.short || metadata.metadata.description?.full || '';

    if (description) {
      lines.push(`comment=${description}`);
    }

    // Chapter markers
    for (const chapter of chapters) {
      lines.push('');
      lines.push('[CHAPTER]');
      lines.push('TIMEBASE=1/1000');
      lines.push(`START=${chapter.startTime}`);
      lines.push(`END=${chapter.endTime}`);
      lines.push(`title=${chapter.title}`);
    }

    const content = lines.join('\n');
    await fs.writeFile(outputPath, content, 'utf-8');

    return outputPath;
  }

  /**
   * Download cover art to temporary file
   */
  private async downloadCoverArt(
    coverUrl: string | undefined,
    outputPath: string
  ): Promise<string | null> {
    if (!coverUrl) {
      return null;
    }

    try {
      const response = await fetch(coverUrl);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const arrayBuffer = await response.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);

      await fs.writeFile(outputPath, buffer);
      return outputPath;
    } catch {
      return null;
    }
  }

  /**
   * Execute ffmpeg merge with progress reporting
   */
  private async executeMerge(
    concatFilePath: string,
    metadataFilePath: string,
    coverArtPath: string | null,
    outputPath: string,
    onProgress?: (timemark: string) => void
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      let stderrOutput = '';

      const command = ffmpeg()
        .input(concatFilePath)
        .inputOptions(['-f', 'concat', '-safe', '0'])
        .input(metadataFilePath)
        .inputOptions(['-f', 'ffmetadata']);

      const outputOptions = [
        '-map',
        '0:a:0',
        '-map_metadata',
        '1',
        '-c:a',
        'aac',
        '-b:a',
        '64k',
        '-ac',
        '2',
        '-movflags',
        '+faststart',
      ];

      // Add cover art if available
      if (coverArtPath) {
        command.input(coverArtPath);
        outputOptions.push('-map', '2:v:0', '-c:v', 'copy', '-disposition:v:0', 'attached_pic');
      }

      command
        .outputOptions(outputOptions)
        .output(outputPath)
        .on('progress', (progress) => {
          if (progress.timemark && onProgress) {
            onProgress(progress.timemark);
          }
        })
        .on('stderr', (stderrLine) => {
          stderrOutput += stderrLine + '\n';
        })
        .on('end', () => {
          resolve();
        })
        .on('error', (err) => {
          console.error('\n=== FFmpeg Error Details ===');
          console.error('Error:', err.message);
          console.error('\n=== FFmpeg stderr output ===');
          console.error(stderrOutput);
          console.error('===========================\n');
          reject(new Error(`Failed to merge audiobook: ${err.message}`));
        })
        .run();
    });
  }

  /**
   * Sanitize filename for cross-platform compatibility
   */
  private sanitizeFilename(filename: string): string {
    return filename
      .replace(/[<>:"/\\|?*]/g, '-')
      .replace(/\s+/g, ' ')
      .replace(/^\.+/, '')
      .trim();
  }
}
