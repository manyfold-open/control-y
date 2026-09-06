/**
 * First-run content.
 *
 * The workspace ships with one open review and two closed ones, because an
 * empty worklist teaches nothing about what the product is for. Everything here
 * is ordinary data from the moment it lands: it can be edited, switched off,
 * re-run or deleted, and nothing re-creates it.
 *
 * Seeding runs once, guarded by a settings key, and every statement is
 * INSERT OR IGNORE so a torn first request cannot produce duplicates.
 */

import type { Evidence } from '../shared/types';
import type { Env } from './types';
import { getSetting, now, setSetting } from './db';

const SEED_KEY = 'turnzero_seed';
/**
 * Bump this whenever the seed gains a row the app then requires, so databases
 * seeded by an older build pick it up — `ensureSeed` skips the whole seed when
 * the stored version matches. Re-running is safe: every statement below is
 * INSERT OR IGNORE, so existing rows, including edited prompts, are untouched.
 *
 * 2 — added the retrospective prompt, which getRetrospective() requires.
 */
const SEED_VERSION = '2';

const iso = (date: string): string => new Date(`${date}T09:00:00Z`).toISOString();

/* ───────── people ───────── */

const PEOPLE = [
  ['p-self', 'You', 'Ardent Capital', 'Fund manager', 'me@ardentcapital.com', 1],
  ['p-roos', 'Anneke Roos', 'Meridian Fund Services', 'Fund accountant', 'a.roos@meridianfs.com', 0],
  ['p-halvorsen', 'Sigrid Halvorsen', 'Halvorsen Legal', 'External counsel', 's.halvorsen@halvorsenlegal.no', 0],
  ['p-lind', 'Tomas Lind', 'Meridian Fund Services', 'Client service lead', 't.lind@meridianfs.com', 0],
] as const;

const ROSTER: [string, string][] = [
  ['p-self', 'Allocations and meeting purpose: cannot be delegated'],
  ['p-roos', 'Prepared the Q1 journal batch'],
  ['p-halvorsen', 'Ran the Sardonyx and Fenwick closings'],
  ['p-lind', 'Escalation point at Meridian'],
];

/* ───────── the panel ───────── */

const AGENTS = [
  {
    key: 'own-docs',
    name: 'Against your own documents',
    purpose:
      'Compares the deliverable against the partnership agreement, side letters and portfolio activity you uploaded.',
    prompt:
      'You are checking a deliverable prepared by a third party against documents the fund manager holds and the preparer does not.\n\nFor every figure, date, rate or term in the deliverable, look for a governing statement in the uploaded documents. Raise an issue when the deliverable contradicts a document, or when a document contains a term the deliverable ignores entirely.\n\nQuote the governing clause. Never raise an issue you cannot anchor to a document.',
  },
  {
    key: 'arithmetic',
    name: 'Arithmetic and bridges',
    purpose: 'Checks that totals foot, bridges reconcile, and stated explanations move in the direction they claim.',
    prompt:
      'Check every total, subtotal and bridge in the deliverable.\n\nBeyond arithmetic, check the DIRECTION of any explanation offered for a break. If a note says a charge posted late, the workbook should be lower than the statement, not higher. An explanation that runs the wrong way is a material finding even when the arithmetic is internally consistent.',
  },
  {
    key: 'rolled-forward',
    name: 'Rolled-forward text',
    purpose: 'Finds narrative carried over from the prior period with only the date advanced.',
    prompt:
      'Compare every narrative section against the equivalent section in the prior period.\n\nFlag sections where the date has been advanced but the substance is unchanged. Report nothing if the deliverable contains no narrative sections. That is a valid and useful result.',
  },
  {
    key: 'reference-data',
    name: 'Unresolved reference data',
    purpose: 'Resolves every counterparty, project code, deal and investor against the master lists.',
    prompt:
      'Resolve every reference in the deliverable against the master lists supplied with it.\n\nReport unresolved references grouped by kind, with counts and row ranges. Rows the preparer has already flagged for review are still findings: a flag is not a decision.',
  },
];

const CEPHALUS = {
  key: 'cephalus',
  name: 'Cephalus allocation watch',
  purpose: 'Your own agent. Watches every expense for a missing or stale allocation.',
  prompt:
    'Every expense row must carry an allocation. Treat a missing allocation as material regardless of the amount, and route it to me. Allocation decisions do not leave my desk.\n\nThe Cephalus allocation rule changed on 1 March 2026. Any allocation struck after that date under the prior rule is material.',
};

const CONSOLIDATOR_PROMPT =
  'You receive the findings of every enabled agent.\n\nMerge findings that describe the same row or section into one issue citing both agents. Rank corroborated findings above single-agent findings of the same severity. Where agents disagree, keep the issue, take the higher severity, and state the disagreement and your ruling.\n\nAssign each issue using the review roster and each person’s title FOR THIS REVIEW, not their directory role. "You" is a legitimate assignee.\n\nMy own instructions override a built-in agent’s judgement.';

const RETROSPECTIVE_PROMPT =
  'A review has been closed. You are looking back at the whole of it: every pass, every issue, how each one was settled, and what the replies said.\n\nWrite the close-out for the fund manager: what this review actually cost, where the panel earned its keep, and where it wasted his time. Be specific and be blunt. An issue the panel raised three times and was wrong about three times is worth saying out loud.\n\nThen propose the rules worth carrying into the next period. A good rule is one that would have changed how this review ran: a treatment already agreed with the counterparty so it stops being re-raised, a defect that recurs so the panel looks there first, a standing instruction of the fund manager’s, or a fact about the fund the deliverable keeps getting wrong.\n\nPropose nothing you cannot tie to a specific issue in this review. A rule drawn from one ambiguous issue is worse than no rule: it will be applied to every future review. Fewer and sharper beats more.';

/* ───────── memory ───────── */

const MEMORY = [
  {
    id: 'm-bank',
    kind: 'Treatment',
    text: 'Bank charges and interest carry no counterparty by convention. Agreed with Meridian, so do not raise them as unmatched.',
    source: 'FY2025 financial statements · pass 3',
    review: 'r-fy2025',
    created: '2026-01-14',
    enabled: 1,
  },
  {
    id: 'm-alloc',
    kind: 'Instruction',
    text: 'Expense allocation never leaves my desk.',
    source: 'Written by you',
    review: null,
    created: '2025-11-02',
    enabled: 1,
  },
  {
    id: 'm-cephalus',
    kind: 'Fact',
    text: 'The Cephalus allocation rule changed in March 2026; the revised rules document is authoritative.',
    source: 'Q4 2025 NAV pack · pass 2',
    review: 'r-q4-2025',
    created: '2026-03-09',
    enabled: 1,
  },
  {
    id: 'm-rollfwd',
    kind: 'Pattern',
    text: 'Meridian rolls the subsequent-events note forward each year by advancing the date without rewriting the text. Check note 21 first.',
    source: 'FY2025 financial statements · pass 4',
    review: 'r-fy2025',
    created: '2026-01-14',
    enabled: 1,
  },
  {
    id: 'm-fx',
    kind: 'Treatment',
    text: 'Intra-group transfers are booked at the month-end rate, not the transaction-date rate.',
    source: 'Q4 2025 NAV pack · pass 1',
    review: 'r-q4-2025',
    created: '2025-12-20',
    enabled: 0,
  },
];

/* ───────── reviews ───────── */

const OPEN_REVIEW = 'r-q1-2026';

const REVIEWS = [
  {
    id: OPEN_REVIEW,
    name: 'Q1 2026 journal batch',
    counterparty: 'Meridian Fund Services',
    period: 'Period ending 31 March 2026',
    status: 'open',
    updated: null,
  },
  {
    id: 'r-fy2025',
    name: 'FY2025 financial statements',
    counterparty: 'Meridian Fund Services',
    period: 'Year ending 31 December 2025',
    status: 'closed',
    updated: '2026-01-14',
  },
  {
    id: 'r-q4-2025',
    name: 'Q4 2025 NAV pack',
    counterparty: 'Meridian Fund Services',
    period: 'Period ending 31 December 2025',
    status: 'closed',
    updated: '2025-12-20',
  },
];

const PASSES: [string, number[], string][] = [
  [OPEN_REVIEW, [18, 14, 12], '2026-04-02'],
  ['r-fy2025', [18, 11, 5, 0], '2026-01-14'],
  ['r-q4-2025', [23, 9, 2, 0], '2025-12-20'],
];

/** The per-agent breakdown behind the last pass on the open review. */
const LAST_PASS_DETAIL = JSON.stringify({
  agents: [
    { key: 'own-docs', name: 'Against your own documents', findings: 3, error: null },
    { key: 'arithmetic', name: 'Arithmetic and bridges', findings: 2, error: null },
    { key: 'rolled-forward', name: 'Rolled-forward text', findings: 0, error: null },
    { key: 'reference-data', name: 'Unresolved reference data', findings: 11, error: null },
    { key: 'cephalus', name: 'Cephalus allocation watch', findings: 3, error: null },
  ],
  memoryEffects: 2,
});

/* ───────── documents ───────── */

const DOCUMENTS: [string, string, string][] = [
  [
    OPEN_REVIEW,
    'staging.xlsx (extract)',
    `Q1 2026 journal batch · staging sheet, rows 40-62 of 101

row  date        narrative                amount            ccy  counterparty        project   position  status
44   2026-03-24  MGMT FEE ACCRUAL Q1      1,062,500.00      EUR  Fenwick Holdings    FNW-01    open      Posted
45   2026-03-25  BANK CHARGE              38.00             DKK  (blank)             (blank)   n/a       Posted
46   2026-03-26  BANK CHARGE              38.00             DKK  (blank)             (blank)   n/a       Posted
47   2026-03-27  SARDONYX CLOSING         632,911.04        EUR  (blank)             (blank)   (none)    Review
48   2026-03-27  INTERNAL TRANSFER        1,204,000.00      DKK  Ardent Cephalus     CEP-04    open      Posted
49   2026-03-27  INTERNAL TRANSFER        380,000.00        DKK  Ardent Cephalus     CEP-04    open      Posted
50   2026-03-28  BANK CHARGE              38.00             DKK  (blank)             (blank)   n/a       Posted
51   2026-03-28  MEETING COSTS            2,410.00          EUR  Ardent Capital      (blank)   n/a       Review
61   2026-03-30  FENWICK RETAINER         4,120.00          GBP  Halvorsen Legal     FNW-01    n/a       Posted

Reference-data notes appended by the preparer:
- 41 of 52 distinct counterparty strings do not resolve against the counterparty master
- 30 rows carry a project code absent from the project master (column D, rows 2-101)
- 16 deals in the upload template are absent from the deal master
- 198 investors in the upload template are absent from the investor master
- rows 12, 19 and 44 are flagged Review with no disposition recorded
- 9 bank-charge rows carry no allocation
- Cephalus allocations on this batch were struck under the rules in force at 31 December 2025`,
  ],
  [
    OPEN_REVIEW,
    'recon.xlsx (extract)',
    `Cash reconciliation · DKK operating account, period ending 31 March 2026

Statement balance          DKK  2,041,118.22
Workbook balance           DKK  2,041,252.73
Difference                 DKK       +134.51

Preparer note (row 90): "charge posted after cut-off"

SEK operating account
Statement balance          SEK    884,013.44
Workbook balance           SEK    884,013.42
Difference                 SEK         -0.02   within agreed rounding tolerance`,
  ],
  [
    OPEN_REVIEW,
    'Fenwick side letter · 11 Sept 2025 (extract)',
    `SIDE LETTER: FENWICK HOLDINGS LP

§4.2  Management Fee
"...notwithstanding clause 8.1 of the Partnership Agreement, the Management Fee
 payable by the Investor shall not exceed one and one quarter per cent (1.25%)
 per annum of Commitments."

§4.3  This letter was executed on 11 September 2025 and has not been supplied to
 the Administrator.

Counsel letter, 2 April 2026, §3
"Contractual rate, 27 March 2026: 1.0389605 (EUR/DKK), fixed by schedule 4 of the
 SPA. No market rate applies to consideration payable on that date."`,
  ],
  ['r-fy2025', 'FY2025 financial statements (extract)', 'Note 21: Subsequent events. Carried forward from FY2024 with the date advanced.'],
  ['r-fy2025', 'FY2025 trial balance (extract)', 'Trial balance as at 31 December 2025. Closed.'],
  ['r-q4-2025', 'Q4 2025 NAV pack (extract)', 'NAV statement as at 31 December 2025. Closed.'],
  ['r-q4-2025', 'Cephalus allocation rules v1 (extract)', 'Allocation rules in force to 29 February 2026. Superseded 1 March 2026.'],
];

/* ───────── issues on the open review ───────── */

interface SeedIssue {
  ref: string;
  location: string;
  severity: 'material' | 'presentational' | 'question';
  status: 'open' | 'resolved';
  statement: string;
  why: string;
  raisedBy: string[];
  assignee: string;
  reason: string;
  flags?: string[];
  evidence?: Evidence;
  memory?: { entryId: string; effect: string };
  conflict?: { positions: { agent: string; verdict: string }[]; ruling: string };
  draft?: string;
  resolution?: string;
}

const ISSUES: SeedIssue[] = [
  {
    ref: 'TZ-047',
    location: 'staging!row 47',
    severity: 'material',
    status: 'open',
    statement: 'EUR 632,911.04 narrated SARDONYX CLOSING resolves to no deal, no project and no position.',
    why: 'This is the largest unresolved row in the batch. Until it is classified the period cannot close, and it is large enough to move the NAV on its own. The administrator parked it as Review rather than deciding.',
    raisedBy: ['Unresolved reference data', 'Against your own documents'],
    assignee: 'p-halvorsen',
    reason: 'The review roster records that they ran the Sardonyx closing.',
    evidence: {
      label: 'staging.xlsx · row 47',
      quote: null,
      rows: [
        { field: 'date', value: '2026-03-27', note: null },
        { field: 'narrative', value: 'SARDONYX CLOSING', note: null },
        { field: 'amount', value: 'EUR 632,911.04', note: null },
        { field: 'counterparty', value: '(blank)', note: 'no match on the counterparty master' },
        { field: 'project', value: '(blank)', note: 'no match on the project master' },
        { field: 'position', value: '(blank)', note: 'no open position on 2026-03-27' },
        { field: 'status', value: 'Review', note: null },
      ],
    },
    draft:
      'Hello Sigrid,\n\nIn the Q1 2026 journal batch there is a single entry of EUR 632,911.04 dated 27 March, narrated SARDONYX CLOSING. It carries no counterparty and no project code, and Meridian has parked it pending a decision rather than classifying it.\n\nSince you ran that closing: what is this payment, and how should it be classified? If it is completion consideration under the SPA I will need the contractual rate applied on the day.\n\nThank you.',
  },
  {
    ref: 'TZ-031',
    location: 'recon!DKK 134.51',
    severity: 'material',
    status: 'open',
    statement: 'The explanation offered for the DKK 134.51 break runs the wrong way arithmetically.',
    why: 'A charge that posted after cut-off would make the workbook LOWER than the statement. The workbook is higher. Either the explanation or the figure is wrong, and neither has been withdrawn.',
    raisedBy: ['Arithmetic and bridges'],
    assignee: 'p-roos',
    reason: 'They wrote the reconciliation note.',
    flags: ['contradicts'],
    evidence: {
      label: 'recon.xlsx · rows 88–90',
      quote: null,
      rows: [
        { field: 'Statement balance', value: 'DKK 2,041,118.22', note: null },
        { field: 'Workbook balance', value: 'DKK 2,041,252.73', note: null },
        { field: 'Difference', value: 'DKK +134.51', note: 'the workbook is the higher of the two' },
        {
          field: 'Note on the break',
          value: '"charge posted after cut-off"',
          note: 'a late charge would make this negative, not positive',
        },
      ],
    },
    draft:
      'Hello Anneke,\n\nThe note against the DKK 134.51 reconciliation break says the difference is a charge that posted after cut-off. If that were so the workbook would sit below the statement. It sits DKK 134.51 above it.\n\nCould you re-check either the figure or the explanation? One of the two has to change.\n\nThank you.',
  },
  {
    ref: 'TZ-038',
    location: 'fx!2026-03-27',
    severity: 'material',
    status: 'open',
    statement:
      'Counsel gives a contractual FX rate for 27 March; the same day’s credits were booked as internal transfers with no rate recorded.',
    why: 'Both treatments cannot stand. One has to be withdrawn before the period closes, and the difference is not immaterial at this size.',
    raisedBy: ['Against your own documents', 'Arithmetic and bridges'],
    assignee: 'p-halvorsen',
    reason: 'They supplied the contractual rate.',
    flags: ['contradicts'],
    evidence: {
      label: 'Counsel letter · 2 April 2026 · §3',
      quote: null,
      rows: [
        {
          field: 'Contractual rate, 27 March 2026',
          value: '1.0389605 EUR/DKK, per SPA schedule 4',
          note: null,
        },
        {
          field: 'Journal batch, 27 March 2026',
          value: 'booked as an internal transfer',
          note: 'the rate field is blank',
        },
      ],
    },
  },
  {
    ref: 'TZ-052',
    location: 'staging!bank charges (9 rows)',
    severity: 'material',
    status: 'open',
    statement: 'Nine bank-charge rows are expenses carrying no allocation.',
    why: 'Expenses without an allocation sit in suspense and never reach a fund. At nine rows this is small money and a recurring habit.',
    raisedBy: ['Unresolved reference data', 'Cephalus allocation watch'],
    assignee: 'p-self',
    reason: 'Your standing instruction: allocation decisions come to you.',
    conflict: {
      positions: [
        {
          agent: 'Unresolved reference data',
          verdict: 'Presentational and routine. Bank charges carry no counterparty by nature.',
        },
        {
          agent: 'Cephalus allocation watch',
          verdict:
            'Material: these are expenses with no allocation, and your instruction says allocation decisions come to you.',
        },
      ],
      ruling:
        'Kept at material and routed to you. Your instruction outranks a built-in agent’s view of what is routine. That is the tie-break you set.',
    },
  },
  {
    ref: 'TZ-055',
    location: 'alloc!cephalus',
    severity: 'material',
    status: 'open',
    statement: 'The batch applies the pre-March Cephalus allocation rule. The rule changed on 1 March 2026.',
    why: 'Every allocation struck after 1 March under the old rule has to be restated, and the error compounds each period it goes unnoticed.',
    raisedBy: ['Cephalus allocation watch'],
    assignee: 'p-self',
    reason: 'Your standing instruction: allocation decisions come to you.',
    flags: ['revised'],
    memory: {
      entryId: 'm-cephalus',
      effect: 'Raised as material rather than a question · the revised rules document was used as the comparison basis',
    },
  },
  {
    ref: 'TZ-041',
    location: 'sideletter!fenwick §4.2',
    severity: 'material',
    status: 'open',
    statement: 'The Fenwick side letter caps the management fee at 1.25%. The accrual in this batch is struck at 1.50%.',
    why: 'The side letter is on your side and was never given to Meridian. The overcharge compounds every period it is missed.',
    raisedBy: ['Against your own documents'],
    assignee: 'p-halvorsen',
    reason: 'They advised on the side letter amendment.',
    evidence: {
      label: 'Fenwick side letter · 11 Sept 2025 · §4.2',
      quote:
        '…the Management Fee payable by the Investor shall not exceed one and one quarter per cent (1.25%) per annum of Commitments.',
      rows: [
        { field: 'Cap, per §4.2', value: '1.25% per annum', note: null },
        { field: 'Q1 2026 accrual', value: '1.50% per annum', note: 'struck 25 bps above the cap' },
      ],
    },
  },
  {
    ref: 'TZ-012',
    location: 'staging!D2:D101',
    severity: 'material',
    status: 'open',
    statement: '30 rows carry a project code that does not resolve against the project master.',
    why: 'Without a project code these rows cannot reach a fund, and the batch cannot be posted.',
    raisedBy: ['Unresolved reference data'],
    assignee: 'p-roos',
    reason: 'They own the staging load and the project master.',
  },
  {
    ref: 'TZ-018',
    location: 'upload!deals',
    severity: 'material',
    status: 'open',
    statement: '16 deals in the upload template do not appear on the deal master.',
    why: 'These will fail on load, or worse, silently create duplicate deal records.',
    raisedBy: ['Unresolved reference data', 'Against your own documents'],
    assignee: 'p-roos',
    reason: 'They produced the upload template.',
  },
  {
    ref: 'TZ-002',
    location: 'staging!B2:B101',
    severity: 'presentational',
    status: 'open',
    statement: '41 of 52 rows carry a counterparty string that resolves to no entity on the master list.',
    why: 'Unmatched counterparties cannot be allocated or reported on. Eleven of the original 52 are bank charges, which carry no counterparty by agreement.',
    raisedBy: ['Unresolved reference data'],
    assignee: 'p-roos',
    reason: 'They own the staging load and the counterparty master.',
    flags: ['revised'],
    memory: {
      entryId: 'm-bank',
      effect: '11 rows excluded · severity dropped from material to presentational',
    },
  },
  {
    ref: 'TZ-021',
    location: 'upload!investors',
    severity: 'presentational',
    status: 'open',
    statement: '198 investors in the upload template do not appear on the investor master.',
    why: 'Most are expected to be new subscriptions, but the list has not been confirmed as such by anyone.',
    raisedBy: ['Unresolved reference data'],
    assignee: 'p-roos',
    reason: 'They produced the upload template.',
  },
  {
    ref: 'TZ-024',
    location: 'staging!rows 12, 19, 44',
    severity: 'question',
    status: 'open',
    statement: 'Three rows are flagged Review with no disposition recorded.',
    why: 'The flag says somebody stopped on these. Nobody wrote down why, or what they decided.',
    raisedBy: ['Unresolved reference data'],
    assignee: 'p-roos',
    reason: 'They set the flag.',
    flags: ['new'],
  },
  {
    ref: 'TZ-058',
    location: 'expenses!meeting costs',
    severity: 'question',
    status: 'open',
    statement: 'Seven meeting-cost rows need a stated purpose before they can be allocated.',
    why: 'You are generally the only person who knows what each meeting was for.',
    raisedBy: ['Cephalus allocation watch'],
    assignee: 'p-self',
    reason: 'Nobody else holds this. It cannot be delegated.',
  },
  {
    ref: 'TZ-009',
    location: 'staging!row 61',
    severity: 'presentational',
    status: 'resolved',
    statement: 'GBP 4,120.00 narrated FENWICK RETAINER carried no project code.',
    why: 'Unallocated retainer costs distort the mandate’s expense ratio.',
    raisedBy: ['Unresolved reference data'],
    assignee: 'p-halvorsen',
    reason: 'They hold the Fenwick mandate.',
    resolution: 'Counsel confirmed it belongs to the Fenwick mandate. Project code FNW-01 applied.',
  },
  {
    ref: 'TZ-015',
    location: 'recon!SEK',
    severity: 'presentational',
    status: 'resolved',
    statement: 'SEK reconciliation carried a 0.02 rounding break.',
    why: 'Rounding breaks accumulate across periods if never cleared.',
    raisedBy: ['Arithmetic and bridges'],
    assignee: 'p-roos',
    reason: 'They own the reconciliation.',
    resolution: 'Within the agreed rounding tolerance. No action.',
  },
];

const SEVERITY_RANK = { material: 0, presentational: 1, question: 2 } as const;

/* ───────── the seed ───────── */

let seeded = false;

export async function ensureSeed(env: Env): Promise<void> {
  if (seeded) return;
  if ((await getSetting(env, SEED_KEY)) === SEED_VERSION) {
    seeded = true;
    return;
  }
  await applySeed(env);
  await setSetting(env, SEED_KEY, SEED_VERSION);
  seeded = true;
}

async function applySeed(env: Env): Promise<void> {
  const timestamp = now();
  const statements: D1PreparedStatement[] = [];

  for (const [id, name, org, role, email, isSelf] of PEOPLE) {
    statements.push(
      env.DB.prepare(
        'INSERT OR IGNORE INTO people (id, name, org, role, email, is_self, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ).bind(id, name, org, role, email, isSelf, timestamp),
    );
  }

  const agentRow = (
    agent: { key: string; name: string; purpose: string; prompt: string },
    role: string,
    builtin: number,
    modified: number,
    order: number,
  ) =>
    env.DB.prepare(
      `INSERT OR IGNORE INTO panel_agents (key, name, role, builtin, enabled, modified, purpose, prompt, sort_order, created_at)
       VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`,
    ).bind(agent.key, agent.name, role, builtin, modified, agent.purpose, agent.prompt, order, timestamp);

  AGENTS.forEach((agent, index) => statements.push(agentRow(agent, 'panel', 1, 0, index)));
  statements.push(agentRow(CEPHALUS, 'panel', 0, 1, AGENTS.length));
  statements.push(
    agentRow(
      {
        key: 'consolidator',
        name: 'Consolidator',
        purpose: 'Merges the panel’s findings into one list, assigns each issue, and drafts the message.',
        prompt: CONSOLIDATOR_PROMPT,
      },
      'consolidator',
      1,
      0,
      999,
    ),
  );
  statements.push(
    agentRow(
      {
        key: 'retrospective',
        name: 'Retrospective',
        purpose:
          'Runs once, when you close a review. Writes the close-out and proposes the rules worth carrying forward.',
        prompt: RETROSPECTIVE_PROMPT,
      },
      'retrospective',
      1,
      0,
      1000,
    ),
  );

  for (const entry of MEMORY) {
    statements.push(
      env.DB.prepare(
        `INSERT OR IGNORE INTO memory_entries (id, kind, text, enabled, source, source_review_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).bind(entry.id, entry.kind, entry.text, entry.enabled, entry.source, entry.review, iso(entry.created)),
    );
  }
  // The FX treatment is switched off AND out of scope here: the page explains
  // that an entry has to be both to apply, and one example makes that legible.
  statements.push(
    env.DB.prepare('INSERT OR IGNORE INTO review_memory (review_id, entry_id, in_scope) VALUES (?, ?, 0)').bind(
      OPEN_REVIEW,
      'm-fx',
    ),
  );

  for (const review of REVIEWS) {
    const updated = review.updated ? iso(review.updated) : timestamp;
    statements.push(
      env.DB.prepare(
        `INSERT OR IGNORE INTO reviews (id, name, counterparty, period, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).bind(review.id, review.name, review.counterparty, review.period, review.status, updated, updated),
    );
    for (const [personId, title] of ROSTER) {
      statements.push(
        env.DB.prepare(
          'INSERT OR IGNORE INTO review_people (review_id, person_id, review_title) VALUES (?, ?, ?)',
        ).bind(review.id, personId, review.id === OPEN_REVIEW ? title : ''),
      );
    }
  }

  for (const [reviewId, counts, finished] of PASSES) {
    counts.forEach((openCount, index) => {
      const last = index === counts.length - 1;
      statements.push(
        env.DB.prepare(
          `INSERT OR IGNORE INTO passes (id, review_id, number, status, open_count, detail, started_at, finished_at)
           VALUES (?, ?, ?, 'done', ?, ?, ?, ?)`,
        ).bind(
          `pass-${reviewId}-${index + 1}`,
          reviewId,
          index + 1,
          openCount,
          last && reviewId === OPEN_REVIEW ? LAST_PASS_DETAIL : '[]',
          iso(finished),
          iso(finished),
        ),
      );
    });
  }

  for (const [reviewId, name, content] of DOCUMENTS) {
    statements.push(
      env.DB.prepare(
        'INSERT OR IGNORE INTO documents (id, review_id, name, content, bytes, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      ).bind(
        `d-${reviewId}-${name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`,
        reviewId,
        name,
        content,
        new TextEncoder().encode(content).length,
        timestamp,
      ),
    );
  }

  ISSUES.forEach((issue, index) => {
    statements.push(
      env.DB.prepare(
        `INSERT OR IGNORE INTO issues (id, review_id, ref, location, severity, status, statement, why, raised_by,
           assignee_id, assignee_reason, flags, evidence, memory_ref, conflict, draft, resolution, sort_order,
           created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        `i-${OPEN_REVIEW}-${issue.ref}`,
        OPEN_REVIEW,
        issue.ref,
        issue.location,
        issue.severity,
        issue.status,
        issue.statement,
        issue.why,
        JSON.stringify(issue.raisedBy),
        issue.assignee,
        issue.reason,
        JSON.stringify(issue.flags ?? []),
        issue.evidence ? JSON.stringify(issue.evidence) : null,
        issue.memory ? JSON.stringify(issue.memory) : null,
        issue.conflict ? JSON.stringify(issue.conflict) : null,
        issue.draft ?? null,
        issue.resolution ?? null,
        SEVERITY_RANK[issue.severity] * 1000 + index,
        timestamp,
        timestamp,
      ),
    );
  });

  await env.DB.batch(statements);
}
