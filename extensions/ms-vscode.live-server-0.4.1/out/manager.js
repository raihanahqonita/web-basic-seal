"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Manager = void 0;
const dispose_1 = require("./utils/dispose");
const vscode = require("vscode");
const pathUtil_1 = require("./utils/pathUtil");
const connectionManager_1 = require("./connectionInfo/connectionManager");
const browserPreview_1 = require("./editorPreview/browserPreview");
const settingsUtil_1 = require("./utils/settingsUtil");
const nls = require("vscode-nls");
const serverTaskProvider_1 = require("./task/serverTaskProvider");
const endpointManager_1 = require("./infoManagers/endpointManager");
const previewManager_1 = require("./editorPreview/previewManager");
const fs_1 = require("fs");
const statusBarNotifier_1 = require("./server/serverUtils/statusBarNotifier");
const constants_1 = require("./utils/constants");
const serverGrouping_1 = require("./server/serverGrouping");
const localize = nls.loadMessageBundle();
/**
 * This object re-serializes the webview after a reload
 */
class PanelSerializer extends dispose_1.Disposable {
    constructor() {
        super(...arguments);
        this._onShouldRevive = this._register(new vscode.EventEmitter());
        this.onShouldRevive = this._onShouldRevive.event;
    }
    deserializeWebviewPanel(webviewPanel, state) {
        // fire event to parent, since all info needed to re-open a panel is in the parent
        this._onShouldRevive.fire({ webviewPanel, state });
        return Promise.resolve();
    }
}
/**
 * `Manager` is a singleton instance that managers all of the servers, the previews, connection info, etc.
 * It also facilitates opening files (sometimes by calling `PreviewManager`) and starting the associated servers.
 */
class Manager extends dispose_1.Disposable {
    constructor(_extensionUri, _reporter, _userDataDir) {
        super();
        this._extensionUri = _extensionUri;
        this._reporter = _reporter;
        this._userDataDir = _userDataDir;
        this._serverGroupings = new Map();
        this._connectionManager = this._register(new connectionManager_1.ConnectionManager());
        this._register(this._connectionManager.onConnected((e) => {
            var _a;
            this._statusBar.setServer((_a = e.workspace) === null || _a === void 0 ? void 0 : _a.uri, e.httpPort);
            vscode.commands.executeCommand('setContext', constants_1.LIVE_PREVIEW_SERVER_ON, true);
        }));
        this._endpointManager = this._register(new endpointManager_1.EndpointManager());
        this._previewManager = this._register(new previewManager_1.PreviewManager(this._extensionUri, this._reporter, this._connectionManager, this._endpointManager, () => {
            var _a;
            if (this._hasServerRunning() &&
                !this._serverTaskProvider.isRunning &&
                vscode.workspace.workspaceFolders &&
                ((_a = vscode.workspace.workspaceFolders) === null || _a === void 0 ? void 0 : _a.length) > 0 &&
                this._serverTaskProvider.runTaskWithExternalPreview) {
                this.closeServers();
            }
        }));
        this._statusBar = this._register(new statusBarNotifier_1.StatusBarNotifier());
        this._serverTaskProvider = this._register(new serverTaskProvider_1.ServerTaskProvider(this._reporter, this._endpointManager, this._connectionManager));
        this._register(vscode.tasks.registerTaskProvider(serverTaskProvider_1.ServerTaskProvider.CustomBuildScriptType, this._serverTaskProvider));
        this._register(this._serverTaskProvider.onRequestOpenEditorToSide((uri) => {
            var _a;
            if (this._previewManager.previewActive &&
                this._previewManager.currentPanel) {
                const avoidColumn = (_a = this._previewManager.currentPanel.panel.viewColumn) !== null && _a !== void 0 ? _a : vscode.ViewColumn.One;
                const column = avoidColumn == vscode.ViewColumn.One
                    ? avoidColumn + 1
                    : avoidColumn - 1;
                vscode.commands.executeCommand('vscode.open', uri, {
                    viewColumn: column,
                });
            }
            else {
                vscode.commands.executeCommand('vscode.open', uri);
            }
        }));
        this._register(this._serverTaskProvider.onRequestToOpenServer(async (workspace) => {
            const serverGrouping = this._getServerGroupingFromWorkspace(workspace);
            // running this with `fromTask = true` will still inform the task if the server is already open
            await serverGrouping.openServer(true);
        }));
        this._register(this._serverTaskProvider.onRequestToCloseServer((workspace) => {
            if (this._previewManager.previewActive) {
                this._serverTaskProvider.serverStop(false, workspace);
            }
            else {
                const serverGrouping = this._serverGroupings.get(workspace === null || workspace === void 0 ? void 0 : workspace.uri.toString());
                // closeServer will call `this._serverTaskProvider.serverStop(true, workspace);`
                serverGrouping === null || serverGrouping === void 0 ? void 0 : serverGrouping.closeServer();
            }
        }));
        const serializer = this._register(new PanelSerializer());
        this._register(serializer.onShouldRevive((e) => {
            var _a;
            let relative = false;
            let file = (_a = e.state.currentAddress) !== null && _a !== void 0 ? _a : '/';
            let workspace = pathUtil_1.PathUtil.PathExistsRelativeToAnyWorkspace(file);
            if (workspace) {
                relative = true;
            }
            else {
                // path isn't relative to workspaces, try checking absolute path for workspace
                workspace = pathUtil_1.PathUtil.AbsPathInAnyWorkspace(file);
            }
            if (!workspace) {
                // no workspace; try to decode endpoint to fix file
                file = this._endpointManager.decodeLooseFileEndpoint(file);
                if (!file) {
                    e.webviewPanel.dispose();
                    return;
                }
            }
            // loose file workspace will be fetched if workspace is still undefined
            const grouping = this._getServerGroupingFromWorkspace(workspace);
            grouping.createOrShowEmbeddedPreview(e.webviewPanel, file, relative);
            e.webviewPanel.webview.options =
                this._previewManager.getWebviewOptions();
        }));
        if (vscode.window.registerWebviewPanelSerializer) {
            this._register(vscode.window.registerWebviewPanelSerializer(browserPreview_1.BrowserPreview.viewType, serializer));
        }
        this._register(vscode.workspace.onDidChangeWorkspaceFolders((e) => {
            if (e.removed) {
                e.removed.forEach((workspace) => {
                    const potentialGrouping = this._serverGroupings.get(workspace.uri.toString());
                    if (potentialGrouping) {
                        potentialGrouping.closeServer();
                    }
                });
            }
            // known bug: transitioning between 1 and 2 workspaces: https://github.com/microsoft/vscode/issues/128138
        }));
        this._register(this._serverTaskProvider.onShouldLaunchPreview((e) => this.openPreviewAtFile(e.file, e.options, e.previewType)));
        this._register(this._previewManager.onShouldLaunchPreview((e) => this.openPreviewAtFile(e.file, e.options, e.previewType)));
    }
    /**
     * handles opening a file
     * @param internal whether to launch an embedded preview
     * @param file the uri or string filePath to use
     * @param fileStringRelative whether the path is relative
     * @param debug whether to launch in debug
     * @param workspace the workspace to launch the file from
     * @param port the port to derive the workspace from
     * @param serverGrouping the serverGrouping that manages the server workspace
     */
    async handleOpenFile(internal, file, fileStringRelative, debug, workspace, port, serverGrouping) {
        const fileInfo = this._getFileInfo(file, fileStringRelative);
        if (!serverGrouping) {
            if (workspace) {
                serverGrouping = this._getServerGroupingFromWorkspace(workspace);
            }
            else if (port) {
                this._serverGroupings.forEach((potentialServerGrouping, key) => {
                    if (potentialServerGrouping.port === port) {
                        serverGrouping = potentialServerGrouping;
                        return;
                    }
                });
            }
            else {
                if (fileInfo.isRelative) {
                    workspace = pathUtil_1.PathUtil.PathExistsRelativeToAnyWorkspace(fileInfo.filePath);
                }
                else {
                    workspace = pathUtil_1.PathUtil.AbsPathInAnyWorkspace(fileInfo.filePath);
                }
                serverGrouping = this._getServerGroupingFromWorkspace(workspace);
            }
        }
        if (!serverGrouping) {
            // last-resort: use loose workspace server.
            serverGrouping = this._getServerGroupingFromWorkspace(undefined);
        }
        return await this._openPreview(internal, fileInfo.filePath, serverGrouping, fileInfo.isRelative, debug);
    }
    /**
     * Close all servers
     */
    closeServers() {
        this._serverGroupings.forEach((serverGrouping) => {
            serverGrouping.closeServer();
            serverGrouping.dispose();
        });
    }
    dispose() {
        this.closeServers();
        super.dispose();
    }
    closePanel() {
        var _a;
        (_a = this._previewManager.currentPanel) === null || _a === void 0 ? void 0 : _a.close();
    }
    /**
     * Using only a string path (unknown if relative or absolute), launch the preview or launch an error.
     * This is usually used for when the user configures a setting for initial filepath
     * @param filePath the string fsPath to use
     */
    openTargetAtFile(filePath) {
        if (filePath === '') {
            this._openNoTarget();
            return;
        }
        let foundPath = false;
        this._serverGroupings.forEach((serverGrouping) => {
            if (serverGrouping.pathExistsRelativeToWorkspace(filePath)) {
                this.openPreviewAtFile(filePath, {
                    relativeFileString: true,
                    manager: serverGrouping,
                    workspace: serverGrouping.workspace,
                });
                foundPath = true;
                return;
            }
        });
        if (foundPath) {
            return;
        }
        if (fs_1.existsSync(filePath)) {
            this.openPreviewAtFile(filePath, { relativeFileString: false });
        }
        else {
            vscode.window.showWarningMessage(localize('fileDNE', "The file '{0}' does not exist.", filePath));
            this.openPreviewAtFile('/', { relativeFileString: true });
        }
    }
    async openPreviewAtFile(file, options, previewType) {
        var _a;
        if (!previewType) {
            previewType = settingsUtil_1.SettingUtil.GetPreviewType();
        }
        const internal = previewType === settingsUtil_1.PreviewType.internalPreview;
        const debug = previewType === settingsUtil_1.PreviewType.externalDebugPreview;
        return this.handleOpenFile(internal, file, (_a = options === null || options === void 0 ? void 0 : options.relativeFileString) !== null && _a !== void 0 ? _a : false, debug, options === null || options === void 0 ? void 0 : options.workspace, options === null || options === void 0 ? void 0 : options.port, options === null || options === void 0 ? void 0 : options.manager);
    }
    /**
     * Creates a serverGrouping and connection object for a workspace if it doesn't already have an existing one.
     * Otherwise, return the existing serverGrouping.
     * @param workspace
     * @returns serverGrouping for this workspace (or, when `workspace == undefined`, the serverGrouping for the loose file workspace)
     */
    _getServerGroupingFromWorkspace(workspace) {
        let serverGrouping = this._serverGroupings.get(workspace === null || workspace === void 0 ? void 0 : workspace.uri.toString());
        if (!serverGrouping) {
            const connection = this._connectionManager.createAndAddNewConnection(workspace);
            serverGrouping = this._register(new serverGrouping_1.ServerGrouping(this._extensionUri, this._reporter, this._endpointManager, connection, this._serverTaskProvider, this._userDataDir));
            this._register(serverGrouping.onClose(() => {
                var _a;
                if (this._previewManager.currentPanel &&
                    this._previewManager.currentPanel.currentConnection === connection) {
                    // close the preview if it is showing this server's content
                    (_a = this._previewManager.currentPanel) === null || _a === void 0 ? void 0 : _a.close();
                }
                this._statusBar.removeServer(workspace === null || workspace === void 0 ? void 0 : workspace.uri);
                this._serverGroupings.delete(workspace === null || workspace === void 0 ? void 0 : workspace.uri.toString());
                if (this._serverGroupings.size === 0) {
                    this._statusBar.serverOff();
                    vscode.commands.executeCommand('setContext', constants_1.LIVE_PREVIEW_SERVER_ON, false);
                }
                this._connectionManager.removeConnection(workspace);
            }));
            this._register(serverGrouping.onShouldLaunchEmbeddedPreview((e) => this._previewManager.launchFileInEmbeddedPreview(e.file, e.relative, e.panel, e.connection)));
            this._register(serverGrouping.onShouldLaunchExternalPreview((e) => this._previewManager.launchFileInExternalBrowser(e.file, e.relative, e.debug, e.connection)));
            this._serverGroupings.set(workspace === null || workspace === void 0 ? void 0 : workspace.uri.toString(), serverGrouping);
        }
        return serverGrouping;
    }
    async _openPreview(internal, file, serverGrouping, isRelative, debug = false) {
        if (internal) {
            // for now, ignore debug or no debug for embedded preview
            serverGrouping.createOrShowEmbeddedPreview(undefined, file, isRelative);
        }
        else {
            await serverGrouping.showPreviewInBrowser(file, isRelative, debug);
        }
    }
    _getFileInfo(file, fileStringRelative) {
        var _a, _b;
        if (typeof file == 'string') {
            return { filePath: file, isRelative: fileStringRelative };
        }
        else if (file instanceof vscode.Uri) {
            let filePath = file === null || file === void 0 ? void 0 : file.fsPath;
            if (!filePath) {
                const activeFilePath = (_a = vscode.window.activeTextEditor) === null || _a === void 0 ? void 0 : _a.document.fileName;
                if (activeFilePath) {
                    filePath = activeFilePath;
                    fileStringRelative = false;
                }
            }
            return { filePath, isRelative: fileStringRelative };
        }
        else {
            const activeFilePath = (_b = vscode.window.activeTextEditor) === null || _b === void 0 ? void 0 : _b.document.fileName;
            if (activeFilePath) {
                return { filePath: activeFilePath, isRelative: false };
            }
        }
        return { filePath: '/', isRelative: fileStringRelative };
    }
    _hasServerRunning() {
        const isRunning = Array.from(this._serverGroupings.values()).filter((group) => group.running);
        return isRunning.length !== 0;
    }
    _openNoTarget() {
        // opens index at first open server or opens a loose workspace at root
        const workspaces = vscode.workspace.workspaceFolders;
        if (workspaces && workspaces.length > 0) {
            for (let i = 0; i < workspaces.length; i++) {
                const currWorkspace = workspaces[i];
                const manager = this._serverGroupings.get(currWorkspace.uri.toString());
                if (manager) {
                    this.openPreviewAtFile('/', {
                        relativeFileString: true,
                        workspace: currWorkspace,
                        manager: manager,
                    });
                    return;
                }
            }
            this.openPreviewAtFile('/', {
                relativeFileString: true,
                workspace: workspaces[0],
            });
        }
        else {
            this.openPreviewAtFile('/', { relativeFileString: false });
        }
    }
}
exports.Manager = Manager;
//# sourceMappingURL=manager.js.map