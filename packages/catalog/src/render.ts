import type { ServiceManifest } from './manifest';

export type TemplateVars = Record<string, string | number | boolean>;

const NAME = '[A-Z][A-Z0-9_]*';
// A space is allowed so a value can hold a list. Templates must quote any value that may contain one.
const SAFE_VALUE = /^[A-Za-z0-9_.:/@+ -]*$/;
const IF_BLOCK = new RegExp(
  `^[ \\t]*\\{\\{#if (${NAME})\\}\\}[ \\t]*\\n([\\s\\S]*?)^[ \\t]*\\{\\{/if\\}\\}[ \\t]*\\n`,
  'gm',
);
const PLACEHOLDER = new RegExp(`\\{\\{(${NAME})\\}\\}`, 'g');

// Supports {{NAME}} substitution and {{#if NAME}} ... {{/if}} blocks (no nesting). Anything
// else is an error, and values are limited to a safe character set so a setting can never
// inject YAML.
export function renderTemplate(template: string, vars: TemplateVars): string {
  const withBlocks = template.replace(IF_BLOCK, (_match, name: string, body: string) => {
    const value = vars[name];
    if (typeof value !== 'boolean') throw new Error(`Template flag ${name} must be a boolean`);
    return value ? body : '';
  });

  const rendered = withBlocks.replace(PLACEHOLDER, (_match, name: string) => {
    const value = vars[name];
    if (value === undefined) throw new Error(`Missing template variable ${name}`);
    if (typeof value === 'boolean')
      throw new Error(`Template variable ${name} cannot be a boolean`);
    const text = String(value);
    if (!SAFE_VALUE.test(text)) throw new Error(`Template variable ${name} has unsafe characters`);
    return text;
  });

  if (rendered.includes('{{') || rendered.includes('}}')) {
    throw new Error('Template has unresolved or unsupported syntax');
  }
  return rendered;
}

// Maps each container to an IMAGE_<NAME> variable so the manifest is the only place pins live.
export function imageVars(manifest: ServiceManifest): TemplateVars {
  return Object.fromEntries(
    manifest.images.map((image) => [
      `IMAGE_${image.container.toUpperCase().replaceAll('-', '_')}`,
      `${image.repository}:${image.tag}`,
    ]),
  );
}
