import * as vscode from 'vscode';
import { listStaleSuggestions } from './mcpClient.js';
import { rowsForState, type StaleReviewRow, type StaleReviewState } from './staleReviewRows.js';

const STALE_SUGGESTIONS_LIMIT = 50;

/**
 * Thin `vscode.TreeDataProvider` adapter over `rowsForState`, same split
 * `RecentMemoryProvider` draws -- row content/ordering lives there, tested
 * without a `vscode` import; this class only owns load state and the
 * `TreeItem`/`ThemeIcon`/`contextValue` mapping the accept/dismiss inline
 * buttons key off.
 */
export class StaleReviewProvider implements vscode.TreeDataProvider<StaleReviewRow> {
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changeEmitter.event;

  private state: StaleReviewState = { kind: 'loading' };

  constructor(private readonly resolveCliPath: () => string) {}

  async refresh(): Promise<void> {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      this.state = { kind: 'no-workspace' };
      this.changeEmitter.fire();
      return;
    }

    this.state = { kind: 'loading' };
    this.changeEmitter.fire();

    try {
      const items = await listStaleSuggestions({
        command: this.resolveCliPath(),
        projectRoot: folder.uri.fsPath,
        limit: STALE_SUGGESTIONS_LIMIT,
      });
      this.state = { kind: 'items', items };
    } catch (error) {
      this.state = { kind: 'error', message: error instanceof Error ? error.message : String(error) };
    }

    this.changeEmitter.fire();
  }

  getTreeItem(row: StaleReviewRow): vscode.TreeItem {
    const treeItem = new vscode.TreeItem(row.label, vscode.TreeItemCollapsibleState.None);
    treeItem.id = row.id;
    treeItem.description = row.description;
    treeItem.tooltip = row.tooltip;
    treeItem.iconPath = new vscode.ThemeIcon(row.iconId);
    treeItem.contextValue = row.contextValue;
    return treeItem;
  }

  getChildren(row?: StaleReviewRow): StaleReviewRow[] {
    if (row) return []; // flat list, no nesting
    return rowsForState(this.state);
  }
}
