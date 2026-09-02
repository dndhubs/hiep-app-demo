import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle, ArrowDownRight, ArrowUpRight, BarChart3, Building2, Check, CheckCircle2,
  ChevronDown, ClipboardList, Clock, Download, ListChecks, Loader2, Lock, MapPin, Pencil,
  Plus, RefreshCw, Search, Shield, Trash2, Users, X
} from 'lucide-react';

/* ============================================================================
   HIEP — Health Income & Expenditure Platform
   Rivers State Primary Healthcare Management Board
   Demo build. All data is generated in-browser; the "server" below is a stand-in
   for the REST API described in the implementation blueprint.
   ========================================================================== */

/* ---------------------------------------------------------------------------
   1. Constants and small helpers
   ------------------------------------------------------------------------ */

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];
const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const FISCAL_YEAR = 2026;
const CLOSED_THROUGH = 8;            // September is the current, open period
const HIGH_VALUE_THRESHOLD = 500_000; // above this, only ES may approve
const STALE_REQUEST_DAYS = 14;

const naira = (n: number) => '₦' + Math.round(n || 0).toLocaleString('en-NG');

const nairaShort = (n: number) => {
  const v = Math.abs(n || 0);
  if (v >= 1_000_000) return `₦${(n / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `₦${Math.round(n / 1_000)}K`;
  return `₦${Math.round(n || 0)}`;
};

const sum = <T,>(rows: T[], fn: (row: T) => number) => rows.reduce((t, r) => t + fn(r), 0);

const dayStamp = (d: Date) =>
  `${String(d.getDate()).padStart(2, '0')} ${MONTHS_SHORT[d.getMonth()]} ${d.getFullYear()}`;

const daysBetween = (a: Date, b: Date) => Math.round((b.getTime() - a.getTime()) / 86_400_000);

function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ---------------------------------------------------------------------------
   2. Domain model
   ------------------------------------------------------------------------ */

type LedgerType = 'income' | 'expenditure';
type RoleCode = 'RO' | 'HOF' | 'MOH' | 'BOARD' | 'ES' | 'ADMIN';
type Scope = 'facility' | 'lga' | 'state';
type RequestStatus = 'pending' | 'approved' | 'rejected' | 'paid';

interface CatalogItem {
  id: string;
  ledger: LedgerType;
  label: string;
  code: string;
  active: boolean;
  system: boolean;      // seeded by the board; cannot be deleted, only archived
  updatedAt: Date;
}

interface Facility {
  id: string;
  name: string;
  type: 'Health Post' | 'Health Clinic' | 'Primary Health Centre';
  state: string;
  lga: string;
  ward: string;
  community: string;
}

interface Person {
  id: string;
  name: string;
  role: RoleCode;
  title: string;
  facilityId?: string;
  lga?: string;
}

interface IncomeEntry {
  id: string;
  facilityId: string;
  sourceId: string;
  sourceLabel: string;
  fromOther: boolean;
  amount: number;
  month: number;
  year: number;
  receivedOn: Date;
  reference: string;
  payer: string;
  note: string;
  recordedBy: Person;
  recordedAt: Date;
}

interface ExpenditureEntry {
  id: string;
  facilityId: string;
  categoryId: string;
  categoryLabel: string;
  fromOther: boolean;
  amount: number;
  month: number;
  year: number;
  payee: string;
  description: string;
  status: RequestStatus;
  requestedBy: Person;
  requestedAt: Date;
  decidedBy?: Person;
  decidedAt?: Date;
  decisionNote?: string;
}

type FlagCode = 'overspend' | 'no-income' | 'duplicate' | 'threshold-breach' | 'stalled-request';
type Severity = 'critical' | 'attention' | 'notice';

interface GovernanceFlag {
  id: string;
  code: FlagCode;
  severity: Severity;
  facilityId: string;
  month: number;
  year: number;
  entryId?: string;
  amount: number;
  headline: string;
  detail: string;
}

interface AuditEvent {
  id: string;
  at: Date;
  actor: string;
  role: RoleCode;
  action: string;
  detail: string;
}

/* ---------------------------------------------------------------------------
   3. Stand-in server — catalogue CRUD with latency
       Replace catalogApi with fetch() calls to /api/catalog in production.
   ------------------------------------------------------------------------ */

const seedCatalog: CatalogItem[] = [
  ['income', 'BHCPF', 'BHCPF', true],
  ['income', 'Internally Generated Revenue', 'IGR', true],
  ['income', 'RSCHPP', 'RSCHPP', true],
  ['income', 'Donor grant', 'DONOR', true],
  ['income', 'Community contribution', 'COMM', true],
  ['expenditure', 'Medicines', 'MED', true],
  ['expenditure', 'Vaccines', 'VAC', true],
  ['expenditure', 'Outreach', 'OUT', true],
  ['expenditure', 'Maintenance', 'MNT', true],
  ['expenditure', 'Salary', 'SAL', true],
  ['expenditure', 'Cleaning supplies', 'CLN', true],
  ['expenditure', 'WDC meetings', 'WDC', true],
  ['expenditure', 'TBA commission', 'TBA', true],
  ['expenditure', 'Utilities', 'UTL', false],
  ['expenditure', 'Transport', 'TRP', false],
].map(([ledger, label, code, system], i) => ({
  id: `cat-${i + 1}`,
  ledger: ledger as LedgerType,
  label: label as string,
  code: code as string,
  active: true,
  system: system as boolean,
  updatedAt: new Date(2026, 0, 12),
}));

let catalogTable = [...seedCatalog];
let catalogSeq = catalogTable.length;

const wait = <T,>(value: T, ms = 320) => new Promise<T>(resolve => setTimeout(() => resolve(value), ms));

const catalogApi = {
  list: () => wait(catalogTable.map(c => ({ ...c }))),
  create: (input: { ledger: LedgerType; label: string; code: string }) => {
    const clash = catalogTable.some(
      c => c.ledger === input.ledger && c.label.toLowerCase() === input.label.trim().toLowerCase()
    );
    if (clash) {
      return new Promise<CatalogItem>((_, reject) =>
        setTimeout(() => reject(new Error(`${input.label.trim()} is already on the list.`)), 320));
    }
    catalogSeq += 1;
    const row: CatalogItem = {
      id: `cat-${catalogSeq}`,
      ledger: input.ledger,
      label: input.label.trim(),
      code: (input.code || input.label.slice(0, 3)).toUpperCase().trim(),
      active: true,
      system: false,
      updatedAt: new Date(),
    };
    catalogTable = [...catalogTable, row];
    return wait({ ...row });
  },
  update: (id: string, patch: Partial<CatalogItem>) => {
    catalogTable = catalogTable.map(c => (c.id === id ? { ...c, ...patch, updatedAt: new Date() } : c));
    return wait(catalogTable.find(c => c.id === id)!);
  },
  remove: (id: string) => {
    catalogTable = catalogTable.filter(c => c.id !== id);
    return wait({ id });
  },
};

/* ---------------------------------------------------------------------------
   4. Seed data — facilities, people, ledgers
   ------------------------------------------------------------------------ */

const facilities: Facility[] = [
  { id: 'f1', name: 'Igbo I Health Clinic', type: 'Health Clinic', state: 'Rivers', lga: 'Etche', ward: 'Igbo I', community: 'Imeh' },
  { id: 'f2', name: 'Okehi Primary Health Centre', type: 'Primary Health Centre', state: 'Rivers', lga: 'Etche', ward: 'Okehi', community: 'Okehi' },
  { id: 'f3', name: 'Ulakwo Health Post', type: 'Health Post', state: 'Rivers', lga: 'Etche', ward: 'Ulakwo', community: 'Ulakwo' },
  { id: 'f4', name: 'Akabuka Health Clinic', type: 'Health Clinic', state: 'Rivers', lga: 'Ogba-Egbema-Ndoni', ward: 'Ndoni Central II', community: 'Akabuka' },
  { id: 'f5', name: 'Omoku Primary Health Centre', type: 'Primary Health Centre', state: 'Rivers', lga: 'Ogba-Egbema-Ndoni', ward: 'Omoku I', community: 'Omoku' },
  { id: 'f6', name: 'Obororu Health Clinic', type: 'Health Clinic', state: 'Rivers', lga: 'Opobo-Nkoro', ward: 'Obororu', community: 'Obororu' },
  { id: 'f7', name: 'Kalaibiama Health Post', type: 'Health Post', state: 'Rivers', lga: 'Opobo-Nkoro', ward: 'Kalaibiama', community: 'Kalaibiama' },
  { id: 'f8', name: 'Eliozu Primary Health Centre', type: 'Primary Health Centre', state: 'Rivers', lga: 'Port Harcourt', ward: 'Ward 11', community: 'Eliozu' },
  { id: 'f9', name: 'Waterlines Health Clinic', type: 'Health Clinic', state: 'Rivers', lga: 'Port Harcourt', ward: 'Ward 3', community: 'Waterlines' },
  { id: 'f10', name: 'Ngo Primary Health Centre', type: 'Primary Health Centre', state: 'Rivers', lga: 'Andoni', ward: 'Ngo Town', community: 'Ngo' },
  { id: 'f11', name: 'Asarama Health Post', type: 'Health Post', state: 'Rivers', lga: 'Andoni', ward: 'Asarama', community: 'Asarama' },
  { id: 'f12', name: 'Ahoada Central Health Clinic', type: 'Health Clinic', state: 'Rivers', lga: 'Ahoada East', ward: 'Ahoada Town', community: 'Ahoada' },
];

const facilityById = (id: string) => facilities.find(f => f.id === id);

const people: Person[] = [
  { id: 'p1', name: 'Blessing Amadi', role: 'RO', title: 'Revenue Officer', facilityId: 'f1', lga: 'Etche' },
  { id: 'p2', name: 'Sunday Wike', role: 'HOF', title: 'Head of Facility', facilityId: 'f1', lga: 'Etche' },
  { id: 'p3', name: 'Dr. Ngozi Eke', role: 'MOH', title: 'Medical Officer of Health, Etche', lga: 'Etche' },
  { id: 'p4', name: 'Hon. Ibiso Green', role: 'BOARD', title: 'Board Member, Finance & Audit' },
  { id: 'p5', name: 'Dr. Tamuno Briggs', role: 'ES', title: 'Executive Secretary' },
  { id: 'p6', name: 'Ekene Nwosu', role: 'ADMIN', title: 'System Administrator' },
];

const otherOfficers: Person[] = [
  { id: 'p7', name: 'Grace Owhonda', role: 'RO', title: 'Revenue Officer', facilityId: 'f5', lga: 'Ogba-Egbema-Ndoni' },
  { id: 'p8', name: 'Emeka Duru', role: 'HOF', title: 'Head of Facility', facilityId: 'f8', lga: 'Port Harcourt' },
  { id: 'p9', name: 'Dr. Soibi Fubara', role: 'MOH', title: 'Medical Officer of Health, Port Harcourt', lga: 'Port Harcourt' },
];

const staffFor = (facilityId: string, role: RoleCode): Person => {
  const facility = facilityById(facilityId)!;
  const match = [...people, ...otherOfficers].find(p => p.role === role && p.facilityId === facilityId);
  if (match) return match;
  const suffix = facility.name.split(' ')[0];
  return role === 'RO'
    ? { id: `ro-${facilityId}`, name: `${suffix} Revenue Desk`, role: 'RO', title: 'Revenue Officer', facilityId, lga: facility.lga }
    : { id: `hof-${facilityId}`, name: `${suffix} Facility Head`, role: 'HOF', title: 'Head of Facility', facilityId, lga: facility.lga };
};

const approverFor = (lga: string): Person =>
  [...people, ...otherOfficers].find(p => p.role === 'MOH' && p.lga === lga)
  ?? { id: `moh-${lga}`, name: `MOH ${lga}`, role: 'MOH', title: `Medical Officer of Health, ${lga}`, lga };

function buildLedgers() {
  const rng = mulberry32(20260209);
  const between = (a: number, b: number) => a + rng() * (b - a);
  const step = (n: number, s: number) => Math.round(n / s) * s;

  const income: IncomeEntry[] = [];
  const expenditure: ExpenditureEntry[] = [];
  let iSeq = 0;
  let eSeq = 0;

  const incomeRules = [
    { code: 'BHCPF', label: 'BHCPF', payer: 'NPHCDA / State BHCPF Desk', when: (m: number) => m % 3 === 0, min: 700_000, max: 1_800_000 },
    { code: 'IGR', label: 'Internally Generated Revenue', payer: 'Facility revenue desk', when: () => rng() > 0.08, min: 70_000, max: 380_000 },
    { code: 'RSCHPP', label: 'RSCHPP', payer: 'Rivers State Contributory Health Scheme', when: () => rng() > 0.3, min: 140_000, max: 620_000 },
    { code: 'DONOR', label: 'Donor grant', payer: 'UNICEF Rivers field office', when: () => rng() > 0.85, min: 200_000, max: 900_000 },
  ];

  const spendRules = [
    { label: 'Salary', payee: 'Facility staff payroll', chance: 1, min: 180_000, max: 620_000 },
    { label: 'Medicines', payee: 'Rivers State Drug Revolving Fund', chance: 0.9, min: 120_000, max: 780_000 },
    { label: 'Vaccines', payee: 'State Cold Store', chance: 0.45, min: 60_000, max: 340_000 },
    { label: 'Outreach', payee: 'Ward outreach team', chance: 0.6, min: 40_000, max: 260_000 },
    { label: 'Maintenance', payee: 'Local contractor', chance: 0.45, min: 35_000, max: 420_000 },
    { label: 'Cleaning supplies', payee: 'Market purchase', chance: 0.75, min: 12_000, max: 70_000 },
    { label: 'WDC meetings', payee: 'Ward Development Committee', chance: 0.65, min: 15_000, max: 90_000 },
    { label: 'TBA commission', payee: 'Traditional birth attendants', chance: 0.5, min: 10_000, max: 65_000 },
  ];

  facilities.forEach((facility, fi) => {
    const size = facility.type === 'Primary Health Centre' ? 1.35 : facility.type === 'Health Clinic' ? 1 : 0.62;

    for (let m = 0; m <= CLOSED_THROUGH; m += 1) {
      incomeRules.forEach(rule => {
        if (!rule.when(m)) return;
        iSeq += 1;
        const day = Math.max(1, Math.round(between(2, 26)));
        income.push({
          id: `inc-${iSeq}`,
          facilityId: facility.id,
          sourceId: `cat-${seedCatalog.findIndex(c => c.code === rule.code) + 1}`,
          sourceLabel: rule.label,
          fromOther: false,
          amount: step(between(rule.min, rule.max) * size, 500),
          month: m,
          year: FISCAL_YEAR,
          receivedOn: new Date(FISCAL_YEAR, m, day),
          reference: `${rule.code}/${FISCAL_YEAR}/${String(m + 1).padStart(2, '0')}/${100 + iSeq}`,
          payer: rule.payer,
          note: '',
          recordedBy: staffFor(facility.id, 'RO'),
          recordedAt: new Date(FISCAL_YEAR, m, Math.min(28, day + 1)),
        });
      });

      spendRules.forEach(rule => {
        if (rng() > rule.chance) return;
        eSeq += 1;
        const day = Math.max(1, Math.round(between(3, 27)));
        const requestedAt = new Date(FISCAL_YEAR, m, day);
        const amount = step(between(rule.min, rule.max) * size * 0.6, 500);
        const isOpenMonth = m >= CLOSED_THROUGH;
        const roll = rng();
        let status: RequestStatus = 'paid';
        if (isOpenMonth) status = roll > 0.55 ? 'pending' : 'approved';
        else if (roll > 0.94) status = 'rejected';
        else if (roll > 0.88) status = 'approved';

        const decided = status !== 'pending';
        const approver = amount >= HIGH_VALUE_THRESHOLD && rng() > 0.4
          ? people.find(p => p.role === 'ES')!
          : approverFor(facility.lga);

        expenditure.push({
          id: `exp-${eSeq}`,
          facilityId: facility.id,
          categoryId: `cat-${seedCatalog.findIndex(c => c.label === rule.label) + 1}`,
          categoryLabel: rule.label,
          fromOther: false,
          amount,
          month: m,
          year: FISCAL_YEAR,
          payee: rule.payee,
          description: `${rule.label} — ${MONTHS[m]} ${FISCAL_YEAR}`,
          status,
          requestedBy: staffFor(facility.id, 'HOF'),
          requestedAt,
          decidedBy: decided ? approver : undefined,
          decidedAt: decided ? new Date(FISCAL_YEAR, m, Math.min(28, day + 3)) : undefined,
          decisionNote: status === 'rejected' ? 'Quotation not attached. Resubmit with three quotes.' : undefined,
        });
      });
    }

    // A couple of deliberate governance cases so the demo has something to show.
    if (fi === 1) {
      eSeq += 1;
      expenditure.push({
        id: `exp-${eSeq}`,
        facilityId: facility.id,
        categoryId: 'cat-6',
        categoryLabel: 'Medicines',
        fromOther: false,
        amount: 1_450_000,
        month: 6,
        year: FISCAL_YEAR,
        payee: 'Ochendo Pharmaceuticals Ltd',
        description: 'Bulk antimalarial restock ahead of rainy season',
        status: 'paid',
        requestedBy: staffFor(facility.id, 'HOF'),
        requestedAt: new Date(FISCAL_YEAR, 6, 9),
        decidedBy: approverFor(facility.lga),
        decidedAt: new Date(FISCAL_YEAR, 6, 10),
      });
    }
    if (fi === 4) {
      [0, 1].forEach(k => {
        eSeq += 1;
        expenditure.push({
          id: `exp-${eSeq}`,
          facilityId: facility.id,
          categoryId: 'cat-13',
          categoryLabel: 'WDC meetings',
          fromOther: false,
          amount: 85_000,
          month: 5,
          year: FISCAL_YEAR,
          payee: 'Ward Development Committee',
          description: 'Quarterly WDC sitting allowance',
          status: 'paid',
          requestedBy: staffFor(facility.id, 'HOF'),
          requestedAt: new Date(FISCAL_YEAR, 5, 12 + k * 4),
          decidedBy: approverFor(facility.lga),
          decidedAt: new Date(FISCAL_YEAR, 5, 14 + k * 4),
        });
      });
    }
    if (fi === 8) {
      eSeq += 1;
      expenditure.push({
        id: `exp-${eSeq}`,
        facilityId: facility.id,
        categoryId: 'other',
        categoryLabel: 'Borehole repair',
        fromOther: true,
        amount: 240_000,
        month: 7,
        year: FISCAL_YEAR,
        payee: 'Rivers Waterworks',
        description: 'Submersible pump replacement',
        status: 'pending',
        requestedBy: staffFor(facility.id, 'HOF'),
        requestedAt: new Date(FISCAL_YEAR, 7, 4),
      });
    }
  });

  // One facility-month left without an income posting, so the demo exercises that rule.
  const gap = income.filter(i => !(i.facilityId === 'f11' && i.month === 3));

  return { income: gap, expenditure };
}

const seeded = buildLedgers();

/* ---------------------------------------------------------------------------
   5. Governance engine — five rules, recomputed from the ledgers
   ------------------------------------------------------------------------ */

function computeFlags(income: IncomeEntry[], expenditure: ExpenditureEntry[]): GovernanceFlag[] {
  const flags: GovernanceFlag[] = [];
  const today = new Date(FISCAL_YEAR, CLOSED_THROUGH, 2);
  const committed = (e: ExpenditureEntry) => e.status === 'approved' || e.status === 'paid';

  facilities.forEach(facility => {
    const fInc = income.filter(i => i.facilityId === facility.id);
    const fExp = expenditure.filter(e => e.facilityId === facility.id);
    let runningIn = 0;
    let runningOut = 0;
    let alreadyOver = false;

    for (let m = 0; m <= CLOSED_THROUGH; m += 1) {
      const monthIn = sum(fInc.filter(i => i.month === m), i => i.amount);
      const monthOut = sum(fExp.filter(e => e.month === m && committed(e)), e => e.amount);
      runningIn += monthIn;
      runningOut += monthOut;
      if (runningOut <= runningIn) alreadyOver = false;

      if (runningOut > runningIn && !alreadyOver) {
        alreadyOver = true;
        flags.push({
          id: `flg-over-${facility.id}-${m}`,
          code: 'overspend',
          severity: 'critical',
          facilityId: facility.id,
          month: m,
          year: FISCAL_YEAR,
          amount: runningOut - runningIn,
          headline: 'Spending has passed money received',
          detail: `By the end of ${MONTHS[m]}, committed spending of ${naira(runningOut)} exceeds recorded income of ${naira(runningIn)}.`,
        });
      }

      if (monthIn === 0 && monthOut > 0) {
        flags.push({
          id: `flg-noinc-${facility.id}-${m}`,
          code: 'no-income',
          severity: 'attention',
          facilityId: facility.id,
          month: m,
          year: FISCAL_YEAR,
          amount: monthOut,
          headline: 'Spending recorded with no income entry',
          detail: `${MONTHS[m]} has ${naira(monthOut)} of spending but the revenue officer has not posted any income for the month.`,
        });
      }
    }

    // Duplicate: same category and amount twice in one month.
    const seen = new Map<string, ExpenditureEntry>();
    fExp.forEach(e => {
      const key = `${e.month}|${e.categoryLabel.toLowerCase()}|${e.amount}`;
      if (seen.has(key)) {
        flags.push({
          id: `flg-dup-${e.id}`,
          code: 'duplicate',
          severity: 'attention',
          facilityId: facility.id,
          month: e.month,
          year: e.year,
          entryId: e.id,
          amount: e.amount,
          headline: 'Possible duplicate request',
          detail: `${e.categoryLabel} for ${naira(e.amount)} appears twice in ${MONTHS[e.month]}.`,
        });
      } else {
        seen.set(key, e);
      }
    });

    fExp.forEach(e => {
      if (e.amount >= HIGH_VALUE_THRESHOLD && e.decidedBy && e.decidedBy.role !== 'ES' && e.status !== 'rejected') {
        flags.push({
          id: `flg-thr-${e.id}`,
          code: 'threshold-breach',
          severity: 'critical',
          facilityId: facility.id,
          month: e.month,
          year: e.year,
          entryId: e.id,
          amount: e.amount,
          headline: 'Approved below the required level',
          detail: `${naira(e.amount)} for ${e.categoryLabel} needs the Executive Secretary. It was cleared by ${e.decidedBy.name} (${e.decidedBy.role}).`,
        });
      }
      if (e.status === 'pending' && daysBetween(e.requestedAt, today) > STALE_REQUEST_DAYS) {
        flags.push({
          id: `flg-stale-${e.id}`,
          code: 'stalled-request',
          severity: 'notice',
          facilityId: facility.id,
          month: e.month,
          year: e.year,
          entryId: e.id,
          amount: e.amount,
          headline: 'Request waiting too long',
          detail: `Submitted ${dayStamp(e.requestedAt)} and still not decided after ${daysBetween(e.requestedAt, today)} days.`,
        });
      }
    });
  });

  const rank: Record<Severity, number> = { critical: 0, attention: 1, notice: 2 };
  return flags.sort((a, b) => rank[a.severity] - rank[b.severity] || b.month - a.month);
}

/* ---------------------------------------------------------------------------
   6. Roles and permissions
   ------------------------------------------------------------------------ */

type Permission =
  | 'income:create' | 'income:read'
  | 'expenditure:create' | 'expenditure:read' | 'expenditure:approve'
  | 'analytics:facility' | 'analytics:lga' | 'analytics:state'
  | 'governance:read' | 'governance:resolve'
  | 'catalog:manage' | 'audit:read';

const ROLES: Record<RoleCode, { label: string; scope: Scope; can: Permission[] }> = {
  RO: {
    label: 'Revenue Officer',
    scope: 'facility',
    can: ['income:create', 'income:read', 'analytics:facility'],
  },
  HOF: {
    label: 'Head of Facility',
    scope: 'facility',
    can: ['expenditure:create', 'expenditure:read', 'income:read', 'analytics:facility', 'governance:read'],
  },
  MOH: {
    label: 'Medical Officer of Health',
    scope: 'lga',
    can: ['expenditure:read', 'expenditure:approve', 'income:read', 'analytics:facility', 'analytics:lga',
      'governance:read', 'governance:resolve'],
  },
  BOARD: {
    label: 'Board Member',
    scope: 'state',
    can: ['expenditure:read', 'income:read', 'analytics:facility', 'analytics:lga', 'analytics:state', 'governance:read'],
  },
  ES: {
    label: 'Executive Secretary',
    scope: 'state',
    can: ['expenditure:read', 'expenditure:approve', 'income:read', 'analytics:facility', 'analytics:lga',
      'analytics:state', 'governance:read', 'governance:resolve'],
  },
  ADMIN: {
    label: 'System Administrator',
    scope: 'state',
    can: ['income:read', 'expenditure:read', 'analytics:facility', 'analytics:lga', 'analytics:state',
      'governance:read', 'catalog:manage', 'audit:read'],
  },
};

const allows = (user: Person, permission: Permission) => ROLES[user.role].can.includes(permission);

const scopeOf = (user: Person) => {
  const scope = ROLES[user.role].scope;
  if (scope === 'facility') return facilities.filter(f => f.id === user.facilityId);
  if (scope === 'lga') return facilities.filter(f => f.lga === user.lga);
  return facilities;
};

const canDecide = (user: Person, entry: ExpenditureEntry) => {
  if (!allows(user, 'expenditure:approve') || entry.status !== 'pending') return false;
  if (user.role === 'ES') return true;
  const facility = facilityById(entry.facilityId);
  return user.role === 'MOH' && facility?.lga === user.lga && entry.amount < HIGH_VALUE_THRESHOLD;
};

/* ---------------------------------------------------------------------------
   7. Root component
   ------------------------------------------------------------------------ */

type TabId = 'dashboard' | 'income' | 'expenditure' | 'governance' | 'catalogue' | 'audit';

export default function HealthIncomeExpenditurePlatform() {
  const [user, setUser] = useState<Person>(people[1]);
  const [tab, setTab] = useState<TabId>('dashboard');
  const [income, setIncome] = useState<IncomeEntry[]>(seeded.income);
  const [expenditure, setExpenditure] = useState<ExpenditureEntry[]>(seeded.expenditure);
  const [catalog, setCatalog] = useState<CatalogItem[]>([]);
  const [catalogState, setCatalogState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [resolved, setResolved] = useState<Record<string, string>>({});
  const [audit, setAudit] = useState<AuditEvent[]>([]);
  const [toast, setToast] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null);

  const loadCatalog = useCallback(() => {
    setCatalogState('loading');
    catalogApi.list()
      .then(rows => { setCatalog(rows); setCatalogState('ready'); })
      .catch(() => setCatalogState('error'));
  }, []);

  useEffect(loadCatalog, [loadCatalog]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 3600);
    return () => clearTimeout(t);
  }, [toast]);

  const log = useCallback((action: string, detail: string, actor: Person) => {
    setAudit(prev => [{
      id: `aud-${Date.now()}-${Math.round(Math.random() * 999)}`,
      at: new Date(), actor: actor.name, role: actor.role, action, detail,
    }, ...prev]);
  }, []);

  const visibleFacilities = useMemo(() => scopeOf(user), [user]);
  const visibleIds = useMemo(() => new Set(visibleFacilities.map(f => f.id)), [visibleFacilities]);
  const scopedIncome = useMemo(() => income.filter(i => visibleIds.has(i.facilityId)), [income, visibleIds]);
  const scopedExpenditure = useMemo(() => expenditure.filter(e => visibleIds.has(e.facilityId)), [expenditure, visibleIds]);
  const flags = useMemo(() => computeFlags(income, expenditure), [income, expenditure]);
  const scopedFlags = useMemo(
    () => flags.filter(f => visibleIds.has(f.facilityId) && !resolved[f.id]),
    [flags, visibleIds, resolved]
  );

  const tabs: { id: TabId; label: string; icon: any; show: boolean; badge?: number }[] = [
    { id: 'dashboard', label: 'Overview', icon: BarChart3, show: allows(user, 'analytics:facility') },
    { id: 'income', label: 'Income', icon: ArrowDownRight, show: allows(user, 'income:read') },
    { id: 'expenditure', label: 'Expenditure', icon: ArrowUpRight, show: allows(user, 'expenditure:read') },
    { id: 'governance', label: 'Checks', icon: Shield, show: allows(user, 'governance:read'), badge: scopedFlags.length },
    { id: 'catalogue', label: 'Lists', icon: ListChecks, show: allows(user, 'catalog:manage') },
    { id: 'audit', label: 'Activity', icon: ClipboardList, show: allows(user, 'audit:read') },
  ];

  useEffect(() => {
    if (!tabs.some(t => t.id === tab && t.show)) setTab(tabs.find(t => t.show)!.id as TabId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  const switchUser = (next: Person) => {
    setUser(next);
    setToast({ tone: 'ok', text: `Signed in as ${next.name} — ${ROLES[next.role].label}` });
  };

  const addIncome = (entry: IncomeEntry) => {
    setIncome(prev => [entry, ...prev]);
    log('Income recorded', `${entry.sourceLabel} ${naira(entry.amount)} · ${MONTHS[entry.month]} · ${facilityById(entry.facilityId)?.name}`, user);
    setToast({ tone: 'ok', text: `${naira(entry.amount)} added to the ${MONTHS[entry.month]} income ledger.` });
  };

  const addExpenditure = (entry: ExpenditureEntry) => {
    setExpenditure(prev => [entry, ...prev]);
    log('Expenditure requested', `${entry.categoryLabel} ${naira(entry.amount)} · ${MONTHS[entry.month]} · ${facilityById(entry.facilityId)?.name}`, user);
    setToast({ tone: 'ok', text: `Request for ${naira(entry.amount)} sent for approval.` });
  };

  const decide = (entry: ExpenditureEntry, status: RequestStatus, note?: string) => {
    setExpenditure(prev => prev.map(e => (e.id === entry.id
      ? { ...e, status, decidedBy: user, decidedAt: new Date(), decisionNote: note }
      : e)));
    log(status === 'approved' ? 'Expenditure approved' : 'Expenditure rejected',
      `${entry.categoryLabel} ${naira(entry.amount)} · ${facilityById(entry.facilityId)?.name}`, user);
    setToast({ tone: status === 'approved' ? 'ok' : 'bad', text: `Request ${status}.` });
  };

  const resolveFlag = (flag: GovernanceFlag, note: string) => {
    setResolved(prev => ({ ...prev, [flag.id]: note }));
    log('Check closed', `${flag.headline} · ${facilityById(flag.facilityId)?.name} · ${note}`, user);
    setToast({ tone: 'ok', text: 'Check closed with a note.' });
  };

  return (
    <div className="min-h-screen w-full flex flex-col bg-[#EEF1F2] text-[#10202B]">
      <TopBar user={user} onSwitch={switchUser} flagCount={scopedFlags.length} />

      <nav className="bg-white border-b border-[#DCE3E5] sticky top-0 z-20">
        <div className="mx-auto w-full max-w-[1440px] px-4 sm:px-6 flex gap-1 overflow-x-auto">
          {tabs.filter(t => t.show).map(({ id, label, icon: Icon, badge }) => (
            <button
              key={id}
              onClick={() => setTab(id)}
              className={`flex items-center gap-2 whitespace-nowrap px-4 py-3 text-[13px] font-medium border-b-2 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[#10202B] ${
                tab === id
                  ? 'border-[#10202B] text-[#10202B]'
                  : 'border-transparent text-[#5C6E79] hover:text-[#10202B]'
              }`}
            >
              <Icon className="w-4 h-4" strokeWidth={1.75} />
              {label}
              {!!badge && (
                <span className="ml-0.5 min-w-[18px] rounded-full bg-[#B3261E] px-1.5 text-[10px] leading-[18px] text-white text-center">
                  {badge}
                </span>
              )}
            </button>
          ))}
        </div>
      </nav>

      <main className="mx-auto w-full max-w-[1440px] flex-1 px-4 sm:px-6 py-6">
        {tab === 'dashboard' && (
          <Overview
            user={user}
            facilities={visibleFacilities}
            income={scopedIncome}
            expenditure={scopedExpenditure}
            flags={scopedFlags}
          />
        )}
        {tab === 'income' && (
          <IncomeLedger
            user={user}
            facilities={visibleFacilities}
            entries={scopedIncome}
            catalog={catalog}
            catalogState={catalogState}
            onRetryCatalog={loadCatalog}
            onAdd={addIncome}
          />
        )}
        {tab === 'expenditure' && (
          <ExpenditureLedger
            user={user}
            facilities={visibleFacilities}
            entries={scopedExpenditure}
            income={scopedIncome}
            catalog={catalog}
            catalogState={catalogState}
            onRetryCatalog={loadCatalog}
            onAdd={addExpenditure}
            onDecide={decide}
          />
        )}
        {tab === 'governance' && (
          <Checks user={user} flags={scopedFlags} resolvedCount={Object.keys(resolved).length} onResolve={resolveFlag} />
        )}
        {tab === 'catalogue' && (
          <Catalogue
            user={user}
            catalog={catalog}
            state={catalogState}
            income={income}
            expenditure={expenditure}
            onReload={loadCatalog}
            onChanged={(rows, message, detail) => {
              setCatalog(rows);
              log('List updated', detail, user);
              setToast({ tone: 'ok', text: message });
            }}
            onError={message => setToast({ tone: 'bad', text: message })}
          />
        )}
        {tab === 'audit' && <ActivityLog events={audit} />}
      </main>

      {toast && (
        <div
          role="status"
          className={`fixed bottom-5 right-5 z-50 flex items-center gap-2 rounded border px-4 py-3 text-[13px] shadow-lg ${
            toast.tone === 'ok'
              ? 'border-[#B7D6C6] bg-[#E3F0EA] text-[#0F6B4A]'
              : 'border-[#EBC3BE] bg-[#FBE9E7] text-[#B3261E]'
          }`}
        >
          {toast.tone === 'ok' ? <CheckCircle2 className="w-4 h-4" /> : <AlertTriangle className="w-4 h-4" />}
          {toast.text}
        </div>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------------------
   8. Chrome
   ------------------------------------------------------------------------ */

function TopBar({ user, onSwitch, flagCount }: { user: Person; onSwitch: (p: Person) => void; flagCount: number }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, []);

  const where = ROLES[user.role].scope === 'facility'
    ? facilityById(user.facilityId!)?.name
    : ROLES[user.role].scope === 'lga' ? `${user.lga} LGA` : 'Rivers State';

  return (
    <header className="bg-[#10202B] text-white">
      <div className="mx-auto w-full max-w-[1440px] px-4 sm:px-6 py-3 flex items-center justify-between gap-4">
        <div className="flex items-baseline gap-3 min-w-0">
          <span className="text-[19px] font-semibold tracking-tight">HIEP</span>
          <span className="hidden sm:block text-[12px] text-[#9FB4BF] truncate">
            Health Income &amp; Expenditure Platform · Rivers State PHCMB
          </span>
        </div>

        <div className="flex items-center gap-3">
          <span className="hidden md:inline text-[11px] text-[#9FB4BF] tabular-nums">
            {FISCAL_YEAR} fiscal year · {flagCount} open {flagCount === 1 ? 'check' : 'checks'}
          </span>
          <div className="relative" ref={box}>
            <button
              onClick={() => setOpen(o => !o)}
              className="flex items-center gap-2 rounded border border-[#2C3F4C] bg-[#16303F] px-3 py-1.5 text-left hover:border-[#476272] focus:outline-none focus-visible:ring-2 focus-visible:ring-white"
            >
              <span className="grid h-7 w-7 place-items-center rounded-full bg-[#0F6B4A] text-[11px] font-semibold">
                {user.role === 'BOARD' ? 'BD' : user.role.slice(0, 2)}
              </span>
              <span className="hidden sm:block leading-tight">
                <span className="block text-[12px] font-medium">{user.name}</span>
                <span className="block text-[10px] text-[#9FB4BF]">{ROLES[user.role].label} · {where}</span>
              </span>
              <ChevronDown className="w-4 h-4 text-[#9FB4BF]" />
            </button>

            {open && (
              <div className="absolute right-0 mt-2 w-72 rounded border border-[#DCE3E5] bg-white p-1 text-[#10202B] shadow-xl">
                <p className="px-3 py-2 text-[11px] text-[#5C6E79]">
                  Demo sign-in. Pick a role to see what that officer can do.
                </p>
                {people.map(p => (
                  <button
                    key={p.id}
                    onClick={() => { onSwitch(p); setOpen(false); }}
                    className={`w-full rounded px-3 py-2 text-left hover:bg-[#F1F5F6] ${p.id === user.id ? 'bg-[#F1F5F6]' : ''}`}
                  >
                    <span className="block text-[13px] font-medium">{p.name}</span>
                    <span className="block text-[11px] text-[#5C6E79]">{p.title}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </header>
  );
}

/* ---------------------------------------------------------------------------
   9. Shared pieces
   ------------------------------------------------------------------------ */

function Panel({ title, description, action, children, className = '' }: any) {
  return (
    <section className={`rounded border border-[#DCE3E5] bg-white ${className}`}>
      {(title || action) && (
        <header className="flex items-start justify-between gap-4 border-b border-[#E7ECEE] px-5 py-4">
          <div>
            <h2 className="text-[15px] font-semibold">{title}</h2>
            {description && <p className="mt-0.5 text-[12px] text-[#5C6E79]">{description}</p>}
          </div>
          {action}
        </header>
      )}
      <div className="p-5">{children}</div>
    </section>
  );
}

function Figure({ label, value, note, tone = 'neutral' }: any) {
  const colour = tone === 'in' ? 'text-[#0F6B4A]' : tone === 'out' ? 'text-[#A45B12]' : tone === 'bad' ? 'text-[#B3261E]' : 'text-[#10202B]';
  return (
    <div className="rounded border border-[#DCE3E5] bg-white px-5 py-4">
      <p className="text-[12px] text-[#5C6E79]">{label}</p>
      <p className={`mt-1.5 text-[26px] font-semibold leading-none tabular-nums ${colour}`}>{value}</p>
      {note && <p className="mt-2 text-[11px] text-[#5C6E79]">{note}</p>}
    </div>
  );
}

function Field({ label, hint, children }: any) {
  return (
    <label className="block">
      <span className="block text-[12px] font-medium text-[#33454F]">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-[11px] text-[#5C6E79]">{hint}</span>}
    </label>
  );
}

const inputClass =
  'mt-1 w-full rounded border border-[#C9D4D8] bg-white px-3 py-2 text-[13px] text-[#10202B] ' +
  'placeholder:text-[#8FA2AB] focus:border-[#10202B] focus:outline-none focus:ring-1 focus:ring-[#10202B]';

function StatusChip({ status }: { status: RequestStatus }) {
  const map: Record<RequestStatus, string> = {
    pending: 'border-[#E2CDA6] bg-[#FBF3E2] text-[#8A6412]',
    approved: 'border-[#B7D6C6] bg-[#E3F0EA] text-[#0F6B4A]',
    paid: 'border-[#C3D3DA] bg-[#EDF2F4] text-[#33454F]',
    rejected: 'border-[#EBC3BE] bg-[#FBE9E7] text-[#B3261E]',
  };
  const label = { pending: 'Awaiting approval', approved: 'Approved', paid: 'Paid', rejected: 'Rejected' }[status];
  return <span className={`inline-block rounded border px-2 py-0.5 text-[11px] ${map[status]}`}>{label}</span>;
}

/** Month strip: pick the ledger period. */
function MonthStrip({ value, onChange, disabledAfter = 11 }: { value: number; onChange: (m: number) => void; disabledAfter?: number }) {
  return (
    <div className="flex gap-1 overflow-x-auto rounded border border-[#DCE3E5] bg-white p-1">
      {MONTHS_SHORT.map((m, i) => {
        const locked = i > disabledAfter;
        return (
          <button
            key={m}
            disabled={locked}
            onClick={() => onChange(i)}
            className={`min-w-[52px] rounded px-3 py-1.5 text-[12px] font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[#10202B] ${
              value === i ? 'bg-[#10202B] text-white'
                : locked ? 'text-[#B4C2C8] cursor-not-allowed'
                : 'text-[#33454F] hover:bg-[#F1F5F6]'
            }`}
          >
            {m}
          </button>
        );
      })}
    </div>
  );
}

/**
 * Autocomplete over the server-held list, with a free-text "other" escape hatch.
 * Anything typed that is not on the list is stored as an "other" entry and shows
 * up in the admin's Lists tab as a suggestion that can be promoted.
 */
function CatalogPicker({
  items, state, value, onChange, onRetry, placeholder,
}: {
  items: CatalogItem[];
  state: 'loading' | 'ready' | 'error';
  value: { id: string; label: string; fromOther: boolean } | null;
  onChange: (v: { id: string; label: string; fromOther: boolean } | null) => void;
  onRetry: () => void;
  placeholder: string;
}) {
  const [text, setText] = useState(value?.label ?? '');
  const [open, setOpen] = useState(false);
  const [cursor, setCursor] = useState(0);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => setText(value?.label ?? ''), [value]);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, []);

  const active = items.filter(i => i.active);
  const query = text.trim().toLowerCase();
  const matches = query ? active.filter(i => i.label.toLowerCase().includes(query)) : active;
  const exact = active.some(i => i.label.toLowerCase() === query);
  const offerOther = query.length > 1 && !exact;
  const options = [
    ...matches.map(m => ({ kind: 'item' as const, item: m })),
    ...(offerOther ? [{ kind: 'other' as const, item: null }] : []),
  ];

  const choose = (index: number) => {
    const option = options[index];
    if (!option) return;
    const next = option.kind === 'item'
      ? { id: option.item!.id, label: option.item!.label, fromOther: false }
      : { id: 'other', label: text.trim(), fromOther: true };
    onChange(next);
    setText(next.label);
    setOpen(false);
  };

  if (state === 'error') {
    return (
      <div className="mt-1 flex items-center justify-between rounded border border-[#EBC3BE] bg-[#FBE9E7] px-3 py-2 text-[12px] text-[#B3261E]">
        The list could not be loaded.
        <button onClick={onRetry} className="flex items-center gap-1 font-medium underline">
          <RefreshCw className="w-3.5 h-3.5" /> Try again
        </button>
      </div>
    );
  }

  return (
    <div className="relative" ref={box}>
      <div className="relative">
        <input
          value={text}
          disabled={state === 'loading'}
          placeholder={state === 'loading' ? 'Loading the list…' : placeholder}
          onChange={e => { setText(e.target.value); setOpen(true); setCursor(0); if (value) onChange(null); }}
          onFocus={() => setOpen(true)}
          onKeyDown={e => {
            if (e.key === 'ArrowDown') { e.preventDefault(); setOpen(true); setCursor(c => Math.min(c + 1, options.length - 1)); }
            else if (e.key === 'ArrowUp') { e.preventDefault(); setCursor(c => Math.max(c - 1, 0)); }
            else if (e.key === 'Enter' && open) { e.preventDefault(); choose(cursor); }
            else if (e.key === 'Escape') setOpen(false);
          }}
          className={inputClass + ' pr-9'}
          autoComplete="off"
        />
        <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[#8FA2AB]">
          {state === 'loading' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Search className="w-4 h-4" />}
        </span>
      </div>

      {value?.fromOther && (
        <span className="mt-1 inline-block rounded border border-[#E2CDA6] bg-[#FBF3E2] px-2 py-0.5 text-[11px] text-[#8A6412]">
          Saved as other — the administrator can add it to the standard list
        </span>
      )}

      {open && state === 'ready' && (
        <ul className="absolute z-30 mt-1 max-h-60 w-full overflow-auto rounded border border-[#DCE3E5] bg-white py-1 shadow-xl">
          {options.length === 0 && (
            <li className="px-3 py-2 text-[12px] text-[#5C6E79]">Nothing matches. Keep typing to save it as other.</li>
          )}
          {options.map((option, i) => (
            <li key={option.kind === 'item' ? option.item!.id : 'other'}>
              <button
                onMouseEnter={() => setCursor(i)}
                onClick={() => choose(i)}
                className={`flex w-full items-center justify-between px-3 py-2 text-left text-[13px] ${
                  i === cursor ? 'bg-[#F1F5F6]' : ''
                }`}
              >
                {option.kind === 'item' ? (
                  <>
                    <span>{option.item!.label}</span>
                    <span className="text-[11px] text-[#8FA2AB] tabular-nums">{option.item!.code}</span>
                  </>
                ) : (
                  <span className="flex items-center gap-2 text-[#8A6412]">
                    <Plus className="w-3.5 h-3.5" /> Use “{text.trim()}” as other
                  </span>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** The month rail: expenditure runs left, income runs right, off a shared spine. */
function FlowRail({ rows, mode = 'both' }: { rows: { month: number; income: number; expenditure: number }[]; mode?: 'both' | 'income' }) {
  const peak = Math.max(1, ...rows.map(r => Math.max(r.income, mode === 'both' ? r.expenditure : 0)));

  if (mode === 'income') {
    return (
      <div className="space-y-1.5">
        {rows.map(row => (
          <div key={row.month} className="grid grid-cols-[3rem_1fr] items-center">
            <span className="text-[11px] font-medium text-[#33454F]">{MONTHS_SHORT[row.month]}</span>
            <div className="flex items-center gap-2">
              <div className="h-5 rounded-r-sm bg-[#2E8B63]" style={{ width: `${(row.income / peak) * 100}%` }} />
              <span className="text-[11px] tabular-nums text-[#5C6E79]">{row.income ? naira(row.income) : '—'}</span>
            </div>
          </div>
        ))}
      </div>
    );
  }

  return (
    <div>
      <div className="grid grid-cols-[1fr_3rem_1fr] items-center pb-2 text-[11px] text-[#5C6E79]">
        <span className="text-right">Spent</span>
        <span />
        <span>Received</span>
      </div>
      <div className="space-y-1.5">
        {rows.map(row => (
          <div key={row.month} className="grid grid-cols-[1fr_3rem_1fr] items-center">
            <div className="flex items-center justify-end gap-2">
              <span className="text-[11px] tabular-nums text-[#5C6E79]">{row.expenditure ? nairaShort(row.expenditure) : ''}</span>
              <div
                className="h-5 rounded-l-sm bg-[#C97B2E]"
                style={{ width: `${(row.expenditure / peak) * 100}%` }}
                title={`${MONTHS[row.month]} spending: ${naira(row.expenditure)}`}
              />
            </div>
            <span className="text-center text-[11px] font-medium text-[#33454F]">{MONTHS_SHORT[row.month]}</span>
            <div className="flex items-center gap-2">
              <div
                className="h-5 rounded-r-sm bg-[#2E8B63]"
                style={{ width: `${(row.income / peak) * 100}%` }}
                title={`${MONTHS[row.month]} income: ${naira(row.income)}`}
              />
              <span className="text-[11px] tabular-nums text-[#5C6E79]">{row.income ? nairaShort(row.income) : ''}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function BreakdownBars({ rows, tone }: { rows: { label: string; value: number }[]; tone: 'in' | 'out' }) {
  const total = Math.max(1, sum(rows, r => r.value));
  const peak = Math.max(1, ...rows.map(r => r.value));
  const bar = tone === 'in' ? 'bg-[#2E8B63]' : 'bg-[#C97B2E]';
  if (!rows.length) return <p className="text-[12px] text-[#5C6E79]">No entries for this selection yet.</p>;
  return (
    <div className="space-y-3">
      {rows.map(row => (
        <div key={row.label}>
          <div className="flex items-baseline justify-between gap-3">
            <span className="text-[13px]">{row.label}</span>
            <span className="text-[12px] tabular-nums text-[#33454F]">
              {naira(row.value)} <span className="text-[#8FA2AB]">· {((row.value / total) * 100).toFixed(1)}%</span>
            </span>
          </div>
          <div className="mt-1 h-1.5 w-full rounded-full bg-[#EDF2F4]">
            <div className={`h-1.5 rounded-full ${bar}`} style={{ width: `${(row.value / peak) * 100}%` }} />
          </div>
        </div>
      ))}
    </div>
  );
}

function downloadCsv(filename: string, header: string[], rows: (string | number)[][]) {
  const escape = (v: any) => `"${String(v).replace(/"/g, '""')}"`;
  const body = [header, ...rows].map(r => r.map(escape).join(',')).join('\n');
  const url = URL.createObjectURL(new Blob([body], { type: 'text/csv;charset=utf-8;' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/* ---------------------------------------------------------------------------
   10. Overview — the analytics dashboard
   ------------------------------------------------------------------------ */

function Overview({ user, facilities: scope, income, expenditure, flags }: any) {
  const scopeLevel = ROLES[user.role].scope;
  const [lga, setLga] = useState('all');
  const [facilityId, setFacilityId] = useState('all');
  const [fromMonth, setFromMonth] = useState(0);
  const [toMonth, setToMonth] = useState(CLOSED_THROUGH);

  const lgas = useMemo(() => Array.from(new Set(scope.map((f: Facility) => f.lga))).sort(), [scope]);
  const facilityOptions = useMemo(
    () => scope.filter((f: Facility) => lga === 'all' || f.lga === lga),
    [scope, lga]
  );

  const inRange = (m: number) => m >= Math.min(fromMonth, toMonth) && m <= Math.max(fromMonth, toMonth);
  const matches = (row: any) => {
    const facility = facilityById(row.facilityId)!;
    if (lga !== 'all' && facility.lga !== lga) return false;
    if (facilityId !== 'all' && facility.id !== facilityId) return false;
    return inRange(row.month);
  };

  const seesSpend = allows(user, 'expenditure:read');
  const inRows = income.filter(matches);
  const outRows = seesSpend
    ? expenditure.filter((e: ExpenditureEntry) => matches(e) && e.status !== 'rejected')
    : [];

  const totalIn = sum(inRows, (r: IncomeEntry) => r.amount);
  const totalOut = sum(outRows, (r: ExpenditureEntry) => r.amount);
  const pending = outRows.filter((e: ExpenditureEntry) => e.status === 'pending');

  const railRows = useMemo(() => {
    const months = [];
    for (let m = Math.min(fromMonth, toMonth); m <= Math.max(fromMonth, toMonth); m += 1) {
      months.push({
        month: m,
        income: sum(inRows.filter((r: IncomeEntry) => r.month === m), (r: IncomeEntry) => r.amount),
        expenditure: sum(outRows.filter((r: ExpenditureEntry) => r.month === m), (r: ExpenditureEntry) => r.amount),
      });
    }
    return months;
  }, [inRows, outRows, fromMonth, toMonth]);

  const groupSum = (rows: any[], key: string) => {
    const map = new Map<string, number>();
    rows.forEach(r => map.set(r[key], (map.get(r[key]) ?? 0) + r.amount));
    return Array.from(map, ([label, value]) => ({ label, value })).sort((a, b) => b.value - a.value);
  };

  const facilityRows = useMemo(() => {
    return facilityOptions
      .map((f: Facility) => {
        const fi = sum(inRows.filter((r: IncomeEntry) => r.facilityId === f.id), (r: IncomeEntry) => r.amount);
        const fo = sum(outRows.filter((r: ExpenditureEntry) => r.facilityId === f.id), (r: ExpenditureEntry) => r.amount);
        return { facility: f, income: fi, expenditure: fo, balance: fi - fo, ratio: fi ? fo / fi : 0 };
      })
      .sort((a: any, b: any) => b.ratio - a.ratio);
  }, [facilityOptions, inRows, outRows]);

  const lgaRows = useMemo(() => {
    return lgas.map((name: string) => {
      const ids = scope.filter((f: Facility) => f.lga === name).map((f: Facility) => f.id);
      const li = sum(inRows.filter((r: IncomeEntry) => ids.includes(r.facilityId)), (r: IncomeEntry) => r.amount);
      const lo = sum(outRows.filter((r: ExpenditureEntry) => ids.includes(r.facilityId)), (r: ExpenditureEntry) => r.amount);
      return { name, facilities: ids.length, income: li, expenditure: lo, balance: li - lo };
    }).sort((a: any, b: any) => b.expenditure - a.expenditure);
  }, [lgas, scope, inRows, outRows]);

  const period = `${MONTHS_SHORT[Math.min(fromMonth, toMonth)]}–${MONTHS_SHORT[Math.max(fromMonth, toMonth)]} ${FISCAL_YEAR}`;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-[22px] font-semibold tracking-tight">
            {scopeLevel === 'facility' ? facilityById(user.facilityId!)?.name
              : scopeLevel === 'lga' ? `${user.lga} LGA` : 'Rivers State'}
          </h1>
          <p className="mt-1 text-[12px] text-[#5C6E79]">
            {period} · {facilityOptions.length} {facilityOptions.length === 1 ? 'facility' : 'facilities'} in view
          </p>
        </div>
        <button
          onClick={() => downloadCsv(
            `hiep-${period.toLowerCase()}.csv`,
            ['Facility', 'LGA', 'Income', 'Expenditure', 'Balance'],
            facilityRows.map((r: any) => [r.facility.name, r.facility.lga, r.income, r.expenditure, r.balance])
          )}
          className="flex items-center gap-2 rounded border border-[#C9D4D8] bg-white px-3 py-2 text-[12px] font-medium hover:border-[#10202B]"
        >
          <Download className="w-4 h-4" /> Download this view
        </button>
      </div>

      {/* Filters */}
      <div className="rounded border border-[#DCE3E5] bg-white p-4">
        <div className="grid grid-cols-1 gap-4 md:grid-cols-5">
          <Field label="State">
            <select className={inputClass} disabled>
              <option>Rivers</option>
            </select>
          </Field>
          <Field label="Local government">
            <select
              value={lga}
              onChange={e => { setLga(e.target.value); setFacilityId('all'); }}
              disabled={scopeLevel === 'facility'}
              className={inputClass + (scopeLevel === 'facility' ? ' bg-[#F1F5F6] text-[#8FA2AB]' : '')}
            >
              <option value="all">All local governments</option>
              {lgas.map((l: string) => <option key={l} value={l}>{l}</option>)}
            </select>
          </Field>
          <Field label="Facility">
            <select value={facilityId} onChange={e => setFacilityId(e.target.value)} className={inputClass}>
              <option value="all">All facilities</option>
              {facilityOptions.map((f: Facility) => <option key={f.id} value={f.id}>{f.name}</option>)}
            </select>
          </Field>
          <Field label="From month">
            <select value={fromMonth} onChange={e => setFromMonth(Number(e.target.value))} className={inputClass}>
              {MONTHS.slice(0, CLOSED_THROUGH + 1).map((m, i) => <option key={m} value={i}>{m}</option>)}
            </select>
          </Field>
          <Field label="To month">
            <select value={toMonth} onChange={e => setToMonth(Number(e.target.value))} className={inputClass}>
              {MONTHS.slice(0, CLOSED_THROUGH + 1).map((m, i) => <option key={m} value={i}>{m}</option>)}
            </select>
          </Field>
        </div>
      </div>

      {seesSpend ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <Figure label="Income received" value={naira(totalIn)} tone="in" note={`${inRows.length} entries`} />
          <Figure label="Expenditure committed" value={naira(totalOut)} tone="out"
            note={`${outRows.length} entries · ${pending.length} awaiting approval`} />
          <Figure label="Balance" value={naira(totalIn - totalOut)} tone={totalIn - totalOut < 0 ? 'bad' : 'neutral'}
            note={totalIn ? `${((totalOut / totalIn) * 100).toFixed(1)}% of income spent` : 'No income recorded'} />
          <Figure label="Open checks" value={String(flags.length)} tone={flags.length ? 'bad' : 'neutral'}
            note={flags.filter((f: GovernanceFlag) => f.severity === 'critical').length + ' need a decision'} />
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <Figure label="Income received" value={naira(totalIn)} tone="in" note={`${inRows.length} entries posted`} />
          <Figure label="Largest source" value={groupSum(inRows, 'sourceLabel')[0]?.label ?? '—'}
            note={groupSum(inRows, 'sourceLabel')[0] ? naira(groupSum(inRows, 'sourceLabel')[0].value) : undefined} />
          <Figure label="Months with an entry"
            value={`${railRows.filter((r: any) => r.income > 0).length} of ${railRows.length}`} />
        </div>
      )}

      <div className={`grid grid-cols-1 gap-5 ${seesSpend ? 'xl:grid-cols-[3fr_2fr]' : 'xl:grid-cols-2'}`}>
        <Panel
          title={seesSpend ? 'Money in and out, month by month' : 'Income month by month'}
          description={seesSpend ? 'Bars share one scale, so the wider side is the bigger number.' : undefined}
        >
          <FlowRail rows={railRows} mode={seesSpend ? 'both' : 'income'} />
        </Panel>
        <div className="space-y-5">
          <Panel title="Where the money came from">
            <BreakdownBars rows={groupSum(inRows, 'sourceLabel')} tone="in" />
          </Panel>
          {seesSpend && (
            <Panel title="What it was spent on">
              <BreakdownBars rows={groupSum(outRows, 'categoryLabel').slice(0, 8)} tone="out" />
            </Panel>
          )}
        </div>
      </div>

      {scopeLevel !== 'facility' && (
        <Panel title="Local government summary" description="Sorted by spending across the selected months.">
          <div className="overflow-x-auto">
            <table className="w-full text-[13px]">
              <thead>
                <tr className="border-b border-[#E7ECEE] text-left text-[11px] text-[#5C6E79]">
                  <th className="pb-2 font-medium">Local government</th>
                  <th className="pb-2 font-medium">Facilities</th>
                  <th className="pb-2 text-right font-medium">Income</th>
                  <th className="pb-2 text-right font-medium">Expenditure</th>
                  <th className="pb-2 text-right font-medium">Balance</th>
                </tr>
              </thead>
              <tbody>
                {lgaRows.map((row: any) => (
                  <tr key={row.name} className="border-b border-[#F1F5F6] last:border-0">
                    <td className="py-2.5 font-medium">
                      <button onClick={() => setLga(row.name)} className="hover:underline">{row.name}</button>
                    </td>
                    <td className="py-2.5 tabular-nums text-[#5C6E79]">{row.facilities}</td>
                    <td className="py-2.5 text-right tabular-nums text-[#0F6B4A]">{naira(row.income)}</td>
                    <td className="py-2.5 text-right tabular-nums text-[#A45B12]">{naira(row.expenditure)}</td>
                    <td className={`py-2.5 text-right tabular-nums ${row.balance < 0 ? 'text-[#B3261E]' : ''}`}>{naira(row.balance)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      )}

      {seesSpend && (
      <Panel title="Facility breakdown" description="Ordered by how much of their income each facility has spent.">
        <div className="overflow-x-auto">
          <table className="w-full text-[13px]">
            <thead>
              <tr className="border-b border-[#E7ECEE] text-left text-[11px] text-[#5C6E79]">
                <th className="pb-2 font-medium">Facility</th>
                <th className="pb-2 font-medium">Local government</th>
                <th className="pb-2 text-right font-medium">Income</th>
                <th className="pb-2 text-right font-medium">Expenditure</th>
                <th className="pb-2 text-right font-medium">Balance</th>
                <th className="pb-2 pl-4 font-medium">Share of income spent</th>
              </tr>
            </thead>
            <tbody>
              {facilityRows.map((row: any) => (
                <tr key={row.facility.id} className="border-b border-[#F1F5F6] last:border-0">
                  <td className="py-2.5 font-medium">{row.facility.name}</td>
                  <td className="py-2.5 text-[#5C6E79]">{row.facility.lga}</td>
                  <td className="py-2.5 text-right tabular-nums text-[#0F6B4A]">{naira(row.income)}</td>
                  <td className="py-2.5 text-right tabular-nums text-[#A45B12]">{naira(row.expenditure)}</td>
                  <td className={`py-2.5 text-right tabular-nums ${row.balance < 0 ? 'text-[#B3261E]' : ''}`}>{naira(row.balance)}</td>
                  <td className="py-2.5 pl-4">
                    <div className="flex items-center gap-2">
                      <div className="h-1.5 w-28 rounded-full bg-[#EDF2F4]">
                        <div
                          className={`h-1.5 rounded-full ${row.ratio > 1 ? 'bg-[#B3261E]' : row.ratio > 0.85 ? 'bg-[#C97B2E]' : 'bg-[#2E8B63]'}`}
                          style={{ width: `${Math.min(100, row.ratio * 100)}%` }}
                        />
                      </div>
                      <span className="text-[11px] tabular-nums text-[#5C6E79]">{(row.ratio * 100).toFixed(0)}%</span>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------------------
   11. Income ledger
   ------------------------------------------------------------------------ */

function IncomeLedger({ user, facilities: scope, entries, catalog, catalogState, onRetryCatalog, onAdd }: any) {
  const [month, setMonth] = useState(CLOSED_THROUGH);
  const [facilityId, setFacilityId] = useState(user.facilityId ?? scope[0]?.id);
  const canCreate = allows(user, 'income:create');

  const rows = entries
    .filter((e: IncomeEntry) => e.month === month && e.facilityId === facilityId)
    .sort((a: IncomeEntry, b: IncomeEntry) => b.receivedOn.getTime() - a.receivedOn.getTime());
  const monthTotal = sum(rows, (r: IncomeEntry) => r.amount);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-[22px] font-semibold tracking-tight">Income ledger</h1>
          <p className="mt-1 text-[12px] text-[#5C6E79]">
            Money received by the facility, posted month by month.
          </p>
        </div>
        <div className="flex items-end gap-3">
          <Field label="Facility">
            <select
              value={facilityId}
              onChange={e => setFacilityId(e.target.value)}
              disabled={scope.length === 1}
              className={inputClass + (scope.length === 1 ? ' bg-[#F1F5F6] text-[#5C6E79]' : '')}
            >
              {scope.map((f: Facility) => <option key={f.id} value={f.id}>{f.name}</option>)}
            </select>
          </Field>
        </div>
      </div>

      <MonthStrip value={month} onChange={setMonth} disabledAfter={CLOSED_THROUGH} />

      <div className={`grid grid-cols-1 gap-5 ${canCreate ? 'xl:grid-cols-[2fr_1fr]' : ''}`}>
        <Panel
          title={`${MONTHS[month]} ${FISCAL_YEAR}`}
          description={`${rows.length} ${rows.length === 1 ? 'entry' : 'entries'} · ${naira(monthTotal)} received`}
          action={
            <button
              onClick={() => downloadCsv(
                `income-${MONTHS_SHORT[month].toLowerCase()}.csv`,
                ['Date', 'Source', 'Payer', 'Reference', 'Amount', 'Recorded by'],
                rows.map((r: IncomeEntry) => [dayStamp(r.receivedOn), r.sourceLabel, r.payer, r.reference, r.amount, r.recordedBy.name])
              )}
              className="flex items-center gap-2 rounded border border-[#C9D4D8] px-3 py-1.5 text-[12px] hover:border-[#10202B]"
            >
              <Download className="w-3.5 h-3.5" /> Export
            </button>
          }
        >
          {rows.length === 0 ? (
            <p className="py-8 text-center text-[13px] text-[#5C6E79]">
              Nothing posted for {MONTHS[month]} yet.{canCreate ? ' Use the form to record the first receipt.' : ''}
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-[13px]">
                <thead>
                  <tr className="border-b border-[#E7ECEE] text-left text-[11px] text-[#5C6E79]">
                    <th className="pb-2 font-medium">Received</th>
                    <th className="pb-2 font-medium">Source</th>
                    <th className="pb-2 font-medium">Payer and reference</th>
                    <th className="pb-2 text-right font-medium">Amount</th>
                    <th className="pb-2 pl-4 font-medium">Posted by</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r: IncomeEntry) => (
                    <tr key={r.id} className="border-b border-[#F1F5F6] last:border-0 align-top">
                      <td className="py-3 whitespace-nowrap tabular-nums text-[#33454F]">{dayStamp(r.receivedOn)}</td>
                      <td className="py-3">
                        <span className="font-medium">{r.sourceLabel}</span>
                        {r.fromOther && (
                          <span className="ml-2 rounded border border-[#E2CDA6] bg-[#FBF3E2] px-1.5 py-0.5 text-[10px] text-[#8A6412]">other</span>
                        )}
                      </td>
                      <td className="py-3 text-[#5C6E79]">
                        <span className="block">{r.payer}</span>
                        <span className="block text-[11px] tabular-nums">{r.reference}</span>
                      </td>
                      <td className="py-3 text-right tabular-nums font-medium text-[#0F6B4A]">{naira(r.amount)}</td>
                      <td className="py-3 pl-4 text-[11px] text-[#5C6E79]">{r.recordedBy.name}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <td colSpan={3} className="pt-3 text-[12px] text-[#5C6E79]">Total for {MONTHS[month]}</td>
                    <td className="pt-3 text-right text-[15px] font-semibold tabular-nums text-[#0F6B4A]">{naira(monthTotal)}</td>
                    <td />
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
        </Panel>

        {canCreate && (
          <IncomeForm
            user={user}
            facilityId={facilityId}
            month={month}
            catalog={catalog.filter((c: CatalogItem) => c.ledger === 'income')}
            catalogState={catalogState}
            onRetryCatalog={onRetryCatalog}
            onAdd={onAdd}
          />
        )}
        {!canCreate && (
          <Panel title="View only">
            <p className="flex items-start gap-2 text-[13px] text-[#5C6E79]">
              <Lock className="mt-0.5 w-4 h-4 shrink-0" />
              Income is posted by the revenue officer. You can read and export it here.
            </p>
          </Panel>
        )}
      </div>
    </div>
  );
}

function IncomeForm({ user, facilityId, month, catalog, catalogState, onRetryCatalog, onAdd }: any) {
  const blank = { amount: '', payer: '', reference: '', day: '', note: '' };
  const [source, setSource] = useState<any>(null);
  const [form, setForm] = useState(blank);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  const set = (key: string, value: string) => setForm(f => ({ ...f, [key]: value }));

  const submit = () => {
    if (!source) return setError('Choose or type an income source.');
    const amount = Number(form.amount);
    if (!amount || amount <= 0) return setError('Enter the amount received.');
    if (!form.payer.trim()) return setError('Enter who paid the money.');
    setError('');
    setSaving(true);
    const day = Math.min(28, Math.max(1, Number(form.day) || 1));
    setTimeout(() => {
      onAdd({
        id: `inc-${Date.now()}`,
        facilityId,
        sourceId: source.id,
        sourceLabel: source.label,
        fromOther: source.fromOther,
        amount,
        month,
        year: FISCAL_YEAR,
        receivedOn: new Date(FISCAL_YEAR, month, day),
        reference: form.reference.trim() || '—',
        payer: form.payer.trim(),
        note: form.note.trim(),
        recordedBy: user,
        recordedAt: new Date(),
      });
      setSource(null);
      setForm(blank);
      setSaving(false);
    }, 260);
  };

  return (
    <Panel title="Record income" description={`Posting to ${MONTHS[month]} ${FISCAL_YEAR}.`}>
      <div className="space-y-4">
        <Field label="Source" hint="Start typing. Anything not on the list is saved as other.">
          <CatalogPicker
            items={catalog}
            state={catalogState}
            value={source}
            onChange={setSource}
            onRetry={onRetryCatalog}
            placeholder="BHCPF, IGR, RSCHPP…"
          />
        </Field>
        <Field label="Amount received">
          <input inputMode="numeric" value={form.amount} onChange={e => set('amount', e.target.value.replace(/[^\d.]/g, ''))}
            placeholder="0" className={inputClass + ' tabular-nums'} />
        </Field>
        <Field label="Paid by">
          <input value={form.payer} onChange={e => set('payer', e.target.value)} placeholder="Who sent the money" className={inputClass} />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Day of month">
            <input inputMode="numeric" value={form.day} onChange={e => set('day', e.target.value.replace(/\D/g, ''))}
              placeholder="1–28" className={inputClass + ' tabular-nums'} />
          </Field>
          <Field label="Reference">
            <input value={form.reference} onChange={e => set('reference', e.target.value)} placeholder="Teller or memo no." className={inputClass} />
          </Field>
        </div>
        <Field label="Note" hint="Optional.">
          <input value={form.note} onChange={e => set('note', e.target.value)} placeholder="Anything the reviewer should know" className={inputClass} />
        </Field>

        {error && (
          <p className="flex items-center gap-2 rounded border border-[#EBC3BE] bg-[#FBE9E7] px-3 py-2 text-[12px] text-[#B3261E]">
            <AlertTriangle className="w-3.5 h-3.5" /> {error}
          </p>
        )}

        <button
          onClick={submit}
          disabled={saving}
          className="flex w-full items-center justify-center gap-2 rounded bg-[#0F6B4A] px-4 py-2.5 text-[13px] font-medium text-white hover:bg-[#0C5A3E] disabled:opacity-60"
        >
          {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
          Save to {MONTHS[month]}
        </button>
      </div>
    </Panel>
  );
}

/* ---------------------------------------------------------------------------
   12. Expenditure ledger
   ------------------------------------------------------------------------ */

function ExpenditureLedger({
  user, facilities: scope, entries, income, catalog, catalogState, onRetryCatalog, onAdd, onDecide,
}: any) {
  const [month, setMonth] = useState(CLOSED_THROUGH);
  const [facilityId, setFacilityId] = useState(user.facilityId ?? 'all');
  const [status, setStatus] = useState('all');
  const canCreate = allows(user, 'expenditure:create');
  const isApprover = allows(user, 'expenditure:approve');

  const rows = entries
    .filter((e: ExpenditureEntry) => e.month === month
      && (facilityId === 'all' || e.facilityId === facilityId)
      && (status === 'all' || e.status === status))
    .sort((a: ExpenditureEntry, b: ExpenditureEntry) => b.requestedAt.getTime() - a.requestedAt.getTime());

  const monthTotal = sum(rows.filter((r: ExpenditureEntry) => r.status !== 'rejected'), (r: ExpenditureEntry) => r.amount);
  const monthIncome = sum(
    income.filter((i: IncomeEntry) => i.month === month && (facilityId === 'all' || i.facilityId === facilityId)),
    (i: IncomeEntry) => i.amount
  );
  const waiting = entries.filter((e: ExpenditureEntry) => e.status === 'pending').length;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-[22px] font-semibold tracking-tight">Expenditure ledger</h1>
          <p className="mt-1 text-[12px] text-[#5C6E79]">
            {isApprover
              ? `${waiting} ${waiting === 1 ? 'request is' : 'requests are'} waiting on a decision in your area.`
              : 'Requests go to the approving officer before they are counted as committed.'}
          </p>
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <Field label="Facility">
            <select
              value={facilityId}
              onChange={e => setFacilityId(e.target.value)}
              disabled={scope.length === 1}
              className={inputClass + (scope.length === 1 ? ' bg-[#F1F5F6] text-[#5C6E79]' : '')}
            >
              {scope.length > 1 && <option value="all">All facilities</option>}
              {scope.map((f: Facility) => <option key={f.id} value={f.id}>{f.name}</option>)}
            </select>
          </Field>
          <Field label="Status">
            <select value={status} onChange={e => setStatus(e.target.value)} className={inputClass}>
              <option value="all">All statuses</option>
              <option value="pending">Awaiting approval</option>
              <option value="approved">Approved</option>
              <option value="paid">Paid</option>
              <option value="rejected">Rejected</option>
            </select>
          </Field>
        </div>
      </div>

      <MonthStrip value={month} onChange={setMonth} disabledAfter={CLOSED_THROUGH} />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <Figure label={`Income posted for ${MONTHS_SHORT[month]}`} value={naira(monthIncome)} tone="in" />
        <Figure label="Spending in view" value={naira(monthTotal)} tone="out" />
        <Figure
          label="Left for the month"
          value={naira(monthIncome - monthTotal)}
          tone={monthIncome - monthTotal < 0 ? 'bad' : 'neutral'}
          note={monthIncome - monthTotal < 0 ? 'Spending has passed income for this month' : undefined}
        />
      </div>

      <div className={`grid grid-cols-1 gap-5 ${canCreate ? 'xl:grid-cols-[2fr_1fr]' : ''}`}>
        <Panel
          title={`${MONTHS[month]} ${FISCAL_YEAR}`}
          description={`${rows.length} ${rows.length === 1 ? 'record' : 'records'}`}
          action={
            <button
              onClick={() => downloadCsv(
                `expenditure-${MONTHS_SHORT[month].toLowerCase()}.csv`,
                ['Requested', 'Facility', 'Category', 'Payee', 'Amount', 'Status', 'Requested by', 'Decided by'],
                rows.map((r: ExpenditureEntry) => [
                  dayStamp(r.requestedAt), facilityById(r.facilityId)?.name, r.categoryLabel, r.payee,
                  r.amount, r.status, r.requestedBy.name, r.decidedBy?.name ?? '',
                ])
              )}
              className="flex items-center gap-2 rounded border border-[#C9D4D8] px-3 py-1.5 text-[12px] hover:border-[#10202B]"
            >
              <Download className="w-3.5 h-3.5" /> Export
            </button>
          }
        >
          {rows.length === 0 ? (
            <p className="py-8 text-center text-[13px] text-[#5C6E79]">No records match this selection.</p>
          ) : (
            <ul className="divide-y divide-[#F1F5F6]">
              {rows.map((entry: ExpenditureEntry) => (
                <ExpenditureRow key={entry.id} entry={entry} user={user} onDecide={onDecide} showFacility={facilityId === 'all'} />
              ))}
            </ul>
          )}
        </Panel>

        {canCreate ? (
          <ExpenditureForm
            user={user}
            facilityId={user.facilityId}
            month={month}
            catalog={catalog.filter((c: CatalogItem) => c.ledger === 'expenditure')}
            catalogState={catalogState}
            onRetryCatalog={onRetryCatalog}
            onAdd={onAdd}
          />
        ) : (
          <Panel title={isApprover ? 'How approval works' : 'View only'}>
            <ul className="space-y-2 text-[13px] text-[#5C6E79]">
              <li>Requests below {naira(HIGH_VALUE_THRESHOLD)} are cleared by the Medical Officer of Health for the LGA.</li>
              <li>Anything at or above {naira(HIGH_VALUE_THRESHOLD)} needs the Executive Secretary.</li>
              <li>Approving a request commits the money and it counts against the facility balance straight away.</li>
            </ul>
          </Panel>
        )}
      </div>
    </div>
  );
}

function ExpenditureRow({ entry, user, onDecide, showFacility }: any) {
  const [note, setNote] = useState('');
  const [expanded, setExpanded] = useState(false);
  const decidable = canDecide(user, entry);
  const blocked = entry.status === 'pending' && allows(user, 'expenditure:approve') && !decidable;

  return (
    <li className="py-3.5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[13px] font-medium">{entry.categoryLabel}</span>
            {entry.fromOther && (
              <span className="rounded border border-[#E2CDA6] bg-[#FBF3E2] px-1.5 py-0.5 text-[10px] text-[#8A6412]">other</span>
            )}
            <StatusChip status={entry.status} />
          </div>
          <p className="mt-1 text-[12px] text-[#5C6E79]">
            {showFacility && <span className="font-medium text-[#33454F]">{facilityById(entry.facilityId)?.name} · </span>}
            {entry.payee} · requested {dayStamp(entry.requestedAt)} by {entry.requestedBy.name}
          </p>
          {entry.decidedBy && (
            <p className="mt-0.5 text-[11px] text-[#5C6E79]">
              {entry.status === 'rejected' ? 'Rejected' : 'Approved'} by {entry.decidedBy.name} ({entry.decidedBy.role})
              {entry.decidedAt ? ` on ${dayStamp(entry.decidedAt)}` : ''}
              {entry.decisionNote ? ` — ${entry.decisionNote}` : ''}
            </p>
          )}
        </div>

        <div className="flex items-center gap-3">
          <span className="text-[15px] font-semibold tabular-nums text-[#A45B12]">{naira(entry.amount)}</span>
          {decidable && (
            <button
              onClick={() => setExpanded(v => !v)}
              className="rounded border border-[#C9D4D8] px-3 py-1.5 text-[12px] font-medium hover:border-[#10202B]"
            >
              Decide
            </button>
          )}
          {blocked && (
            <span className="flex items-center gap-1 text-[11px] text-[#8FA2AB]">
              <Lock className="w-3.5 h-3.5" /> Executive Secretary
            </span>
          )}
        </div>
      </div>

      {expanded && decidable && (
        <div className="mt-3 rounded border border-[#DCE3E5] bg-[#F7F9FA] p-3">
          <input
            value={note}
            onChange={e => setNote(e.target.value)}
            placeholder="Add a note for the record"
            className={inputClass + ' mt-0'}
          />
          <div className="mt-3 flex gap-2">
            <button
              onClick={() => { onDecide(entry, 'approved', note.trim() || undefined); setExpanded(false); }}
              className="flex items-center gap-2 rounded bg-[#0F6B4A] px-3 py-1.5 text-[12px] font-medium text-white hover:bg-[#0C5A3E]"
            >
              <Check className="w-3.5 h-3.5" /> Approve
            </button>
            <button
              onClick={() => { onDecide(entry, 'rejected', note.trim() || 'No reason given'); setExpanded(false); }}
              className="flex items-center gap-2 rounded border border-[#EBC3BE] bg-white px-3 py-1.5 text-[12px] font-medium text-[#B3261E] hover:bg-[#FBE9E7]"
            >
              <X className="w-3.5 h-3.5" /> Reject
            </button>
          </div>
        </div>
      )}
    </li>
  );
}

function ExpenditureForm({ user, facilityId, month, catalog, catalogState, onRetryCatalog, onAdd }: any) {
  const blank = { amount: '', payee: '', description: '', day: '' };
  const [category, setCategory] = useState<any>(null);
  const [form, setForm] = useState(blank);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const set = (key: string, value: string) => setForm(f => ({ ...f, [key]: value }));

  const amount = Number(form.amount) || 0;
  const routeTo = amount >= HIGH_VALUE_THRESHOLD ? 'Executive Secretary' : 'Medical Officer of Health';

  const submit = () => {
    if (!category) return setError('Choose or type what the money is for.');
    if (!amount || amount <= 0) return setError('Enter the amount requested.');
    if (!form.payee.trim()) return setError('Enter who will be paid.');
    setError('');
    setSaving(true);
    const day = Math.min(28, Math.max(1, Number(form.day) || new Date().getDate()));
    setTimeout(() => {
      onAdd({
        id: `exp-${Date.now()}`,
        facilityId,
        categoryId: category.id,
        categoryLabel: category.label,
        fromOther: category.fromOther,
        amount,
        month,
        year: FISCAL_YEAR,
        payee: form.payee.trim(),
        description: form.description.trim(),
        status: 'pending' as RequestStatus,
        requestedBy: user,
        requestedAt: new Date(FISCAL_YEAR, month, day),
      });
      setCategory(null);
      setForm(blank);
      setSaving(false);
    }, 260);
  };

  return (
    <Panel title="Request expenditure" description={`Posting to ${MONTHS[month]} ${FISCAL_YEAR}.`}>
      <div className="space-y-4">
        <Field label="What is the money for?" hint="Start typing. Anything not on the list is saved as other.">
          <CatalogPicker
            items={catalog}
            state={catalogState}
            value={category}
            onChange={setCategory}
            onRetry={onRetryCatalog}
            placeholder="Medicines, Outreach, WDC meetings…"
          />
        </Field>
        <Field label="Amount requested" hint={amount > 0 ? `Goes to the ${routeTo} for approval.` : undefined}>
          <input inputMode="numeric" value={form.amount} onChange={e => set('amount', e.target.value.replace(/[^\d.]/g, ''))}
            placeholder="0" className={inputClass + ' tabular-nums'} />
        </Field>
        <Field label="Payee">
          <input value={form.payee} onChange={e => set('payee', e.target.value)} placeholder="Supplier, contractor or person" className={inputClass} />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Day of month">
            <input inputMode="numeric" value={form.day} onChange={e => set('day', e.target.value.replace(/\D/g, ''))}
              placeholder="1–28" className={inputClass + ' tabular-nums'} />
          </Field>
          <Field label="Details">
            <input value={form.description} onChange={e => set('description', e.target.value)} placeholder="Short description" className={inputClass} />
          </Field>
        </div>

        {error && (
          <p className="flex items-center gap-2 rounded border border-[#EBC3BE] bg-[#FBE9E7] px-3 py-2 text-[12px] text-[#B3261E]">
            <AlertTriangle className="w-3.5 h-3.5" /> {error}
          </p>
        )}

        <button
          onClick={submit}
          disabled={saving}
          className="flex w-full items-center justify-center gap-2 rounded bg-[#A45B12] px-4 py-2.5 text-[13px] font-medium text-white hover:bg-[#8C4C0D] disabled:opacity-60"
        >
          {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
          Send for approval
        </button>
      </div>
    </Panel>
  );
}

/* ---------------------------------------------------------------------------
   13. Checks — the simplified governance ledger
   ------------------------------------------------------------------------ */

const FLAG_LABELS: Record<FlagCode, string> = {
  overspend: 'Spending past income',
  'no-income': 'Spending with no income posted',
  duplicate: 'Possible duplicate',
  'threshold-breach': 'Approved below the required level',
  'stalled-request': 'Request waiting too long',
};

function Checks({ user, flags, resolvedCount, onResolve }: any) {
  const [code, setCode] = useState('all');
  const canResolve = allows(user, 'governance:resolve');
  const shown = flags.filter((f: GovernanceFlag) => code === 'all' || f.code === code);
  const counts = (['critical', 'attention', 'notice'] as Severity[])
    .map(s => ({ s, n: flags.filter((f: GovernanceFlag) => f.severity === s).length }));

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-[22px] font-semibold tracking-tight">Checks</h1>
          <p className="mt-1 text-[12px] text-[#5C6E79]">
            Five rules run over the ledgers every time an entry changes. {resolvedCount} closed in this session.
          </p>
        </div>
        <div className="flex items-end gap-3">
          <Field label="Rule">
            <select value={code} onChange={e => setCode(e.target.value)} className={inputClass}>
              <option value="all">All rules</option>
              {Object.entries(FLAG_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </Field>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-4">
        {counts.map(({ s, n }) => (
          <Figure
            key={s}
            label={s === 'critical' ? 'Needs a decision' : s === 'attention' ? 'Worth a look' : 'For information'}
            value={String(n)}
            tone={s === 'critical' && n > 0 ? 'bad' : 'neutral'}
          />
        ))}
      </div>

      {shown.length === 0 ? (
        <Panel>
          <div className="py-10 text-center">
            <CheckCircle2 className="mx-auto w-8 h-8 text-[#0F6B4A]" strokeWidth={1.5} />
            <p className="mt-3 text-[15px] font-medium">Nothing to review</p>
            <p className="mt-1 text-[12px] text-[#5C6E79]">Every ledger in your area passed all five rules.</p>
          </div>
        </Panel>
      ) : (
        <div className="space-y-3">
          {shown.map((flag: GovernanceFlag) => (
            <CheckCard key={flag.id} flag={flag} canResolve={canResolve} onResolve={onResolve} />
          ))}
        </div>
      )}
    </div>
  );
}

function CheckCard({ flag, canResolve, onResolve }: any) {
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState('');
  const edge = flag.severity === 'critical' ? 'border-l-[#B3261E]'
    : flag.severity === 'attention' ? 'border-l-[#C97B2E]' : 'border-l-[#5C6E79]';
  const facility = facilityById(flag.facilityId)!;

  return (
    <article className={`rounded border border-[#DCE3E5] border-l-4 bg-white p-5 ${edge}`}>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-[15px] font-semibold">{flag.headline}</h3>
            <span className="rounded border border-[#DCE3E5] bg-[#F7F9FA] px-2 py-0.5 text-[11px] text-[#5C6E79]">
              {FLAG_LABELS[flag.code]}
            </span>
          </div>
          <p className="mt-1.5 max-w-[70ch] text-[13px] text-[#33454F]">{flag.detail}</p>
          <p className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-[#5C6E79]">
            <span className="flex items-center gap-1"><Building2 className="w-3.5 h-3.5" />{facility.name}</span>
            <span className="flex items-center gap-1"><MapPin className="w-3.5 h-3.5" />{facility.lga}</span>
            <span className="flex items-center gap-1"><Clock className="w-3.5 h-3.5" />{MONTHS[flag.month]} {flag.year}</span>
            <span className="tabular-nums">{naira(flag.amount)}</span>
          </p>
        </div>
        {canResolve && (
          <button
            onClick={() => setOpen(v => !v)}
            className="rounded border border-[#C9D4D8] px-3 py-1.5 text-[12px] font-medium hover:border-[#10202B]"
          >
            Close with a note
          </button>
        )}
      </div>

      {open && (
        <div className="mt-4 rounded border border-[#DCE3E5] bg-[#F7F9FA] p-3">
          <input
            value={note}
            onChange={e => setNote(e.target.value)}
            placeholder="What did you find, and what happens next?"
            className={inputClass + ' mt-0'}
          />
          <button
            disabled={!note.trim()}
            onClick={() => { onResolve(flag, note.trim()); setOpen(false); }}
            className="mt-3 rounded bg-[#10202B] px-3 py-1.5 text-[12px] font-medium text-white disabled:opacity-40"
          >
            Save and close
          </button>
        </div>
      )}
    </article>
  );
}

/* ---------------------------------------------------------------------------
   14. Lists — admin CRUD over the income and expenditure options
   ------------------------------------------------------------------------ */

function Catalogue({ user, catalog, state, income, expenditure, onReload, onChanged, onError }: any) {
  const [ledger, setLedger] = useState<LedgerType>('income');
  const [label, setLabel] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState('');

  const rows = catalog.filter((c: CatalogItem) => c.ledger === ledger);

  const usage = (item: CatalogItem) =>
    item.ledger === 'income'
      ? income.filter((i: IncomeEntry) => i.sourceLabel === item.label).length
      : expenditure.filter((e: ExpenditureEntry) => e.categoryLabel === item.label).length;

  const suggestions = useMemo(() => {
    const source = ledger === 'income'
      ? income.filter((i: IncomeEntry) => i.fromOther).map((i: IncomeEntry) => i.sourceLabel)
      : expenditure.filter((e: ExpenditureEntry) => e.fromOther).map((e: ExpenditureEntry) => e.categoryLabel);
    const counts = new Map<string, number>();
    source.forEach((s: string) => counts.set(s, (counts.get(s) ?? 0) + 1));
    return Array.from(counts, ([name, n]) => ({ name, n }))
      .filter(s => !catalog.some((c: CatalogItem) => c.ledger === ledger && c.label.toLowerCase() === s.name.toLowerCase()))
      .sort((a, b) => b.n - a.n);
  }, [ledger, income, expenditure, catalog]);

  const add = (name: string, shortCode?: string) => {
    if (!name.trim()) return onError('Type a name first.');
    setBusy('new');
    catalogApi.create({ ledger, label: name, code: shortCode || name.slice(0, 3) })
      .then(() => catalogApi.list())
      .then(rowsNext => {
        onChanged(rowsNext, `${name.trim()} added to the ${ledger} list.`, `Added “${name.trim()}” to the ${ledger} list`);
        setLabel(''); setCode('');
      })
      .catch((e: Error) => onError(e.message))
      .finally(() => setBusy(null));
  };

  const patch = (item: CatalogItem, changes: Partial<CatalogItem>, message: string) => {
    setBusy(item.id);
    catalogApi.update(item.id, changes)
      .then(() => catalogApi.list())
      .then(rowsNext => onChanged(rowsNext, message, `${message} (${item.label})`))
      .catch(() => onError('That change did not save. Try again.'))
      .finally(() => { setBusy(null); setEditing(null); });
  };

  const remove = (item: CatalogItem) => {
    setBusy(item.id);
    catalogApi.remove(item.id)
      .then(() => catalogApi.list())
      .then(rowsNext => onChanged(rowsNext, `${item.label} removed.`, `Removed “${item.label}” from the ${item.ledger} list`))
      .catch(() => onError('That item could not be removed.'))
      .finally(() => setBusy(null));
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-[22px] font-semibold tracking-tight">Lists</h1>
          <p className="mt-1 max-w-[70ch] text-[12px] text-[#5C6E79]">
            These are the options facility staff pick from when they post income and expenditure. Changes take effect the next time a form is opened.
          </p>
        </div>
        <button onClick={onReload} className="flex items-center gap-2 rounded border border-[#C9D4D8] bg-white px-3 py-2 text-[12px] hover:border-[#10202B]">
          <RefreshCw className="w-4 h-4" /> Reload from server
        </button>
      </div>

      <div className="flex gap-1 rounded border border-[#DCE3E5] bg-white p-1 w-fit">
        {(['income', 'expenditure'] as LedgerType[]).map(l => (
          <button
            key={l}
            onClick={() => setLedger(l)}
            className={`rounded px-4 py-1.5 text-[13px] font-medium capitalize ${
              ledger === l ? 'bg-[#10202B] text-white' : 'text-[#33454F] hover:bg-[#F1F5F6]'
            }`}
          >
            {l} sources
          </button>
        ))}
      </div>

      <div className="grid grid-cols-1 gap-5 xl:grid-cols-[2fr_1fr]">
        <Panel title={`${ledger === 'income' ? 'Income' : 'Expenditure'} options`} description={`${rows.length} on the list`}>
          {state === 'loading' && (
            <p className="flex items-center gap-2 py-6 text-[13px] text-[#5C6E79]">
              <Loader2 className="w-4 h-4 animate-spin" /> Loading the list…
            </p>
          )}
          {state === 'error' && (
            <p className="rounded border border-[#EBC3BE] bg-[#FBE9E7] px-3 py-2 text-[13px] text-[#B3261E]">
              The list could not be loaded. Use “Reload from server”.
            </p>
          )}
          {state === 'ready' && (
            <table className="w-full text-[13px]">
              <thead>
                <tr className="border-b border-[#E7ECEE] text-left text-[11px] text-[#5C6E79]">
                  <th className="pb-2 font-medium">Name</th>
                  <th className="pb-2 font-medium">Code</th>
                  <th className="pb-2 font-medium">In use</th>
                  <th className="pb-2 font-medium">Shown in forms</th>
                  <th className="pb-2 text-right font-medium">Manage</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((item: CatalogItem) => (
                  <tr key={item.id} className="border-b border-[#F1F5F6] last:border-0">
                    <td className="py-2.5">
                      {editing === item.id ? (
                        <input
                          value={draft}
                          onChange={e => setDraft(e.target.value)}
                          onKeyDown={e => { if (e.key === 'Enter') patch(item, { label: draft.trim() }, 'Name updated.'); }}
                          className={inputClass + ' mt-0 py-1'}
                          autoFocus
                        />
                      ) : (
                        <span className="font-medium">{item.label}</span>
                      )}
                      {item.system && <span className="ml-2 text-[10px] text-[#8FA2AB]">standard</span>}
                    </td>
                    <td className="py-2.5 tabular-nums text-[#5C6E79]">{item.code}</td>
                    <td className="py-2.5 tabular-nums text-[#5C6E79]">{usage(item)}</td>
                    <td className="py-2.5">
                      <button
                        onClick={() => patch(item, { active: !item.active }, item.active ? 'Hidden from forms.' : 'Shown in forms again.')}
                        className={`rounded border px-2 py-0.5 text-[11px] ${
                          item.active ? 'border-[#B7D6C6] bg-[#E3F0EA] text-[#0F6B4A]' : 'border-[#DCE3E5] bg-[#F1F5F6] text-[#5C6E79]'
                        }`}
                      >
                        {item.active ? 'Visible' : 'Hidden'}
                      </button>
                    </td>
                    <td className="py-2.5">
                      <div className="flex items-center justify-end gap-1">
                        {busy === item.id && <Loader2 className="w-3.5 h-3.5 animate-spin text-[#8FA2AB]" />}
                        {editing === item.id ? (
                          <button
                            onClick={() => patch(item, { label: draft.trim() }, 'Name updated.')}
                            className="rounded border border-[#C9D4D8] p-1.5 hover:border-[#10202B]"
                            aria-label="Save name"
                          >
                            <Check className="w-3.5 h-3.5" />
                          </button>
                        ) : (
                          <button
                            onClick={() => { setEditing(item.id); setDraft(item.label); }}
                            className="rounded border border-[#C9D4D8] p-1.5 hover:border-[#10202B]"
                            aria-label={`Rename ${item.label}`}
                          >
                            <Pencil className="w-3.5 h-3.5" />
                          </button>
                        )}
                        <button
                          disabled={item.system || usage(item) > 0}
                          onClick={() => remove(item)}
                          title={item.system ? 'Standard options cannot be deleted, only hidden'
                            : usage(item) > 0 ? 'In use by existing entries — hide it instead' : 'Delete'}
                          className="rounded border border-[#C9D4D8] p-1.5 text-[#B3261E] hover:border-[#B3261E] disabled:cursor-not-allowed disabled:text-[#C3D3DA] disabled:hover:border-[#C9D4D8]"
                          aria-label={`Delete ${item.label}`}
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>

        <div className="space-y-5">
          <Panel title="Add an option">
            <div className="space-y-3">
              <Field label="Name">
                <input value={label} onChange={e => setLabel(e.target.value)} placeholder={ledger === 'income' ? 'e.g. State subvention' : 'e.g. Generator fuel'} className={inputClass} />
              </Field>
              <Field label="Short code" hint="Used on exports and receipts.">
                <input value={code} onChange={e => setCode(e.target.value.toUpperCase())} placeholder="3–6 letters" className={inputClass} />
              </Field>
              <button
                onClick={() => add(label, code)}
                disabled={busy === 'new'}
                className="flex w-full items-center justify-center gap-2 rounded bg-[#10202B] px-4 py-2.5 text-[13px] font-medium text-white disabled:opacity-60"
              >
                {busy === 'new' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
                Add to the list
              </button>
            </div>
          </Panel>

          <Panel title="Typed in as other" description="What staff entered by hand. Promote the ones that keep coming up.">
            {suggestions.length === 0 ? (
              <p className="text-[12px] text-[#5C6E79]">Nothing waiting.</p>
            ) : (
              <ul className="space-y-2">
                {suggestions.map((s: any) => (
                  <li key={s.name} className="flex items-center justify-between gap-3">
                    <span className="text-[13px]">
                      {s.name}
                      <span className="ml-2 text-[11px] text-[#8FA2AB] tabular-nums">used {s.n}×</span>
                    </span>
                    <button
                      onClick={() => add(s.name)}
                      className="rounded border border-[#C9D4D8] px-2.5 py-1 text-[11px] font-medium hover:border-[#10202B]"
                    >
                      Add
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </div>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------------------
   15. Activity log
   ------------------------------------------------------------------------ */

function ActivityLog({ events }: { events: AuditEvent[] }) {
  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-[22px] font-semibold tracking-tight">Activity</h1>
        <p className="mt-1 max-w-[70ch] text-[12px] text-[#5C6E79]">
          Every posting, decision and list change is written here with the officer's name and role. In the live system this
          log is append-only and kept for the full retention period.
        </p>
      </div>

      <Panel>
        {events.length === 0 ? (
          <p className="py-8 text-center text-[13px] text-[#5C6E79]">
            Nothing recorded yet in this session. Post an entry or approve a request to see it appear.
          </p>
        ) : (
          <ul className="divide-y divide-[#F1F5F6]">
            {events.map(e => (
              <li key={e.id} className="flex items-start justify-between gap-4 py-3">
                <div>
                  <p className="text-[13px] font-medium">{e.action}</p>
                  <p className="mt-0.5 text-[12px] text-[#5C6E79]">{e.detail}</p>
                </div>
                <div className="shrink-0 text-right">
                  <p className="text-[12px]">{e.actor}</p>
                  <p className="text-[11px] tabular-nums text-[#5C6E79]">
                    {e.role} · {e.at.toLocaleTimeString('en-NG', { hour: '2-digit', minute: '2-digit' })}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <Panel title="People in this demo" description="Six accounts, one per role.">
        <ul className="divide-y divide-[#F1F5F6]">
          {people.map(p => (
            <li key={p.id} className="flex items-start justify-between gap-4 py-3">
              <div>
                <p className="text-[13px] font-medium">{p.name}</p>
                <p className="mt-0.5 text-[12px] text-[#5C6E79]">{p.title}</p>
              </div>
              <p className="max-w-[42ch] text-right text-[11px] text-[#5C6E79]">
                {ROLES[p.role].can.join(' · ')}
              </p>
            </li>
          ))}
        </ul>
        <p className="mt-4 flex items-center gap-2 text-[11px] text-[#8FA2AB]">
          <Users className="w-3.5 h-3.5" /> User accounts are managed outside this screen in the live system.
        </p>
      </Panel>
    </div>
  );
}