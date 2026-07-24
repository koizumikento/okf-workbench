import * as vscode from 'vscode';

import type { CommandUi, ConfirmationOptions, SelectionItem, TextInputOptions } from './types.js';

export function proposalConfirmationMessage(options: ConfirmationOptions): string {
  const cancelLabel = 'Cancel';
  const identity = options.previewIdentity;
  const detail = options.detail.replace(/\s+/gu, ' ').trim();
  return `${identity.label}: ${options.title}. Target: ${identity.targetUri}. ${detail} Review the tabs with this exact preview identity, then choose ${options.confirmLabel} or ${cancelLabel}.`;
}

export class VscodeCommandUi implements CommandUi<vscode.Uri> {
  async select<TValue extends string>(
    title: string,
    placeHolder: string,
    items: readonly SelectionItem<TValue>[],
  ): Promise<TValue | undefined> {
    const selected = await vscode.window.showQuickPick(
      items.map((item) => ({
        label: item.label,
        value: item.value,
        ...(item.description === undefined ? {} : { description: item.description }),
        ...(item.detail === undefined ? {} : { detail: item.detail }),
      })),
      { title, placeHolder, ignoreFocusOut: true },
    );
    return selected?.value;
  }

  async input(options: TextInputOptions): Promise<string | undefined> {
    return await vscode.window.showInputBox({
      title: options.title,
      prompt: options.prompt,
      ignoreFocusOut: true,
      ...(options.value === undefined ? {} : { value: options.value }),
      ...(options.placeHolder === undefined ? {} : { placeHolder: options.placeHolder }),
      ...(options.validate === undefined ? {} : { validateInput: options.validate }),
    });
  }

  async confirm(options: ConfirmationOptions): Promise<boolean> {
    const cancelLabel = 'Cancel';
    const selected = await vscode.window.showWarningMessage(
      proposalConfirmationMessage(options),
      { modal: false },
      options.confirmLabel,
      cancelLabel,
    );
    return selected === options.confirmLabel;
  }

  async showInformation(message: string): Promise<void> {
    await vscode.window.showInformationMessage(message);
  }

  async showWarning(message: string): Promise<void> {
    await vscode.window.showWarningMessage(message);
  }

  async showError(message: string): Promise<void> {
    await vscode.window.showErrorMessage(message, { modal: true });
  }

  async openDocument(uri: vscode.Uri): Promise<void> {
    const document = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(document, { preview: false });
  }
}
