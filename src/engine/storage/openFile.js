/**
 * CollabWrite - Race-free file open helper.
 *
 * The obvious way to open a file for read and write, creating it if absent,
 * is to test for it first:
 *
 *     fs.openSync(file, fs.existsSync(file) ? 'r+' : 'w+')
 *
 * That is a time-of-check to time-of-use race. Between the check and the
 * open, another process can create the file, and `w+` then truncates it to
 * zero bytes. For `documents.dat` that destroys every document; for
 * `wal.log` it destroys the only record of what was committed.
 *
 * Asking the operating system to do both in one step removes the window:
 * attempt `r+`, and create the file only on an explicit ENOENT.
 */

'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Opens a file for reading and writing, creating it if it does not exist,
 * without a check-then-open race.
 *
 * @param {string} file - Absolute path.
 * @returns {number} The file descriptor.
 */
function openReadWrite(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  try {
    return fs.openSync(file, 'r+');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    // 'wx+' fails rather than truncating if someone created the file in the
    // meantime; in that case the file now exists, so 'r+' succeeds.
    try {
      return fs.openSync(file, 'wx+');
    } catch (raceError) {
      if (raceError.code !== 'EEXIST') throw raceError;
      return fs.openSync(file, 'r+');
    }
  }
}

module.exports = { openReadWrite };
