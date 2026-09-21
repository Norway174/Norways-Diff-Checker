const MiB = 1024 * 1024;

module.exports = {
  maxPathsPerRequest: 100,
  maxPathLength: 4096,
  maxInlineTextBytes: 64 * MiB,
  maxTextFileBytes: 512 * MiB,
  maxInputFileBytes: 512 * MiB,
  maxImagePixels: 250 * 1000 * 1000,
  maxCanvasPixels: 250 * 1000 * 1000,
  maxSpreadsheetRows: 100000,
  maxSpreadsheetColumns: 16384,
  maxSpreadsheetCells: 2 * 1000 * 1000,
  maxDocumentPages: 2000,
  maxArchiveEntries: 20000,
  maxArchiveExpandedBytes: 1024 * MiB,
  maxArchiveEntryBytes: 256 * MiB,
  maxFolderEntries: 250000,
  maxFolderDepth: 128,
  folderHashConcurrency: 4
};