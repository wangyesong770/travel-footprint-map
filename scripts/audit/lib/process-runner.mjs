import { spawn } from 'node:child_process';
import { Buffer } from 'node:buffer';

const DEFAULT_OUTPUT_LIMIT = 64 * 1024;

export function runProcess(command, args, options = {}) {
  if (typeof command !== 'string' || command.length === 0 || !Array.isArray(args) || args.some((arg) => typeof arg !== 'string')) {
    throw new TypeError('command and arguments must be strings');
  }
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_OUTPUT_LIMIT;
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1) throw new TypeError('maxOutputBytes must be a positive integer');

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;

    const appendBounded = (chunks, chunk, currentBytes) => {
      if (currentBytes >= maxOutputBytes) return currentBytes + chunk.byteLength;
      chunks.push(chunk.subarray(0, maxOutputBytes - currentBytes));
      return currentBytes + chunk.byteLength;
    };
    child.stdout.on('data', (chunk) => { stdoutBytes = appendBounded(stdout, chunk, stdoutBytes); });
    child.stderr.on('data', (chunk) => { stderrBytes = appendBounded(stderr, chunk, stderrBytes); });
    child.once('error', reject);
    child.once('close', (exitCode, signal) => {
      resolve({
        exitCode: exitCode ?? 1,
        signal,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        stdoutTruncated: stdoutBytes > maxOutputBytes,
        stderrTruncated: stderrBytes > maxOutputBytes,
      });
    });
    if (options.input === undefined) child.stdin.end();
    else child.stdin.end(options.input, 'utf8');
  });
}
