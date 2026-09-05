/**
 * Turning issues into the text that leaves the product.
 *
 * Nobody but the fund manager signs in, so every question reaches its recipient
 * as pasted text. One issue copies its own drafted message; several issues to
 * the same person become one letter, which is what this builds.
 *
 * Pure string work, no runtime dependencies — it sits in shared because it is
 * about the shape of the deliverable, not about the browser.
 */

import type { Issue, RosterEntry } from './types';

const GREETING = /^(hello|hi|dear)\b[^\n]*$/i;
const SIGN_OFF = /^(thank you|thanks|many thanks|regards|best|kind regards|yours)\b/i;

/**
 * A drafted message is a whole letter. Merging several needs the bodies only, so
 * an opening greeting and a closing sign-off come off — but only when something
 * is left afterwards. A draft that is nothing but boilerplate is returned whole.
 */
export function letterBody(draft: string): string {
  const parts = draft.trim().split(/\n\s*\n/);
  const start = GREETING.test(parts[0]?.trim() ?? '') ? 1 : 0;
  const end = parts.length - (parts.length > 1 && SIGN_OFF.test(parts[parts.length - 1].trim()) ? 1 : 0);
  return parts.slice(start, end).join('\n\n').trim() || draft.trim();
}

/** One letter covering everything one person has to answer on one review. */
export function composeLetter(person: RosterEntry, reviewName: string, issues: Issue[]): string {
  const firstName = person.name.split(' ')[0] || person.name;
  const body = issues
    .map((issue, index) => {
      const detail = issue.draft
        ? letterBody(issue.draft)
        : [issue.statement, issue.whyItMatters].filter(Boolean).join('\n\n');
      return `${index + 1}. ${issue.ref}${issue.location ? ` · ${issue.location}` : ''}\n\n${detail}`;
    })
    .join('\n\n');
  const opening =
    issues.length === 1
      ? 'There is one point'
      : `There are ${issues.length} points`;
  return `Hello ${firstName},\n\n${opening} on the ${reviewName} that ${issues.length === 1 ? 'needs' : 'need'} you.\n\n${body}\n\nThank you.`;
}
