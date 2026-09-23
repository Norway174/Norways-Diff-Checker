<p align="center">
	<img src="assets/app-icon.png" alt="Norways Diff Checker app icon" width="128">
</p>

# Norways Diff Checker

A free, open sourced and fully offline & local Diff Checker. Supporting Images, Text, Documents and Folder comparisons.

## App preview

<table>
	<tr>
		<td width="50%">
			<img src="assets/app-preview/comparison-type-chooser.png" alt="Chooser for text, image, document, spreadsheet, and folder comparisons">
			<br><strong>Comparison chooser</strong> - Start a new comparison or reopen a recent pair.
		</td>
		<td width="50%">
			<img src="assets/app-preview/text-comparison-results.png" alt="Side-by-side text comparison with highlighted changes">
			<br><strong>Text comparison</strong> - Review changes side by side and accept either version.
		</td>
	</tr>
	<tr>
		<td width="50%">
			<img src="assets/app-preview/image-comparison-split-view.png" alt="Split image comparison with pixel comparison controls">
			<br><strong>Image comparison</strong> - Inspect images in a split view with threshold controls.
		</td>
		<td width="50%">
			<img src="assets/app-preview/text-comparison-empty.png" alt="Empty text comparison workspace ready for two inputs">
			<br><strong>Text workspace</strong> - Paste text or browse for files on either side.
		</td>
	</tr>
</table>

## Comparison workspace

- **Text:** pasted or file-backed text and code, side-by-side or unified diff, word and character precision, syntax highlighting, edits, change navigation and acceptance, ignore rules, and PDF/merged-text export.
- **Images:** JPG, PNG, WebP, GIF, HEIC, and PDF pages, multiple overlay views, pixel threshold and region grouping, manual and automatic alignment, perspective adjustment, OCR, EXIF details, scan presets, and PNG export.
- **Documents:** DOCX, PDF, and PPTX pairs, extracted and rendered views, scanned-page and embedded-image OCR, text and structure changes, PDF page ordering, password-protected PDFs, redline decisions, and PDF/DOCX exports.
- **Excel:** XLSX, XLS, CSV, TSV, and ODS pairs, sheet and formula modes, inserted row and column alignment, sorting, date normalization, redline and multi-pane views, PDF and XLSX exports.
- **Folders:** recursive path, metadata, and content-hash comparison, glob exclusions, filters, search, and opening matched file pairs in tabs.

The Welcome chooser opens by default; Settings can restore the previous tabs instead. Drag and drop and Windows Open With populate tabs. Three or more inputs open a pairing chooser. Project files contain snapshots and options; folder projects keep their root paths and scan manifest.

Settings can also add **Compare this file** and **Compare this folder** to Windows Explorer. A cold launch creates a new comparison. An already-running app checks the selected tab in each window, fills a compatible selected tab that has exactly one side populated, or creates a new tab of the input's specific type when no selected tab qualifies.

## Download

Download the latest installer or portable app from the [GitHub Releases page](https://github.com/Norway174/Norways-Diff-Checker/releases).

## Issues

Found a bug or have a feature request? Please post it on the [GitHub Issues page](https://github.com/Norway174/Norways-Diff-Checker/issues).

## Optional dependencies

PDFium, OCR models, and LibreOffice are separate optional downloads in Settings. PDFium is needed for PDF rendering and text extraction; OCR models are needed for image and scanned-page text recognition; LibreOffice is needed for rendered Word and presentation pages. Downloaded dependencies stay in the app data folder and work offline afterward.

The optional PDFium library comes from [pdfium-binaries](https://github.com/bblanchon/pdfium-binaries) and retains its license in `src-tauri/binaries/PDFIUM-LICENSE`. The optional OCR models come from [ocrs](https://github.com/robertknight/ocrs) under CC BY-SA 4.0; see `src-tauri/models/LICENSE.md`.

The app can automatically download & install these dependencies with one click. Options for this can be found in the app settings.

## Developers

The desktop shell and comparison engine use Rust and Tauri 2, with a React interface. On Windows, install the Rust MSVC toolchain, Microsoft C++ Build Tools, WebView2, and Node.js with npm.

Install dependencies and start the development app:

```powershell
npm ci
npm run start
```

Build the portable executable locally:

```powershell
npm run build:app
```

The executable is written to `src-tauri/target/release`.

### App data

The default install and data folder is `%LOCALAPPDATA%\NorwaysDiffChecker`, with the self-contained application executable and `preferences.json` directly in that folder. The installer can use any location and records that root in `HKCU\Software\NorwaysDiffChecker\AppPath`. On startup, the app looks for settings beside its executable and one folder above it, then uses the registered install root, then checks the default Local AppData root. If none exists, it creates settings beside the executable, which lets a portable copy run from any folder.
