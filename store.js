import { copyFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const seed = () => ({
  version: 1,
  columns: ['Inbox', 'Doing', 'Done'].map((title, i) => ({ id: `seed-${i}`, title, tasks: [] })),
});

const isBoard = (b) =>
  b?.version === 1 &&
  Array.isArray(b.columns) &&
  b.columns.every(
    (c) =>
      typeof c?.id === 'string' &&
      typeof c.title === 'string' &&
      Array.isArray(c.tasks) &&
      c.tasks.every((t) => typeof t?.id === 'string' && typeof t.text === 'string'),
  );

// Windows can briefly lock a file (antivirus, indexer), so the swap gets a few tries.
async function replaceFile(from, to) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await rename(from, to);
    } catch (err) {
      if (attempt >= 8 || !['EPERM', 'EBUSY', 'EACCES'].includes(err.code)) throw err;
      await new Promise((r) => setTimeout(r, 40 * (attempt + 1)));
    }
  }
}

export function createStore(dir) {
  const boardFile = join(dir, 'board.json');
  const backupDir = join(dir, 'backups');
  let lastBackup = null;

  // One queue for all disk access, so a read never sees a half-finished save.
  let queue = Promise.resolve();
  const enqueue = (job) => {
    const run = queue.then(job, job);
    queue = run.catch(() => {});
    return run;
  };

  async function backupOncePerDay() {
    const day = new Date().toLocaleDateString('sv');
    if (lastBackup === day) return;
    try {
      await mkdir(backupDir, { recursive: true });
      await copyFile(boardFile, join(backupDir, `${day}.json`));
    } catch (err) {
      if (err.code === 'ENOENT') return; // nothing to back up yet, so try again next save
      throw err;
    }
    lastBackup = day;
  }

  async function write(board) {
    await mkdir(dir, { recursive: true });
    await backupOncePerDay();
    const tmp = `${boardFile}.tmp`;
    await writeFile(tmp, JSON.stringify(board, null, 2));
    await replaceFile(tmp, boardFile);
  }

  return {
    load: () =>
      enqueue(async () => {
        try {
          return JSON.parse(await readFile(boardFile, 'utf8'));
        } catch (err) {
          if (err.code !== 'ENOENT') throw err;
          const board = seed();
          await write(board);
          return board;
        }
      }),
    save: (board) => {
      if (!isBoard(board)) return Promise.reject(new Error('invalid board'));
      return enqueue(() => write(board));
    },
  };
}
