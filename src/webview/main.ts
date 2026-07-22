import './styles/main.css';
import { WorkbenchApp, type WebviewApi } from './app.js';

interface WebviewGlobal {
  readonly acquireVsCodeApi?: () => WebviewApi;
}

const webviewGlobal = globalThis as typeof globalThis & WebviewGlobal;
const root =
  document.querySelector<HTMLElement>('[data-okf-workbench-root]') ??
  document.body.appendChild(document.createElement('div'));
root.dataset.okfWorkbenchRoot = '';

const api = webviewGlobal.acquireVsCodeApi?.() ?? {
  postMessage: () => undefined,
};

new WorkbenchApp(root, api);
