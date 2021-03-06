'use strict';

import * as vscode from 'vscode';
import * as path from 'path';

import { fileBundleSelection, repoBundleSelection, BundleSelection, parseNameOnly, localBundleSelection, promptBundleFile, bundleContent, suggestName } from './utils/bundleselection';
import { RepoBundle, RepoBundleRef, BundleManifest, LocalBundleRef, LocalBundle } from './duffle/duffle.objectmodel';
import { downloadZip, download, downloadProgressTracker, downloadWithCache } from './utils/download';
import { failed, Errorable } from './utils/errorable';
import { fs } from './utils/fs';
import { Cancellable, cancelled, accepted } from './utils/cancellable';
import { longRunning, longRunningWithProgress } from './utils/host';
import { cantHappen } from './utils/never';
import * as shell from './utils/shell';
import * as duffle from './duffle/duffle';
import { move } from 'fs-extra';
import { ExtensionFileCache } from './utils/cache';

const DUFFLE_VERSION = '0.3.1-beta.1';
const DUFFLE_BAG_VERSION = '0.3.4';
const DUFFLE_BAG_ZIP_LOCATION = `https://github.com/deislabs/duffle-bag/archive/${DUFFLE_BAG_VERSION}.zip`;

let DUFFLE_BINARIES_CACHE: ExtensionFileCache | null = null;

export function activate(context: vscode.ExtensionContext) {
    DUFFLE_BINARIES_CACHE = ExtensionFileCache.create(context, 'dufflebin');

    const disposables = [
        vscode.commands.registerCommand('dufflecoat.generate', generate)
    ];

    context.subscriptions.push(...disposables);
}

type Platform = 'windows' | 'darwin' | 'linux';
const PLATFORMS: Platform[] = ['windows', 'darwin', 'linux'];

async function generate(target?: any): Promise<void> {
    if (!target) {
        return await generatePrompted();
    }
    if (target.scheme) {
        return await generateFile(target as vscode.Uri);
    }
    if (target.bundleLocation === 'repo') {
        return await generateRepoBundle((target as RepoBundleRef).bundle);
    }
    if (target.bundleLocation === 'local') {
        return await generateLocalBundle((target as LocalBundleRef).bundle);
    }
    await vscode.window.showErrorMessage("Internal error: unexpected command target");
}

async function generatePrompted(): Promise<void> {
    const bundlePick = await promptBundleFile("Select the bundle to install");  // TODO: switch to promptLocalBundle

    if (!bundlePick) {
        return;
    }

    return await generateCore(bundlePick);
}

async function generateFile(file: vscode.Uri): Promise<void> {
    if (file.scheme !== 'file') {
        vscode.window.showErrorMessage("This command requires a filesystem bundle");
        return;
    }
    return await generateCore(fileBundleSelection(file));
}

async function generateRepoBundle(bundle: RepoBundle): Promise<void> {
    return await generateCore(repoBundleSelection(bundle));
}

async function generateLocalBundle(bundle: LocalBundle): Promise<void> {
    return await generateCore(localBundleSelection(bundle));
}

async function generateCore(bundlePick: BundleSelection): Promise<void> {
    const name = suggestName(bundlePick);

    const bundleInfo = await bundleContent(bundlePick);
    if (failed(bundleInfo)) {
        vscode.window.showErrorMessage(bundleInfo.error[0]);
        return;
    }

    const bundleKind = await promptBundleKind();
    if (!bundleKind) {
        return;
    }

    const parentFolders = await vscode.window.showOpenDialog({
        canSelectFiles: false,
        canSelectFolders: true,
        canSelectMany: false,
        openLabel: "Generate"
    });

    if (!parentFolders || parentFolders.length === 0) {
        return;
    }

    const parentFolder = parentFolders[0].fsPath;
    const suggestedFolder = path.join(parentFolder, name);

    const g = await getGenerationOption(suggestedFolder);
    if (g.cancelled) {
        return;
    }

    const { action, folder } = g.value;

    if (action === FolderAction.Overwrite) {
        try {
            await longRunning("Removing existing files...", () =>
                fs.remove(folder)
            );
        } catch (e) {
            await vscode.window.showErrorMessage(`Can't overwrite folder ${folder}: ${e}`);
            return;
        }
    }

    if (action === FolderAction.Overwrite || action === FolderAction.New) {
        const tempFolder = folder + '_tmp';
        const dl = await longRunning("Downloading self-installer template...", () =>
            downloadZip(DUFFLE_BAG_ZIP_LOCATION, tempFolder)
        );
        if (failed(dl)) {
            vscode.window.showErrorMessage(`Downloading self-installer template failed: ${dl.error[0]}`);
            return;
        }
        try {
            await move(path.join(tempFolder, `duffle-bag-${DUFFLE_BAG_VERSION}`), folder);
            await fs.remove(tempFolder);
        } catch (e) {
            vscode.window.showErrorMessage(`Unpacking self-installer template failed: ${e}`);
            return;
        }
    }

    const sb = await setBundle(g.value.folder, bundleInfo.result.manifest, bundleInfo.result.text, bundlePick, bundleKind === BundleKind.Full);
    if (failed(sb)) {
        vscode.window.showErrorMessage(sb.error[0]);
        return;
    }

    const dlbin = await longRunningWithProgress("Downloading Duffle binaries", (reportFunc) =>
        downloadDuffleBinaries(g.value.folder, reportFunc)
    );
    if (failed(dlbin)) {
        vscode.window.showErrorMessage(`Downloading Duffle binaries failed: ${dlbin.error[0]}`);
        return;
    }

    const commands = [
        {
            title: "Open in Code",
            onSelected: () => vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(folder), true)
        }, {
            title: "Open in Terminal",
            onSelected: () => vscode.window.createTerminal({ cwd: folder }).show()
        }
    ];
    const openAction = await vscode.window.showInformationMessage(`Your self-installer has been generated into ${folder}. Run 'npm install' followed by 'npm run dev' to test.`, ...commands);
    if (openAction) {
        openAction.onSelected();
    }
}

enum BundleKind {
    Full = 1,
    ManifestOnly
}

async function promptBundleKind(): Promise<BundleKind | undefined> {
    const kindOptions = [
        { label: 'Full bundle (include all images in installer)', resultValue: BundleKind.Full },
        { label: 'Manifest only (installer will pull images from registry)', resultValue: BundleKind.ManifestOnly },
    ];
    const pick = await vscode.window.showQuickPick(kindOptions);
    if (!pick) {
        return undefined;
    }
    return pick.resultValue;
}

async function updateJSONFile(filePath: string, fn: (json: any) => void): Promise<void> {
    const fileText = await fs.readFile(filePath, { encoding: 'utf8' });
    const json = JSON.parse(fileText);
    fn(json);
    await fs.writeFile(filePath, JSON.stringify(json, undefined, 2));
}

async function setBundle(folder: string, bundle: BundleManifest, bundleText: string, bundlePick: BundleSelection, wantFullBundle: boolean): Promise<Errorable<null>> {
    const signed = bundleText.startsWith('-');
    const siSignedBundleFile = path.join(folder, "data", "bundle.cnab");
    const siBundleManifest = path.join(folder, "data", "bundle.json");
    const siFullBundleFile = path.join(folder, "data", "bundle.tgz");
    const siRootPackageJSON = path.join(folder, "package.json");
    const siAppPackageJSON = path.join(folder, "app", "package.json");
    const siRootPackageLock = path.join(folder, "package-lock.json");
    const siAppPackageLock = path.join(folder, "app", "package-lock.json");
    const siAppHTML = path.join(folder, "app", "app.html");

    if (wantFullBundle) {
        const exportResult = await longRunning("Exporting required images...", () =>
            exportBundleTo(bundlePick, siFullBundleFile)
        );
        if (failed(exportResult)) {
            return { succeeded: false, error: [`Can't export full bundle file to self-installer: ${exportResult.error[0]}`] };
        }
    }

    try {
        await fs.writeFile(siBundleManifest, JSON.stringify(bundle, undefined, 2));
        if (signed) {
            await fs.writeFile(siSignedBundleFile, bundleText);
        }
    } catch (e) {
        return { succeeded: false, error: [`Can't write bundle file to self-installer: ${e}`] };
    }

    const packageName = `${safeName(bundle.name)}-cnab-self-installer`;
    const productName = `${bundle.name} CNAB Bundle Installer`;
    const description = `Self-installer for the ${bundle.name} CNAB bundle`;
    const authorName = process.env['USERNAME'] || process.env['USER'] || 'unknown';
    const authorEmail = `${authorName}@example.com`;

    try {
        await updateJSONFile(siAppPackageJSON, (appPackage) => {
            appPackage.name = packageName;
            appPackage.productName = productName;
            appPackage.description = description;
            appPackage.author.name = authorName;
            appPackage.author.email = authorEmail;
            delete appPackage.author.url;
        });
    } catch (e) {
        return { succeeded: false, error: [`Can't update self-installer's package.json: ${e}`] };
    }

    try {
        await updateJSONFile(siRootPackageJSON, (rootPackage) => {
            // TODO: deduplicate
            rootPackage.name = packageName;
            rootPackage.productName = productName;
            rootPackage.description = description;
            delete rootPackage.repository;
            rootPackage.author.name = authorName;
            rootPackage.author.email = authorEmail;
            delete rootPackage.author.url;
            rootPackage.build.productName = productName;
            rootPackage.build.appId = `com.microsoft.cnab.selfinstaller.${rootPackage.name}`;
            delete rootPackage.bugs.url;
            delete rootPackage.homepage;
        });
    } catch (e) {
        return { succeeded: false, error: [`Can't update self-installer's package.json: ${e}`] };
    }

    try {
        await updateJSONFile(siAppPackageLock, (lock) => {
            lock.name = packageName;
        });
    } catch (e) {
        return { succeeded: false, error: [`Can't update self-installer's package-lock.json: ${e}`] };
    }

    try {
        await updateJSONFile(siRootPackageLock, (lock) => {
            lock.name = packageName;
        });
    } catch (e) {
        return { succeeded: false, error: [`Can't update self-installer's package-lock.json: ${e}`] };
    }

    try {
        const html = await fs.readFile(siAppHTML, { encoding: 'utf8' });
        const fixedHTML = html.replace('<title>Duffle Bag</title>', `<title>Install ${bundle.name}</title>`);
        await fs.writeFile(siAppHTML, fixedHTML);
    } catch (e) {
        return { succeeded: false, error: [`Can't update self-installer's window title: ${e}`] };
    }

    return { succeeded: true, result: null };
}

async function exportBundleTo(bundlePick: BundleSelection, outputFile: string): Promise<Errorable<null>> {
    if (bundlePick.kind === 'file') {
        return await duffle.exportFile(shell.shell, bundlePick.path, outputFile, true);
    }
    if (bundlePick.kind === 'local' || bundlePick.kind === 'repo') {
        return await duffle.exportBundle(shell.shell, bundlePick.bundle, outputFile, true);
    }
    return cantHappen(bundlePick);
}

async function downloadDuffleBinaries(targetFolder: string, progressReporter: (msg: string) => void): Promise<Errorable<null>> {
    const dufflebinBasePath = path.join(targetFolder, 'dufflebin');
    const progressFunc = downloadProgressTracker(progressReporter);
    const dltasks = PLATFORMS.map((p) => downloadDuffleBinary(dufflebinBasePath, p, progressFunc));
    const dlresults = await Promise.all(dltasks);
    const firstFail = dlresults.find((r) => failed(r));
    if (firstFail) {
        return firstFail;
    }
    return { succeeded: true, result: null };
}

function dufflebinPlatformPath(basePath: string, platform: Platform) {
    return path.join(basePath, `${platform}-amd64`);
}

async function downloadDuffleBinary(dufflebinBasePath: string, platform: Platform, progressFunc: (bytes: number) => void): Promise<Errorable<null>> {
    const suffix = platform === 'windows' ? '.exe' : '';
    const source = `https://github.com/deislabs/duffle/releases/download/${DUFFLE_VERSION}/duffle-${platform}-amd64${suffix}`;
    const destinationDir = dufflebinPlatformPath(dufflebinBasePath, platform);
    const destinationFile = 'duffle' + suffix;
    const destination = path.join(destinationDir, destinationFile);
    if (DUFFLE_BINARIES_CACHE) {  // which should always exist
        const cacheKey = `${DUFFLE_VERSION}-${platform}-${destinationFile}`;
        return await downloadWithCache(DUFFLE_BINARIES_CACHE, cacheKey, source, destination, progressFunc);
    } else {
        return await download(source, destination, progressFunc);
    }
}

enum FolderAction { New, Overwrite, Update }

interface GenerateInto {
    readonly action: FolderAction;
    readonly folder: string;
}

async function getGenerationOption(targetFolder: string): Promise<Cancellable<GenerateInto>> {
    if (!await fs.exists(targetFolder)) {
        return accepted({ action: FolderAction.New, folder: targetFolder });
    }

    const alreadyExistsCommands = [
        {
            title: "Update Bundle Only",
            onSelected: async () => accepted({ action: FolderAction.Update, folder: targetFolder })
        },
        {
            title: "Overwrite Folder",
            onSelected: async () => accepted({ action: FolderAction.Overwrite, folder: targetFolder })
        },
        {
            title: "Use Different Folder",
            onSelected: async () => {
                const parentFolder = path.dirname(targetFolder);
                const subfolder = await vscode.window.showInputBox({ prompt: `Generate into folder (under ${parentFolder})...` });
                if (!subfolder) {
                    return cancelled;
                }
                return await getGenerationOption(path.join(parentFolder, subfolder));
            }
        }
    ];

    const selection = await vscode.window.showWarningMessage(`Folder ${targetFolder} already exists`, ...alreadyExistsCommands);
    if (!selection) {
        return { cancelled: true };
    }
    return await selection.onSelected();
}

const GENERATE_NAME_ILLEGAL_CHARACTERS = /[^A-Za-z0-9_-]/g;

function safeName(bundleName: string): string {
    const baseName = parseNameOnly(bundleName);
    return baseName.replace(GENERATE_NAME_ILLEGAL_CHARACTERS, '-');
}
