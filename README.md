# Norways Diff Checker

A free, open sourced and fully offline & local Diff Checker. Supporting Images, Text, Documents and even Folder comparisons.

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
- **Folders:** recursive path, metadata, and content-hash comparison, glob exclusions, filters, search, and opening matched file pairs in tabs. Folder sources are read only.

The Welcome chooser opens by default; Settings can restore the previous tabs instead. Drag and drop and Windows Open With populate tabs. Three or more inputs open a pairing chooser. Project files contain snapshots and options; folder projects keep their root paths and scan manifest.

Settings can also add **Compare this file** and **Compare this folder** to Windows Explorer. A cold launch creates a new comparison. An already-running app checks the selected tab in each window, fills a compatible selected tab that has exactly one side populated, or creates a new tab of the input's specific type when no selected tab qualifies.

## App data

The app creates `%LOCALAPPDATA%\NorwaysDiffChecker` on launch and uses it directly for `preferences.json`, `projects`, Electron user data, and `cache`.

## Download

Download [NorwaysDiffCheckerInstaller.exe](https://github.com/Norway174/Norways-Diff-Checker/raw/refs/heads/main/installer/NorwaysDiffCheckerInstaller.exe), then run it to install, update, repair, or uninstall the app. The executable uses the same icon as the application.

The installer checks for Git, Node.js, and npm together. When any are missing, it lists everything required and offers three choices:

- Install the missing tools from the official [Git for Windows](https://git-scm.com/download/win) and [Node.js](https://nodejs.org/en/download) websites, then re-check.
- Download verified portable copies into the app folder without changing the system PATH.
- Cancel the installation.

The source checkout and complete packaged Electron app are built locally under:

```text
%LOCALAPPDATA%\NorwaysDiffChecker\app
```

The installer creates a stable launcher at:

```text
%LOCALAPPDATA%\NorwaysDiffChecker\Norways Diff Checker.exe
```

Start Menu and Desktop shortcuts can be created for this launcher. Preferences and projects remain directly under `%LOCALAPPDATA%\NorwaysDiffChecker` so updates and repairs do not replace them.

Updates fetch the latest `main` commit and rebuild the packaged app. If the checkout contains local modifications or commits, the installer stops and offers a normal pull, a confirmed reset to `origin/main`, or cancellation. Because this installs the latest development commit rather than a versioned release, an occasional commit may be less stable than a tagged build.

Building Electron and native modules requires a sizeable download and temporary disk space. LibreOffice is not bundled with the application; users who need rendered Word or presentation pages can download or delete the optional dependency from Settings. The app shows its download and installed size there.

To run the project directly for development instead, install Git and Node.js with npm, then use:

```powershell
git clone https://github.com/Norway174/Norways-Diff-Checker.git
cd "Norways Diff Checker"
npm ci
npm run start
```

To rebuild the installer executable after changing its batch/PowerShell source or the app icon, run:

```powershell
npm run build:installer
```
