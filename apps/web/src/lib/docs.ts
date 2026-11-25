import { version } from '../../../agent/package.json';

// The dashboard and the agent ship together as one kit version, so the docs are linked as they were
// at that version's tag, not as they are on main today.
export const KIT_VERSION = version;

const DOCS_BASE = `https://github.com/KShammout632/self-hosting-starter-kit/blob/v${KIT_VERSION}/docs`;

export const DOCS = {
  userGuide: `${DOCS_BASE}/user-guide.md`,
  troubleshooting: `${DOCS_BASE}/troubleshooting.md`,
};
