/**
 * The liveness beacon a fixture process answers on, shared by every fixture.
 *
 * A PID is not an identity on this platform: Windows hands a PID to a new
 * process within seconds of the process that held it ending, so a recorded PID
 * that looks alive is not evidence that the process it was recorded from still
 * is (see notes/windows-fixture-flakes.md). A beacon answers only while the one
 * process that created it runs, at an address named by a random token that
 * process records, so asking it tells the two apart. What a caller does with the
 * answer — a liveness assertion, or a stop that must not name a stranger's PID —
 * is the caller's business.
 *
 * The server never keeps its process alive and never ends a turn: a client that
 * connects and leaves is answered and nothing else.
 */

import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { connect, createServer } from 'node:net';
import path from 'node:path';

/** A fresh token, unique to one fixture process. */
export const randomToken = () => randomBytes(8).toString('hex');

/** Where one process's beacon answers: a named pipe on Windows, a socket elsewhere. */
export const beaconAddress = (directory, token) =>
  process.platform === 'win32'
    ? `\\\\.\\pipe\\nexus-fixture-${token}`
    : path.join(directory, 'beacons', `${token}.sock`);

/**
 * Starts answering for `token` under `directory`, and resolves when the listener
 * is up or has refused to start: a beacon that could not be created is not a
 * failed turn either, and the token is only recorded once its listener exists.
 */
export function startBeacon(directory, token) {
  if (process.platform !== 'win32') {
    mkdirSync(path.dirname(beaconAddress(directory, token)), { recursive: true });
  }
  const server = createServer((socket) => {
    // A client that has already gone — which is exactly what a liveness check
    // does the moment it has its answer — must never end this process: a write
    // failure here would turn a check into a kill.
    socket.on('error', () => undefined);
    socket.end(`${token}\n`);
  });
  server.on('error', () => undefined);
  // The listener is not a reason for this process to stay alive.
  server.unref();
  const ready = new Promise((resolve) => {
    server.once('listening', resolve);
    server.once('error', resolve);
  });
  server.listen(beaconAddress(directory, token));
  return ready;
}

/** Connects to one beacon until it answers, or gives up: does it answer at all? */
export function beaconAnswers(directory, token, timeoutMs) {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;
    const attempt = () => {
      const socket = connect(beaconAddress(directory, token));
      socket.on('error', () => {
        socket.destroy();
        if (Date.now() >= deadline) {
          resolve(false);
          return;
        }
        setTimeout(attempt, 25);
      });
      socket.once('connect', () => {
        socket.destroy();
        resolve(true);
      });
    };
    attempt();
  });
}
