export function createElement<K extends keyof HTMLElementTagNameMap>(
  tagName: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tagName);
  if (className !== undefined) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

export function appendTextDefinition(list: HTMLDListElement, term: string, value: string): void {
  list.append(createElement('dt', undefined, term), createElement('dd', undefined, value));
}
