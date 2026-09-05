/**
 * Mock workspace for Turn Zero. Content is drawn from the PRD's demo workbook —
 * real amounts, real narratives, real defects. No API calls anywhere in the app.
 */

export type Severity = 'material' | 'presentational' | 'question';
export type IssueStatus = 'open' | 'resolved' | 'dismissed';
export type Flag = 'new' | 'revised' | 'contradicts';
export type MemoryKind = 'Treatment' | 'Pattern' | 'Instruction' | 'Fact';

export interface Person {
  id: string;
  name: string;
  org: string;
  role: string;
  email: string;
  isSelf?: boolean;
  /** Title for the current review only — overrides `role` when assigning. */
  reviewTitle?: string;
}

export interface Agent {
  key: string;
  name: string;
  builtin: boolean;
  enabled: boolean;
  modified: boolean;
  purpose: string;
  prompt: string;
  findings: number | null;
}

export interface MemoryEntry {
  id: string;
  kind: MemoryKind;
  text: string;
  enabled: boolean;
  inScope: boolean;
  source: string;
  createdAt: string;
}

export interface Issue {
  id: string;
  ref: string;
  location: string;
  severity: Severity;
  status: IssueStatus;
  statement: string;
  whyItMatters: string;
  raisedBy: string[];
  assigneeId: string;
  assigneeReason: string;
  flags: Flag[];
  evidence?: { label: string; lines: string[] };
  memory?: { entryId: string; effect: string };
  conflict?: { positions: { agent: string; verdict: string }[]; ruling: string };
  draft?: string;
  resolution?: string;
}

export interface Review {
  id: string;
  name: string;
  counterparty: string;
  period: string;
  status: 'open' | 'closed' | 'draft';
  passes: number[];
  documents: number;
  agents: number;
  updated: string;
  memoryProduced: number;
}

/* ── People ────────────────────────────────────────────────────────────────── */

export const PEOPLE: Person[] = [
  {
    id: 'p-self',
    name: 'You',
    org: 'Ardent Capital',
    role: 'Fund manager',
    email: 'me@ardentcapital.com',
    isSelf: true,
    reviewTitle: 'Allocations and meeting purpose — cannot be delegated',
  },
  {
    id: 'p-roos',
    name: 'Anneke Roos',
    org: 'Meridian Fund Services',
    role: 'Fund accountant',
    email: 'a.roos@meridianfs.com',
    reviewTitle: 'Prepared the Q1 journal batch',
  },
  {
    id: 'p-halvorsen',
    name: 'Sigrid Halvorsen',
    org: 'Halvorsen Legal',
    role: 'External counsel',
    email: 's.halvorsen@halvorsenlegal.no',
    reviewTitle: 'Ran the Sardonyx and Fenwick closings',
  },
  {
    id: 'p-lind',
    name: 'Tomas Lind',
    org: 'Meridian Fund Services',
    role: 'Client service lead',
    email: 't.lind@meridianfs.com',
    reviewTitle: 'Escalation point at Meridian',
  },
];

export const personById = (id: string) => PEOPLE.find((p) => p.id === id)!;

export const initials = (name: string) =>
  name === 'You'
    ? 'YOU'
    : name
        .split(' ')
        .map((w) => w[0])
        .slice(0, 2)
        .join('');

/* ── Agents ────────────────────────────────────────────────────────────────── */

export const AGENTS: Agent[] = [
  {
    key: 'own-docs',
    name: 'Against your own documents',
    builtin: true,
    enabled: true,
    modified: false,
    purpose: 'Compares the deliverable against the partnership agreement, side letters and portfolio activity you uploaded.',
    prompt:
      'You are checking a deliverable prepared by a third party against documents the fund manager holds and the preparer does not.\n\nFor every figure, date, rate or term in the deliverable, look for a governing statement in the uploaded documents. Raise an issue when the deliverable contradicts a document, or when a document contains a term the deliverable ignores entirely.\n\nQuote the governing clause. Never raise an issue you cannot anchor to a document.',
    findings: 3,
  },
  {
    key: 'arithmetic',
    name: 'Arithmetic and bridges',
    builtin: true,
    enabled: true,
    modified: false,
    purpose: 'Checks that totals foot, bridges reconcile, and stated explanations move in the direction they claim.',
    prompt:
      'Check every total, subtotal and bridge in the deliverable.\n\nBeyond arithmetic, check the DIRECTION of any explanation offered for a break. If a note says a charge posted late, the workbook should be lower than the statement, not higher. An explanation that runs the wrong way is a material finding even when the arithmetic is internally consistent.',
    findings: 2,
  },
  {
    key: 'rolled-forward',
    name: 'Rolled-forward text',
    builtin: true,
    enabled: true,
    modified: false,
    purpose: 'Finds narrative carried over from the prior period with only the date advanced.',
    prompt:
      'Compare every narrative section against the equivalent section in the prior period.\n\nFlag sections where the date has been advanced but the substance is unchanged. Report nothing if the deliverable contains no narrative sections — that is a valid and useful result.',
    findings: 0,
  },
  {
    key: 'reference-data',
    name: 'Unresolved reference data',
    builtin: true,
    enabled: true,
    modified: false,
    purpose: 'Resolves every counterparty, project code, deal and investor against the master lists.',
    prompt:
      'Resolve every reference in the deliverable against the master lists supplied with it.\n\nReport unresolved references grouped by kind, with counts and row ranges. Rows the preparer has already flagged for review are still findings — a flag is not a decision.',
    findings: 11,
  },
  {
    key: 'cephalus',
    name: 'Cephalus allocation watch',
    builtin: false,
    enabled: true,
    modified: true,
    purpose: 'Your own agent. Watches every expense for a missing or stale allocation.',
    prompt:
      'Every expense row must carry an allocation. Treat a missing allocation as material regardless of the amount, and route it to me — allocation decisions do not leave my desk.\n\nThe Cephalus allocation rule changed on 1 March 2026. Any allocation struck after that date under the prior rule is material.',
    findings: 3,
  },
];

export const CONSOLIDATOR = {
  key: 'consolidator',
  name: 'Consolidator',
  purpose: 'Merges the panel’s findings into one list, assigns each issue, and drafts the message.',
  prompt:
    'You receive the findings of every enabled agent.\n\nMerge findings that describe the same row or section into one issue citing both agents. Rank corroborated findings above single-agent findings of the same severity. Where agents disagree, keep the issue, take the higher severity, and state the disagreement and your ruling.\n\nAssign each issue using the review roster and each person’s title FOR THIS REVIEW, not their directory role. "You" is a legitimate assignee.\n\nMy own instructions override a built-in agent’s judgement.',
};

/* ── Memory ────────────────────────────────────────────────────────────────── */

export const MEMORY: MemoryEntry[] = [
  {
    id: 'm-bank',
    kind: 'Treatment',
    text: 'Bank charges and interest carry no counterparty by convention. Agreed with Meridian — do not raise them as unmatched.',
    enabled: true,
    inScope: true,
    source: 'FY2025 financial statements · pass 3',
    createdAt: '14 Jan 2026',
  },
  {
    id: 'm-alloc',
    kind: 'Instruction',
    text: 'Expense allocation never leaves my desk.',
    enabled: true,
    inScope: true,
    source: 'Written by you',
    createdAt: '2 Nov 2025',
  },
  {
    id: 'm-cephalus',
    kind: 'Fact',
    text: 'The Cephalus allocation rule changed in March 2026; the revised rules document is authoritative.',
    enabled: true,
    inScope: true,
    source: 'Q4 2025 NAV pack · pass 2',
    createdAt: '9 Mar 2026',
  },
  {
    id: 'm-rollfwd',
    kind: 'Pattern',
    text: 'Meridian rolls the subsequent-events note forward each year by advancing the date without rewriting the text. Check note 21 first.',
    enabled: true,
    inScope: true,
    source: 'FY2025 financial statements · pass 4',
    createdAt: '14 Jan 2026',
  },
  {
    id: 'm-fx',
    kind: 'Treatment',
    text: 'Intra-group transfers are booked at the month-end rate, not the transaction-date rate.',
    enabled: false,
    inScope: false,
    source: 'Q4 2025 NAV pack · pass 1',
    createdAt: '20 Dec 2025',
  },
];

export const memoryById = (id: string) => MEMORY.find((m) => m.id === id)!;

/* ── Reviews ───────────────────────────────────────────────────────────────── */

export const REVIEWS: Review[] = [
  {
    id: 'r-q1-2026',
    name: 'Q1 2026 journal batch',
    counterparty: 'Meridian Fund Services',
    period: 'Period ending 31 March 2026',
    status: 'open',
    passes: [18, 14, 12],
    documents: 3,
    agents: 5,
    updated: 'Today',
    memoryProduced: 0,
  },
  {
    id: 'r-fy2025',
    name: 'FY2025 financial statements',
    counterparty: 'Meridian Fund Services',
    period: 'Year ending 31 December 2025',
    status: 'closed',
    passes: [18, 11, 5, 0],
    documents: 6,
    agents: 4,
    updated: '14 Jan 2026',
    memoryProduced: 3,
  },
  {
    id: 'r-q4-2025',
    name: 'Q4 2025 NAV pack',
    counterparty: 'Meridian Fund Services',
    period: 'Period ending 31 December 2025',
    status: 'closed',
    passes: [23, 9, 2, 0],
    documents: 4,
    agents: 4,
    updated: '20 Dec 2025',
    memoryProduced: 2,
  },
];

/* ── Issues on the open review ─────────────────────────────────────────────── */

export const ISSUES: Issue[] = [
  {
    id: 'i7',
    ref: 'TZ-047',
    location: 'staging!row 47',
    severity: 'material',
    status: 'open',
    statement: 'EUR 632,911.04 narrated SARDONYX CLOSING resolves to no deal, no project and no position.',
    whyItMatters:
      'This is the largest unresolved row in the batch. Until it is classified the period cannot close, and it is large enough to move the NAV on its own. The administrator parked it as Review rather than deciding.',
    raisedBy: ['Unresolved reference data', 'Against your own documents'],
    assigneeId: 'p-halvorsen',
    assigneeReason: 'The review roster records that they ran the Sardonyx closing.',
    flags: [],
    evidence: {
      label: 'staging.xlsx · row 47',
      lines: [
        'date          2026-03-27',
        'narrative     SARDONYX CLOSING',
        'amount        EUR  632,911.04',
        'counterparty  (blank)         -> no match on counterparty master',
        'project       (blank)         -> no match on project master',
        'position      (blank)         -> no open position on 2026-03-27',
        'status        Review',
      ],
    },
    draft:
      'Hello Sigrid,\n\nIn the Q1 2026 journal batch there is a single entry of EUR 632,911.04 dated 27 March, narrated SARDONYX CLOSING. It carries no counterparty and no project code, and Meridian has parked it pending a decision rather than classifying it.\n\nSince you ran that closing: what is this payment, and how should it be classified? If it is completion consideration under the SPA I will need the contractual rate applied on the day.\n\nThank you.',
  },
  {
    id: 'i3',
    ref: 'TZ-031',
    location: 'recon!DKK 134.51',
    severity: 'material',
    status: 'open',
    statement: 'The explanation offered for the DKK 134.51 break runs the wrong way arithmetically.',
    whyItMatters:
      'A charge that posted after cut-off would make the workbook LOWER than the statement. The workbook is higher. Either the explanation or the figure is wrong, and neither has been withdrawn.',
    raisedBy: ['Arithmetic and bridges'],
    assigneeId: 'p-roos',
    assigneeReason: 'They wrote the reconciliation note.',
    flags: ['contradicts'],
    evidence: {
      label: 'recon.xlsx · rows 88–90',
      lines: [
        'Statement balance          DKK  2,041,118.22',
        'Workbook balance           DKK  2,041,252.73',
        'Difference                 DKK       +134.51   <- workbook is HIGHER',
        '',
        'Note: "charge posted after cut-off"',
        '      a late charge would make this NEGATIVE, not positive',
      ],
    },
    draft:
      'Hello Anneke,\n\nThe note against the DKK 134.51 reconciliation break says the difference is a charge that posted after cut-off. If that were so the workbook would sit below the statement. It sits DKK 134.51 above it.\n\nCould you re-check either the figure or the explanation? One of the two has to change.\n\nThank you.',
  },
  {
    id: 'i8',
    ref: 'TZ-038',
    location: 'fx!2026-03-27',
    severity: 'material',
    status: 'open',
    statement: 'Counsel gives a contractual FX rate for 27 March; the same day’s credits were booked as internal transfers with no rate recorded.',
    whyItMatters: 'Both treatments cannot stand. One has to be withdrawn before the period closes, and the difference is not immaterial at this size.',
    raisedBy: ['Against your own documents', 'Arithmetic and bridges'],
    assigneeId: 'p-halvorsen',
    assigneeReason: 'They supplied the contractual rate.',
    flags: ['contradicts'],
    evidence: {
      label: 'Counsel letter · 2 April 2026 · §3',
      lines: [
        'Contractual rate, 27 March 2026     1.0389605  (EUR/DKK, per SPA sch. 4)',
        'Journal batch, 27 March 2026       booked as internal transfer',
        '                                   rate field: (blank)',
      ],
    },
  },
  {
    id: 'i10',
    ref: 'TZ-052',
    location: 'staging!bank charges (9 rows)',
    severity: 'material',
    status: 'open',
    statement: 'Nine bank-charge rows are expenses carrying no allocation.',
    whyItMatters: 'Expenses without an allocation sit in suspense and never reach a fund. At nine rows this is small money and a recurring habit.',
    raisedBy: ['Unresolved reference data', 'Cephalus allocation watch'],
    assigneeId: 'p-self',
    assigneeReason: 'Your standing instruction: allocation decisions come to you.',
    flags: [],
    conflict: {
      positions: [
        {
          agent: 'Unresolved reference data',
          verdict: 'Presentational — routine. Bank charges carry no counterparty by nature.',
        },
        {
          agent: 'Cephalus allocation watch',
          verdict: 'Material — these are expenses with no allocation, and your instruction says allocation decisions come to you.',
        },
      ],
      ruling:
        'Kept at material and routed to you. Your instruction outranks a built-in agent’s view of what is routine — that is the tie-break you set.',
    },
  },
  {
    id: 'i11',
    ref: 'TZ-055',
    location: 'alloc!cephalus',
    severity: 'material',
    status: 'open',
    statement: 'The batch applies the pre-March Cephalus allocation rule. The rule changed on 1 March 2026.',
    whyItMatters: 'Every allocation struck after 1 March under the old rule has to be restated, and the error compounds each period it goes unnoticed.',
    raisedBy: ['Cephalus allocation watch'],
    assigneeId: 'p-self',
    assigneeReason: 'Your standing instruction: allocation decisions come to you.',
    flags: ['revised'],
    memory: {
      entryId: 'm-cephalus',
      effect: 'Raised as material rather than a question · the revised rules document was used as the comparison basis',
    },
  },
  {
    id: 'i9',
    ref: 'TZ-041',
    location: 'sideletter!fenwick §4.2',
    severity: 'material',
    status: 'open',
    statement: 'The Fenwick side letter caps the management fee at 1.25%. The accrual in this batch is struck at 1.50%.',
    whyItMatters: 'The side letter is on your side and was never given to Meridian. The overcharge compounds every period it is missed.',
    raisedBy: ['Against your own documents'],
    assigneeId: 'p-halvorsen',
    assigneeReason: 'They advised on the side letter amendment.',
    flags: [],
    evidence: {
      label: 'Fenwick side letter · 11 Sept 2025 · §4.2',
      lines: [
        '"...the Management Fee payable by the Investor shall not exceed',
        ' one and one quarter per cent (1.25%) per annum of Commitments."',
        '',
        'Q1 2026 accrual                    1.50%  per annum',
      ],
    },
  },
  {
    id: 'i2',
    ref: 'TZ-012',
    location: 'staging!D2:D101',
    severity: 'material',
    status: 'open',
    statement: '30 rows carry a project code that does not resolve against the project master.',
    whyItMatters: 'Without a project code these rows cannot reach a fund, and the batch cannot be posted.',
    raisedBy: ['Unresolved reference data'],
    assigneeId: 'p-roos',
    assigneeReason: 'They own the staging load and the project master.',
    flags: [],
  },
  {
    id: 'i4',
    ref: 'TZ-018',
    location: 'upload!deals',
    severity: 'material',
    status: 'open',
    statement: '16 deals in the upload template do not appear on the deal master.',
    whyItMatters: 'These will fail on load, or worse, silently create duplicate deal records.',
    raisedBy: ['Unresolved reference data', 'Against your own documents'],
    assigneeId: 'p-roos',
    assigneeReason: 'They produced the upload template.',
    flags: [],
  },
  {
    id: 'i1',
    ref: 'TZ-002',
    location: 'staging!B2:B101',
    severity: 'presentational',
    status: 'open',
    statement: '41 of 52 rows carry a counterparty string that resolves to no entity on the master list.',
    whyItMatters:
      'Unmatched counterparties cannot be allocated or reported on. Eleven of the original 52 are bank charges, which carry no counterparty by agreement.',
    raisedBy: ['Unresolved reference data'],
    assigneeId: 'p-roos',
    assigneeReason: 'They own the staging load and the counterparty master.',
    flags: ['revised'],
    memory: {
      entryId: 'm-bank',
      effect: '11 rows excluded · severity dropped from material to presentational',
    },
  },
  {
    id: 'i5',
    ref: 'TZ-021',
    location: 'upload!investors',
    severity: 'presentational',
    status: 'open',
    statement: '198 investors in the upload template do not appear on the investor master.',
    whyItMatters: 'Most are expected to be new subscriptions, but the list has not been confirmed as such by anyone.',
    raisedBy: ['Unresolved reference data'],
    assigneeId: 'p-roos',
    assigneeReason: 'They produced the upload template.',
    flags: [],
  },
  {
    id: 'i6',
    ref: 'TZ-024',
    location: 'staging!rows 12, 19, 44',
    severity: 'question',
    status: 'open',
    statement: 'Three rows are flagged Review with no disposition recorded.',
    whyItMatters: 'The flag says somebody stopped on these. Nobody wrote down why, or what they decided.',
    raisedBy: ['Unresolved reference data'],
    assigneeId: 'p-roos',
    assigneeReason: 'They set the flag.',
    flags: ['new'],
  },
  {
    id: 'i12',
    ref: 'TZ-058',
    location: 'expenses!meeting costs',
    severity: 'question',
    status: 'open',
    statement: 'Seven meeting-cost rows need a stated purpose before they can be allocated.',
    whyItMatters: 'You are generally the only person who knows what each meeting was for.',
    raisedBy: ['Cephalus allocation watch'],
    assigneeId: 'p-self',
    assigneeReason: 'Nobody else holds this. It cannot be delegated.',
    flags: [],
  },
  {
    id: 'i13',
    ref: 'TZ-009',
    location: 'staging!row 61',
    severity: 'presentational',
    status: 'resolved',
    statement: 'GBP 4,120.00 narrated FENWICK RETAINER carried no project code.',
    whyItMatters: 'Unallocated retainer costs distort the mandate’s expense ratio.',
    raisedBy: ['Unresolved reference data'],
    assigneeId: 'p-halvorsen',
    assigneeReason: 'They hold the Fenwick mandate.',
    flags: [],
    resolution: 'Counsel confirmed it belongs to the Fenwick mandate. Project code FNW-01 applied.',
  },
  {
    id: 'i14',
    ref: 'TZ-015',
    location: 'recon!SEK',
    severity: 'presentational',
    status: 'resolved',
    statement: 'SEK reconciliation carried a 0.02 rounding break.',
    whyItMatters: 'Rounding breaks accumulate across periods if never cleared.',
    raisedBy: ['Arithmetic and bridges'],
    assigneeId: 'p-roos',
    assigneeReason: 'They own the reconciliation.',
    flags: [],
    resolution: 'Within the agreed rounding tolerance. No action.',
  },
];

/* ── Pending feedback ──────────────────────────────────────────────────────── */

export interface FeedbackLink {
  id: string;
  issueId: string;
  effect: 'RESOLVES' | 'PARTIAL' | 'CONTRADICTS' | 'CONTEXT';
  quote: string;
  reason: string;
  confidence: 'high' | 'medium' | 'low';
}

export const FEEDBACK_SOURCE = {
  from: 'Sigrid Halvorsen',
  received: '2 April 2026, 09:14',
  excerpt:
    'The 27 March payment is completion consideration under the SPA. The contractual rate for that date is 1.0389605 — schedule 4 fixes it, so no market rate applies. On the Fenwick point I will need to check the executed version of the side letter before confirming the cap; the draft I hold says 1.25% but there was an amendment in September.',
};

export const FEEDBACK_LINKS: FeedbackLink[] = [
  {
    id: 'fl1',
    issueId: 'i7',
    effect: 'RESOLVES',
    quote: 'The 27 March payment is completion consideration under the SPA.',
    reason: 'Names the payment and gives it a classification, which is exactly what the issue asked for.',
    confidence: 'high',
  },
  {
    id: 'fl2',
    issueId: 'i8',
    effect: 'CONTRADICTS',
    quote: 'The contractual rate for that date is 1.0389605 — schedule 4 fixes it, so no market rate applies.',
    reason:
      'Meridian booked the same day’s credits as internal transfers with no rate. Counsel says a contractual rate governs. Both cannot be right.',
    confidence: 'high',
  },
  {
    id: 'fl3',
    issueId: 'i9',
    effect: 'PARTIAL',
    quote: 'I will need to check the executed version of the side letter before confirming the cap.',
    reason: 'Confirms the 1.25% figure in the draft but not in the executed version. The amendment is still outstanding.',
    confidence: 'medium',
  },
];
