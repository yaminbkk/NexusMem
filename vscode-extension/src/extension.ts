import * as vscode from 'vscode';
import { resolveStaleSuggestion, searchMemory, ServerNotFoundError, syncProject, type SearchMemoryResult } from './mcpClient.js';
import { renderResultsHtml } from './renderResults.js';
import { RecentMemoryProvider } from './recentMemoryView.js';
import { StaleReviewProvider } from './staleReviewView.js';
import type { StaleReviewRow } from './staleReviewRows.js';
import { shouldCheckFailure, shouldNotify, truncateForNotification } from './failureDetection.js';

function getCliPath(): string {
  return vscode.workspace.getConfiguration('nexusmem').get<string>('cliPath', 'nexusmem');
}

let outputChannel: vscode.OutputChannel | undefined;

export function activate(context: vscode.ExtensionContext): void {
  outputChannel = vscode.window.createOutputChannel('NexusMem');
  context.subscriptions.push(outputChannel);

  const recentMemory = new RecentMemoryProvider(getCliPath);
  context.subscriptions.push(vscode.window.registerTreeDataProvider('nexusmem.recentMemory', recentMemory));

  const staleReview = new StaleReviewProvider(getCliPath);
  context.subscriptions.push(vscode.window.registerTreeDataProvider('nexusmem.staleReview', staleReview));

  context.subscriptions.push(
    vscode.commands.registerCommand('nexusmem.searchMemory', (prefilledQuery?: string) => runSearchMemory(context, prefilledQuery)),
    vscode.commands.registerCommand('nexusmem.refreshRecentMemory', () => recentMemory.refresh()),
    vscode.commands.registerCommand('nexusmem.syncProject', () => runSyncProject(recentMemory)),
    vscode.commands.registerCommand('nexusmem.refreshStaleReview', () => staleReview.refresh()),
    vscode.commands.registerCommand('nexusmem.acceptStaleSuggestion', (row: StaleReviewRow) =>
      runResolveStaleSuggestion(row, 'accept', staleReview, recentMemory),
    ),
    vscode.commands.registerCommand('nexusmem.dismissStaleSuggestion', (row: StaleReviewRow) =>
      runResolveStaleSuggestion(row, 'dismiss', staleReview, recentMemory),
    ),
  );

  void recentMemory.refresh();
  void staleReview.refresh();
  registerLiveFailureDetection(context);
}

/**
 * Proactively checks a terminal command against NexusMem's memory right
 * when it fails, instead of waiting for the user to think to search --
 * Phase 7's "actually demonstrates the moat" surface, per the project's
 * roadmap.
 *
 * `vscode.window.onDidEndTerminalShellExecution` is stable API, but its
 * runtime availability still depends on the user's VS Code version and,
 * separately, on shell integration actually activating for their shell
 * (that part is genuinely unverified here -- no GUI in this environment to
 * confirm against a real PowerShell/bash/zsh session). The `typeof` guard
 * below means an older VS Code silently skips this feature rather than
 * crashing on activation; `engines.vscode` in package.json is deliberately
 * left at its existing floor rather than bumped, so every other feature
 * still installs there.
 */
function registerLiveFailureDetection(context: vscode.ExtensionContext): void {
  const enabled = vscode.workspace.getConfiguration('nexusmem').get<boolean>('liveFailureDetection.enabled', true);
  if (!enabled) return;
  if (typeof vscode.window.onDidEndTerminalShellExecution !== 'function') return;

  let checking = false;

  context.subscriptions.push(
    vscode.window.onDidEndTerminalShellExecution(async (event) => {
      if (checking) return; // one background check at a time -- a failing loop should not spawn N concurrent server processes

      const commandLine = event.execution.commandLine;
      if (!shouldCheckFailure({ exitCode: event.exitCode, commandLine: commandLine.value, confidence: commandLine.confidence })) {
        return;
      }

      const folder = vscode.workspace.workspaceFolders?.[0];
      if (!folder) return;

      checking = true;
      try {
        const result = await searchMemory({
          command: getCliPath(),
          projectRoot: folder.uri.fsPath,
          query: commandLine.value,
          budget: 500,
        });

        if (shouldNotify(result)) {
          const choice = await vscode.window.showInformationMessage(
            `NexusMem has seen "${truncateForNotification(commandLine.value)}" fail before.`,
            'Show details',
          );
          if (choice === 'Show details') {
            await vscode.commands.executeCommand('nexusmem.searchMemory', commandLine.value);
          }
        }
      } catch {
        // Best-effort background check: a spawn/connection failure here should not interrupt the
        // user's terminal with an error dialog every time a command happens to fail. Running
        // "NexusMem: Search Memory" directly still surfaces that failure clearly.
      } finally {
        checking = false;
      }
    }),
  );
}

export function deactivate(): void {}

async function runSearchMemory(context: vscode.ExtensionContext, prefilledQuery?: string): Promise<void> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    void vscode.window.showErrorMessage('NexusMem: open a folder or workspace first.');
    return;
  }

  const query =
    prefilledQuery ??
    (await vscode.window.showInputBox({
      prompt: 'Search NexusMem-remembered history for this repository',
      placeHolder: 'e.g. why did npm whoami fail',
    }));
  if (!query || query.trim().length === 0) return;

  const cliPath = getCliPath();

  try {
    const result = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `NexusMem: searching for "${query}"` },
      () => searchMemory({ command: cliPath, projectRoot: folder.uri.fsPath, query }),
    );

    showResultsPanel(context, query, result);
  } catch (error) {
    await reportServerError(cliPath, error, 'search');
  }
}

async function runSyncProject(recentMemory: RecentMemoryProvider): Promise<void> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    void vscode.window.showErrorMessage('NexusMem: open a folder or workspace first.');
    return;
  }

  const cliPath = getCliPath();

  try {
    const result = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'NexusMem: syncing memory' },
      () => syncProject({ command: cliPath, projectRoot: folder.uri.fsPath }),
    );

    outputChannel?.appendLine(`[${new Date().toLocaleTimeString()}] ${result.summary}`);
    const choice = await vscode.window.showInformationMessage('NexusMem: sync complete.', 'Show Output');
    if (choice === 'Show Output') {
      outputChannel?.show();
    }

    void recentMemory.refresh(); // a sync may have added nodes the sidebar hasn't seen yet
  } catch (error) {
    await reportServerError(cliPath, error, 'sync');
  }
}

/**
 * Backs the sidebar's inline accept/dismiss buttons (package.json's
 * `view/item/context` menu, keyed on `staleSuggestion`'s `contextValue`).
 * 'accept' writes the supersede link the same way `nexusmem mark-stale`
 * would; 'dismiss' only silences the suggestion. Either way, refresh the
 * review list so the row disappears -- and refresh recent-memory too on
 * accept, since that's the view whose ranking the supersede link affects.
 */
async function runResolveStaleSuggestion(
  row: StaleReviewRow,
  action: 'accept' | 'dismiss',
  staleReview: StaleReviewProvider,
  recentMemory: RecentMemoryProvider,
): Promise<void> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder || !row.suggestion) return;

  const cliPath = getCliPath();
  try {
    await resolveStaleSuggestion({
      command: cliPath,
      projectRoot: folder.uri.fsPath,
      candidateId: row.suggestion.candidateId,
      againstId: row.suggestion.againstId,
      action,
    });
    void staleReview.refresh();
    if (action === 'accept') void recentMemory.refresh();
  } catch (error) {
    await reportServerError(cliPath, error, action === 'accept' ? 'mark stale' : 'dismiss suggestion');
  }
}

async function reportServerError(cliPath: string, error: unknown, action: string): Promise<void> {
  if (error instanceof ServerNotFoundError) {
    const choice = await vscode.window.showErrorMessage(
      `${error.message} Install it with "npm install -g nexusmem", or point the nexusmem.cliPath setting (currently "${cliPath}") at an existing install.`,
      'Open Setting',
    );
    if (choice === 'Open Setting') {
      await vscode.commands.executeCommand('workbench.action.openSettings', 'nexusmem.cliPath');
    }
    return;
  }
  const message = error instanceof Error ? error.message : String(error);
  void vscode.window.showErrorMessage(`NexusMem ${action} failed: ${message}`);
}

let resultsPanel: vscode.WebviewPanel | undefined;

function showResultsPanel(context: vscode.ExtensionContext, query: string, result: SearchMemoryResult): void {
  if (resultsPanel) {
    resultsPanel.dispose();
  }

  const panel = vscode.window.createWebviewPanel('nexusmem.results', `NexusMem: ${query}`, vscode.ViewColumn.Beside, {
    enableScripts: false,
  });
  panel.webview.html = renderResultsHtml(query, result, panel.webview.cspSource);

  resultsPanel = panel;
  panel.onDidDispose(
    () => {
      if (resultsPanel === panel) resultsPanel = undefined;
    },
    undefined,
    context.subscriptions,
  );
}
