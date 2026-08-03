function yamlString(value: string): string {
  return JSON.stringify(value);
}

export interface TemplateFrontmatter {
  readonly type: string;
  readonly title: string;
  readonly description?: string;
  readonly tags: readonly string[];
  readonly timestamp?: string;
  readonly runtime?: string;
}

/** Renders the intentionally small, deterministic subset used by built-in templates. */
export function renderTemplateFrontmatter(frontmatter: TemplateFrontmatter): string {
  const lines = [
    '---',
    `type: ${yamlString(frontmatter.type)}`,
    `title: ${yamlString(frontmatter.title)}`,
  ];

  if (frontmatter.description !== undefined && frontmatter.description.trim().length > 0) {
    lines.push(`description: ${yamlString(frontmatter.description)}`);
  }

  if (frontmatter.tags.length > 0) {
    lines.push('tags:');
    for (const tag of frontmatter.tags) {
      lines.push(`  - ${yamlString(tag)}`);
    }
  }

  if (frontmatter.timestamp !== undefined) {
    lines.push('generated:');
    lines.push('  by: "process:okf-workbench"');
    lines.push(`  at: ${yamlString(frontmatter.timestamp)}`);
  }

  if (frontmatter.runtime !== undefined) {
    lines.push(`runtime: ${yamlString(frontmatter.runtime)}`);
  }

  lines.push('---');
  return `${lines.join('\n')}\n`;
}
