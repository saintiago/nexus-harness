import { open, readdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { messageOf } from '../result.js';

/** Local artifact access; interpretation and revision attribution stay with the agent. */
export type EvidenceCommand = {
  readonly kind: 'evidence';
  readonly operation: 'list' | 'read';
  readonly root: string;
  readonly paths: readonly string[];
  readonly maxBytes: number;
};

const defaultMaxBytes = 64 * 1024;

export function parseEvidenceCommand(args: readonly string[]): EvidenceCommand {
  const [operation, root, ...options] = args;
  if (operation !== 'list' && operation !== 'read') {
    throw new Error('Use evidence list <root> [paths...] or evidence read <root> <files...>.');
  }
  if (root === undefined || root.startsWith('--')) {
    throw new Error('Evidence commands require a root directory.');
  }
  const paths: string[] = [];
  let maxBytes = defaultMaxBytes;
  let suppliedLimit = false;
  for (let index = 0; index < options.length; index += 1) {
    const option = options[index]!;
    if (option === '--max-bytes' && operation === 'read' && !suppliedLimit) {
      const value = options[++index];
      if (value === undefined || !/^\d+$/.test(value)) {
        throw new Error('--max-bytes requires a positive integer.');
      }
      maxBytes = Number(value);
      if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
        throw new Error('--max-bytes requires a positive safe integer.');
      }
      suppliedLimit = true;
    } else if (option.startsWith('--')) {
      throw new Error(`Unknown evidence option "${option}".`);
    } else {
      paths.push(option);
    }
  }
  if (operation === 'read' && paths.length === 0) {
    throw new Error('Evidence read requires at least one file.');
  }
  return { kind: 'evidence', operation, root, paths, maxBytes };
}

function within(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

async function resolveFile(root: string, requested: string): Promise<string> {
  const target = path.resolve(root, requested);
  if (!within(root, target)) throw new Error('Path is outside the evidence root.');
  const resolved = await realpath(target);
  if (!within(root, resolved)) throw new Error('Symlink points outside the evidence root.');
  return resolved;
}

/** JSON results on stdout; one content-free measurement on stderr, retained by agent activity. */
export async function runEvidenceCommand(settings: {
  readonly command: EvidenceCommand;
  readonly workingDirectory: string;
  readonly output: { write(text: string): unknown };
  readonly diagnostics: { write(text: string): unknown };
}): Promise<number> {
  const { command, output, diagnostics } = settings;
  const started = performance.now();
  const usage = {
    event: 'evidence-helper',
    timestamp: new Date().toISOString(),
    operation: command.operation,
    root: path.resolve(settings.workingDirectory, command.root),
    requestedPaths: command.paths.length,
    files: 0,
    failures: 0,
    omittedPaths: 0,
    sourceBytes: 0,
    bytesRead: 0,
    contentBytes: 0,
    stdoutBytes: 0,
    truncatedFiles: 0,
    durationMs: 0,
  };
  const print = (value: unknown) => {
    const text = `${JSON.stringify(value, null, 2)}\n`;
    usage.stdoutBytes = Buffer.byteLength(text);
    output.write(text);
  };
  try {
    const root = await realpath(usage.root);
    if (!(await stat(root)).isDirectory()) throw new Error('Evidence root must be a directory.');
    usage.root = root;
    if (command.operation === 'list') {
      const files: { path: string; bytes: number }[] = [];
      const omitted: { path: string; reason: string }[] = [];
      const seen = new Set<string>();
      const walk = async (target: string): Promise<void> => {
        if (seen.has(target)) return;
        seen.add(target);
        const info = await stat(target);
        if (info.isFile()) {
          files.push({ path: path.relative(root, target), bytes: info.size });
          usage.sourceBytes += info.size;
          return;
        }
        if (!info.isDirectory()) return;
        const entries = await readdir(target, { withFileTypes: true });
        entries.sort((a, b) => a.name.localeCompare(b.name));
        for (const entry of entries) {
          const child = path.join(target, entry.name);
          if (
            entry.isSymbolicLink() ||
            (target === root && entry.isDirectory() && entry.name === 'worktree')
          ) {
            omitted.push({
              path: path.relative(root, child),
              reason: entry.isSymbolicLink()
                ? 'symlink'
                : 'repository checkout; list explicitly if needed',
            });
          } else {
            await walk(child);
          }
        }
      };
      for (const requested of command.paths.length === 0 ? ['.'] : command.paths) {
        await walk(await resolveFile(root, requested));
      }
      usage.files = files.length;
      usage.omittedPaths = omitted.length;
      print({ root, files, omitted });
    } else {
      const files: unknown[] = [];
      for (const requested of command.paths) {
        try {
          const target = await resolveFile(root, requested);
          const handle = await open(target, 'r');
          try {
            const info = await handle.stat();
            if (!info.isFile()) throw new Error('Evidence read requires a regular file.');
            const buffer = Buffer.alloc(Math.min(info.size, command.maxBytes));
            let bytesRead = 0;
            while (bytesRead < buffer.length) {
              const result = await handle.read(
                buffer,
                bytesRead,
                buffer.length - bytesRead,
                bytesRead,
              );
              if (result.bytesRead === 0) break;
              bytesRead += result.bytesRead;
            }
            const truncated = info.size > bytesRead;
            usage.sourceBytes += info.size;
            usage.bytesRead += bytesRead;
            const decoder = new TextDecoder('utf-8', { fatal: true });
            const content = decoder.decode(buffer.subarray(0, bytesRead), { stream: truncated });
            const contentBytes = Buffer.byteLength(content);
            files.push({ path: requested, bytes: info.size, contentBytes, truncated, content });
            usage.files += 1;
            usage.contentBytes += contentBytes;
            usage.truncatedFiles += Number(truncated);
          } finally {
            await handle.close();
          }
        } catch (error) {
          usage.failures += 1;
          files.push({ path: requested, error: messageOf(error) });
        }
      }
      print({ root, files });
    }
    return usage.failures === 0 ? 0 : 1;
  } catch (error) {
    usage.failures += 1;
    print({ error: messageOf(error) });
    return 1;
  } finally {
    usage.durationMs = Math.round((performance.now() - started) * 1000) / 1000;
    diagnostics.write(`${JSON.stringify(usage)}\n`);
  }
}
