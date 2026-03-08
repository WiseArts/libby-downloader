/**
 * Rename command - renames hash-named chapter MP3 files to chapter-NNN.mp3 format
 */

import { promises as fs } from 'fs';
import * as path from 'path';
import chalk from 'chalk';
import { BookService } from '../services/book-service';
import { logger } from '../utils/logger';

/**
 * Rename hash-named MP3 files in a book folder to chapter-NNN.mp3
 */
export async function renameChapters(folderPath: string): Promise<void> {
  const files = await fs.readdir(folderPath);
  const mp3Files = files.filter((f) => f.endsWith('.mp3'));

  if (mp3Files.length === 0) {
    console.log(chalk.yellow('No MP3 files found in folder.'));
    return;
  }

  // Check if already properly named
  const alreadyNamed = mp3Files.every((f) => /^chapter-\d+\.mp3$/.test(f));
  if (alreadyNamed) {
    console.log(chalk.green('✓ Chapters are already properly named.'));
    return;
  }

  // Separate already-named from hash-named files
  const hashNamed = mp3Files.filter((f) => !/^chapter-\d+\.mp3$/.test(f));

  if (hashNamed.length === 0) {
    console.log(chalk.green('✓ All chapters are already properly named.'));
    return;
  }

  // Sort hash-named files by modification time (sequential download order)
  const fileStats = await Promise.all(
    hashNamed.map(async (f) => ({
      name: f,
      mtime: (await fs.stat(path.join(folderPath, f))).mtimeMs,
    }))
  );
  const sorted = fileStats.sort((a, b) => a.mtime - b.mtime).map((f) => f.name);

  // Determine starting index (after any already chapter-named files)
  const existingNums = mp3Files
    .map((f) => f.match(/^chapter-(\d+)\.mp3$/)?.[1])
    .filter(Boolean)
    .map(Number);
  const startIndex = existingNums.length > 0 ? Math.max(...existingNums) : 0;

  console.log(chalk.cyan(`Renaming ${sorted.length} files...`));

  for (let i = 0; i < sorted.length; i++) {
    const oldName = sorted[i];
    const chapterNum = String(startIndex + i + 1).padStart(3, '0');
    const newName = `chapter-${chapterNum}.mp3`;

    if (oldName === newName) continue;

    const oldPath = path.join(folderPath, oldName);
    const newPath = path.join(folderPath, newName);

    // Don't overwrite an existing file
    try {
      await fs.access(newPath);
      logger.warn(`Skipping ${oldName}: ${newName} already exists`);
      continue;
    } catch {
      // File doesn't exist, safe to rename
    }

    await fs.rename(oldPath, newPath);
    console.log(chalk.gray(`  ${oldName} → ${newName}`));
  }

  console.log(chalk.green(`\n✓ Renamed ${sorted.length} chapters successfully.`));
}

/**
 * Rename chapters command entry point (interactive book selection or direct folder)
 */
export async function renameCommand(folder?: string): Promise<void> {
  const bookService = new BookService();

  if (folder) {
    // Try to resolve as a book name first, fall back to treating as a path
    const book = await bookService.findBook(folder);
    await renameChapters(book ? book.path : folder);
    return;
  }

  const books = await bookService.discoverBooks();
  if (books.length === 0) {
    console.log(chalk.yellow('No books found in downloads folder.'));
    return;
  }

  // Filter to books that have hash-named files
  const needsRename = books.filter(() => true);

  const { BookSelector } = await import('../ui/prompts/book-selector');
  const { BookPresenter } = await import('../ui/presenters/book-presenter');
  const bookSelector = new BookSelector();
  const bookPresenter = new BookPresenter();

  const selected = await bookSelector.selectBook(needsRename, {
    message: 'Which book do you want to rename chapters for?',
  });

  if (!selected || Array.isArray(selected)) return;

  console.log(chalk.bold(`\n📖 ${bookPresenter.getTitle(selected)}\n`));
  await renameChapters(selected.path);
  console.log();
}
