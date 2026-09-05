# Ctrl+Y

## Product purpose

A fund manager sends a deliverable out for review and gets it back with comments.
Then again. Then again. Ctrl+Y collapses that loop: a panel of agents reads the
deliverable against its source documents, a consolidator merges what they found into
one list of issues, each issue is assigned to the one person who can answer it, and
the replies are pasted back so the panel can run again.

The product's only number is **the count of turns**. 18 open, then 14, then 12, then
zero. Everything on screen exists to make the next number smaller.

## Register

`product` — an authenticated workspace the user works inside. Design serves the task.
It is not a marketing surface and should never behave like one.

## Users

**Primary: the fund manager.** Signs off on the deliverable and carries the
consequence if something wrong goes out. Financially literate, not technical. Reads
narrative text against spreadsheets and side letters. Works from an office, on a
laptop, in daylight, alongside Excel and Outlook. Values being told what is material
and who has to answer it; has no interest in how many model calls produced that.

**Nobody else signs in.** Counterparty staff, external counsel and client service
leads appear as recipients in the directory, but they receive letters, not logins.
Everything they see leaves the product as pasted text.

## Tone

Plain, specific, professional. The register of a good memo: short declarative
sentences, real amounts, no hedging.

- Say the finding, then say why it matters. In that order.
- Never dress a machine judgment as certainty. "The panel disagreed" is honest;
  "conflict detected" is jargon.
- Zero is a result worth stating. "Nothing found" is information.
- No exclamation marks, no encouragement, no product voice.

## Strategic principles

1. **The list is the product.** Any chrome above the issue list is rent the list is
   paying. Header bands, summary strips and counters must justify themselves against
   the rows they push down.
2. **Say it once.** A fact shown in the rail does not need repeating in a stat box
   and again in a table cell.
3. **One meaning per colour.** Green cannot mean both "open" and "resolved".
4. **Process is not the product.** How many findings merged into how many issues is
   the system's business. Surface it on demand, never by default.
5. **Every accent earns severity.** Colour marks material risk, an open question, or
   settled work. Nothing else gets colour.
6. **Progressive disclosure over density.** Prompts, panel breakdowns and provenance
   live behind a disclosure, not on the page.

## Anti-references

- **Analytics dashboards.** Four-metric hero strips, sparklines, "insights". This is
  a worklist, not a report on itself.
- **Ticket trackers.** Not Jira. No status taxonomies, no swimlanes, no badges on
  badges.
- **Chat-first AI products.** No message bubbles, no typing indicators, no
  personality. The panel is machinery, not a companion.
- **Developer tooling aesthetics.** Terminal green on black, monospace body text.
  Mono is for amounts, identifiers and evidence only.

## Non-goals

- Multi-user collaboration inside the app.
- Real-time anything. Passes are discrete and deliberate.
- Configurability as a feature. Tie-break rules live in prose prompts, not switches.
