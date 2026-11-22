// Compose templates are bundled as text: tsup uses its text loader, vitest a small plugin.
declare module '*.tmpl' {
  const content: string;
  export default content;
}
