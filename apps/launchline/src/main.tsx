import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import {
  Activity,
  AlertTriangle,
  ArrowUpRight,
  Bell,
  Blocks,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Circle,
  Clock3,
  Command,
  Filter,
  Github,
  Grid2X2,
  HelpCircle,
  LayoutList,
  LineChart,
  Menu,
  MoreHorizontal,
  Plus,
  Search,
  Settings,
  Sparkles,
  Users,
  X,
  Zap,
} from 'lucide-react';
import './styles.css';

type Launch = {
  id: number;
  name: string;
  code: string;
  stage: string;
  owner: string;
  date: string;
  readiness: number;
  arr: number;
  adoption: number;
  blockers: number;
  description: string;
  color: string;
  accounts: Account[];
  timeline: Event[];
  checklist: { label: string; team: string; done: boolean }[];
};
type Account = {
  name: string;
  segment: string;
  arr: number;
  adoption: number;
  readiness: number;
  risk: 'Low' | 'Medium' | 'High';
};
type Event = { date: string; title: string; detail: string; type: string };
const initial: Launch[] = [
  {
    id: 1,
    name: 'SCIM provisioning',
    code: 'REL-248',
    stage: 'In launch',
    owner: 'Maya Chen',
    date: 'Jun 18',
    readiness: 82,
    arr: 1260,
    adoption: 38,
    blockers: 2,
    description: 'Automated user provisioning for enterprise identity providers.',
    color: '#c7f36a',
    accounts: [
      {
        name: 'Northstar Health',
        segment: 'Enterprise',
        arr: 285,
        adoption: 62,
        readiness: 92,
        risk: 'Low',
      },
      {
        name: 'Haven Financial',
        segment: 'Enterprise',
        arr: 240,
        adoption: 45,
        readiness: 82,
        risk: 'Medium',
      },
      {
        name: 'Vantage Logistics',
        segment: 'Mid-market',
        arr: 175,
        adoption: 28,
        readiness: 70,
        risk: 'High',
      },
      {
        name: 'Harrow & Co.',
        segment: 'Enterprise',
        arr: 310,
        adoption: 51,
        readiness: 88,
        risk: 'Low',
      },
      {
        name: 'Atlas Bio',
        segment: 'Mid-market',
        arr: 250,
        adoption: 19,
        readiness: 61,
        risk: 'High',
      },
    ],
    timeline: [
      {
        date: 'Jun 03',
        title: 'Release brief approved',
        detail: 'Positioning and target account criteria locked.',
        type: 'Milestone',
      },
      {
        date: 'Jun 10',
        title: 'Sales enablement live',
        detail: '42 account executives completed the walkthrough.',
        type: 'Enablement',
      },
      {
        date: 'Jun 14',
        title: 'Pilot cohort invited',
        detail: '18 admins invited across 9 enterprise accounts.',
        type: 'Customer',
      },
      {
        date: 'Today',
        title: 'Security review pending',
        detail: 'Haven Financial needs updated SOC 2 language.',
        type: 'Blocker',
      },
    ],
    checklist: [
      { label: 'Release narrative approved', team: 'Marketing', done: true },
      { label: 'Admin setup guide published', team: 'CS', done: true },
      { label: 'Enterprise security FAQ', team: 'Sales', done: false },
      { label: 'In-app onboarding shipped', team: 'Product', done: true },
      { label: 'Pilot account outreach', team: 'CS', done: false },
    ],
  },
  {
    id: 2,
    name: 'Usage-based billing',
    code: 'REL-241',
    stage: 'Readiness',
    owner: 'Jon Bell',
    date: 'Jul 02',
    readiness: 64,
    arr: 890,
    adoption: 0,
    blockers: 3,
    description: 'Metered plans and usage alerts for platform teams.',
    color: '#8bb9ff',
    accounts: [],
    timeline: [
      {
        date: 'May 29',
        title: 'Scope confirmed',
        detail: 'Billing and packaging requirements signed off.',
        type: 'Milestone',
      },
    ],
    checklist: [
      { label: 'Packaging approved', team: 'Marketing', done: true },
      { label: 'Finance reconciliation complete', team: 'Product', done: false },
      { label: 'CS migration playbook', team: 'CS', done: false },
    ],
  },
  {
    id: 3,
    name: 'Audit log export',
    code: 'REL-235',
    stage: 'Measuring',
    owner: 'Priya Shah',
    date: 'May 22',
    readiness: 100,
    arr: 740,
    adoption: 57,
    blockers: 1,
    description: 'Scheduled, compliance-ready audit log exports.',
    color: '#e9a3ff',
    accounts: [],
    timeline: [
      {
        date: 'May 22',
        title: 'Launched',
        detail: 'Available to Scale customers.',
        type: 'Milestone',
      },
    ],
    checklist: [],
  },
  {
    id: 4,
    name: 'Workspace templates',
    code: 'REL-252',
    stage: 'Planning',
    owner: 'Tomas Reed',
    date: 'Jul 17',
    readiness: 27,
    arr: 520,
    adoption: 0,
    blockers: 0,
    description: 'Opinionated templates to standardize launch operations.',
    color: '#ffd477',
    accounts: [],
    timeline: [],
    checklist: [],
  },
];
const fmt = (n: number) => `$${n.toLocaleString()}k`;
function App() {
  const [launches, setLaunches] = useState<Launch[]>(() => {
    try {
      return JSON.parse(localStorage.getItem('launchline-launches') || '');
    } catch {
      return initial;
    }
  });
  const [view, setView] = useState<'dashboard' | 'releases' | 'integrations'>('dashboard');
  const [selected, setSelected] = useState<Launch | null>(null);
  const [tab, setTab] = useState('Overview');
  const [q, setQ] = useState('');
  const [stage, setStage] = useState('All stages');
  const [modal, setModal] = useState<'launch' | 'event' | 'blocker' | null>(null);
  const [toast, setToast] = useState('');
  const [mobile, setMobile] = useState(false);
  useEffect(
    () => localStorage.setItem('launchline-launches', JSON.stringify(launches)),
    [launches],
  );
  useEffect(() => {
    if (toast) {
      const t = setTimeout(() => setToast(''), 2600);
      return () => clearTimeout(t);
    }
  }, [toast]);
  const active = selected ? launches.find((l) => l.id === selected.id) || selected : null;
  const totalArr = launches.filter((l) => l.stage !== 'Planning').reduce((a, l) => a + l.arr, 0);
  const blockers = launches.reduce((a, l) => a + l.blockers, 0);
  function updateLaunch(id: number, fn: (l: Launch) => Launch) {
    setLaunches((x) => x.map((l) => (l.id === id ? fn(l) : l)));
  }
  function openLaunch(l: Launch) {
    setSelected(l);
    setTab('Overview');
    setView('releases');
    setMobile(false);
  }
  function addLaunch(name: string) {
    const l: Launch = {
      id: Date.now(),
      name,
      code: `REL-${260 + launches.length}`,
      stage: 'Planning',
      owner: 'You',
      date: 'Jul 29',
      readiness: 10,
      arr: 0,
      adoption: 0,
      blockers: 0,
      description: 'New launch workspace. Add scope, accounts, and workstreams.',
      color: '#91e6d4',
      accounts: [],
      timeline: [
        {
          date: 'Today',
          title: 'Workspace created',
          detail: 'Your launch is ready for planning.',
          type: 'Milestone',
        },
      ],
      checklist: [],
    };
    setLaunches([l, ...launches]);
    setModal(null);
    openLaunch(l);
    setToast('Launch workspace created');
  }
  const nav: Array<[typeof view, React.ElementType, string]> = [
    ['dashboard', Grid2X2, 'Command Center'],
    ['releases', LayoutList, 'Releases'],
    ['integrations', Blocks, 'Data sources'],
  ];
  return (
    <div className="app">
      <aside className={mobile ? 'sidebar mobile-open' : 'sidebar'}>
        <div className="brand">
          <span className="brand-mark">
            <Zap size={17} />
          </span>
          <b>Launchline</b>
          <button className="icon mobile-only" onClick={() => setMobile(false)}>
            <X size={18} />
          </button>
        </div>
        <button className="workspace">
          Atlas Software <ChevronDown size={15} />
        </button>
        <nav>
          {nav.map(([id, Icon, label]) => (
            <button
              key={String(id)}
              className={view === id ? 'nav active' : 'nav'}
              onClick={() => {
                setView(id as typeof view);
                setSelected(null);
                setMobile(false);
              }}
            >
              <Icon size={18} />
              {label}
            </button>
          ))}
        </nav>
        <div className="nav-bottom">
          <button className="nav">
            <Settings size={18} />
            Settings
          </button>
          <div className="plan">
            <span>Scale plan</span>
            <b>$299/mo</b>
            <small>12 of 15 launches</small>
            <div className="meter">
              <i />
            </div>
          </div>
          <div className="person">
            <span>MC</span>
            <div>
              <b>Maya Chen</b>
              <small>Product Marketing</small>
            </div>
            <MoreHorizontal size={17} />
          </div>
        </div>
      </aside>
      <main>
        <header>
          <button className="icon mobile-menu" onClick={() => setMobile(true)}>
            <Menu />
          </button>
          <button
            className="command"
            onClick={() => setToast('Command palette is ready — try search')}
          >
            <Command size={15} />
            <span>Search launches, accounts, and actions</span>
            <kbd>⌘ K</kbd>
          </button>
          <div className="header-actions">
            <button
              className="icon"
              aria-label="Notifications"
              onClick={() => setToast('You have 3 launch updates')}
            >
              <Bell size={18} />
              <i className="badge" />
            </button>
            <button className="avatar">MC</button>
          </div>
        </header>
        {selected && active ? (
          <Workspace
            launch={active}
            tab={tab}
            setTab={setTab}
            onBack={() => setSelected(null)}
            onUpdate={updateLaunch}
            setModal={setModal}
          />
        ) : view === 'dashboard' ? (
          <Dashboard
            launches={launches}
            totalArr={totalArr}
            blockers={blockers}
            onSelect={openLaunch}
            onCreate={() => setModal('launch')}
          />
        ) : view === 'releases' ? (
          <Releases
            launches={launches}
            q={q}
            setQ={setQ}
            stage={stage}
            setStage={setStage}
            onSelect={openLaunch}
            onCreate={() => setModal('launch')}
          />
        ) : (
          <Integrations />
        )}
      </main>
      {modal && (
        <Modal
          kind={modal}
          close={() => setModal(null)}
          create={addLaunch}
          launch={active}
          onSubmit={(value) => {
            if (!active) return;
            if (modal === 'event')
              updateLaunch(active.id, (l) => ({
                ...l,
                timeline: [
                  ...l.timeline,
                  {
                    date: 'Today',
                    title: value,
                    detail: 'Added manually from launch workspace.',
                    type: 'Update',
                  },
                ],
              }));
            else
              updateLaunch(active.id, (l) => ({
                ...l,
                blockers: l.blockers + 1,
                timeline: [
                  ...l.timeline,
                  {
                    date: 'Today',
                    title: value,
                    detail: 'Needs owner assignment and resolution.',
                    type: 'Blocker',
                  },
                ],
              }));
            setModal(null);
            setToast(modal === 'event' ? 'Timeline event added' : 'Blocker logged');
          }}
        />
      )}
      {toast && (
        <div className="toast">
          <CheckCircle2 size={16} />
          {toast}
        </div>
      )}
    </div>
  );
}
function Dashboard({
  launches,
  totalArr,
  blockers,
  onSelect,
  onCreate,
}: {
  launches: Launch[];
  totalArr: number;
  blockers: number;
  onSelect: (l: Launch) => void;
  onCreate: () => void;
}) {
  const trend = [
    { week: 'May 20', rate: 18 },
    { week: 'May 27', rate: 22 },
    { week: 'Jun 03', rate: 29 },
    { week: 'Jun 10', rate: 35 },
    { week: 'Jun 17', rate: 38 },
    { week: 'Jun 24', rate: 46 },
  ];
  return (
    <section className="page">
      <div className="page-title">
        <div>
          <span className="eyebrow">PORTFOLIO VIEW · Q2 FY25</span>
          <h1>Command Center</h1>
          <p>Operational clarity for every launch, from readiness to adoption.</p>
        </div>
        <button className="primary" onClick={onCreate}>
          <Plus size={17} />
          New launch
        </button>
      </div>
      <div className="stats">
        <Stat label="Launch readiness" value="71%" delta="+8 pts" icon={<CheckCircle2 />} />
        <Stat
          label="ARR in flight"
          value={fmt(totalArr)}
          detail="across 3 active launches"
          icon={<LineChart />}
        />
        <Stat
          label="Unresolved blockers"
          value={String(blockers)}
          detail="2 need exec attention"
          icon={<AlertTriangle />}
        />
        <Stat label="Launch adoption" value="46%" delta="+11%" icon={<Activity />} />
      </div>
      <div className="dashboard-grid">
        <article className="panel trend">
          <div className="panel-title">
            <div>
              <h3>Adoption after launch</h3>
              <p>Target-account activation, portfolio average</p>
            </div>
            <button className="text-button">
              Last 6 weeks <ChevronDown size={14} />
            </button>
          </div>
          <div className="chart">
            <ResponsiveContainer width="100%" height={220}>
              <AreaChart data={trend}>
                <CartesianGrid stroke="#29313e" vertical={false} />
                <XAxis
                  dataKey="week"
                  tick={{ fill: '#818b9d', fontSize: 11 }}
                  axisLine={false}
                  tickLine={false}
                />
                <YAxis
                  tick={{ fill: '#818b9d', fontSize: 11 }}
                  axisLine={false}
                  tickLine={false}
                  unit="%"
                />
                <Tooltip
                  contentStyle={{
                    background: '#171d27',
                    border: '1px solid #343e4f',
                    borderRadius: 8,
                  }}
                />
                <Area
                  type="monotone"
                  dataKey="rate"
                  stroke="#c7f36a"
                  strokeWidth={2}
                  fill="#c7f36a"
                  fillOpacity={0.12}
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </article>
        <article className="panel activity">
          <div className="panel-title">
            <div>
              <h3>In flight</h3>
              <p>Prioritized by launch date</p>
            </div>
            <button className="icon">
              <MoreHorizontal size={18} />
            </button>
          </div>
          {launches
            .filter((l) => l.stage !== 'Planning')
            .slice(0, 3)
            .map((l) => (
              <button className="launch-mini" key={l.id} onClick={() => onSelect(l)}>
                <span className="dot" style={{ background: l.color }} />
                <div>
                  <b>{l.name}</b>
                  <small>
                    {l.code} · {l.stage}
                  </small>
                </div>
                <strong>{l.readiness}%</strong>
                <ChevronRight size={16} />
              </button>
            ))}
        </article>
        <article className="panel attention">
          <div className="panel-title">
            <div>
              <h3>Attention needed</h3>
              <p>Keep launches moving this week</p>
            </div>
            <span className="count">4</span>
          </div>
          <div className="attention-row">
            <span className="alert-dot">
              <AlertTriangle size={15} />
            </span>
            <div>
              <b>Security FAQ is blocking SCIM enablement</b>
              <p>Owner: Sales · 2 days overdue</p>
            </div>
            <button className="text-button">Open</button>
          </div>
          <div className="attention-row">
            <span className="alert-dot">
              <Clock3 size={15} />
            </span>
            <div>
              <b>Usage billing migration plan incomplete</b>
              <p>Owner: CS · due Friday</p>
            </div>
            <button className="text-button">Open</button>
          </div>
          <div className="attention-row">
            <span className="alert-dot">
              <Users size={15} />
            </span>
            <div>
              <b>Vantage Logistics is unengaged</b>
              <p>$175k ARR · SCIM pilot cohort</p>
            </div>
            <button className="text-button">Open</button>
          </div>
        </article>
        <article className="panel exposure">
          <div className="panel-title">
            <div>
              <h3>ARR exposure by launch</h3>
              <p>Accounts affected by active changes</p>
            </div>
          </div>
          <ResponsiveContainer width="100%" height={180}>
            <BarChart data={launches.slice(0, 3)} layout="vertical" margin={{ left: 20 }}>
              <XAxis type="number" hide />
              <YAxis
                type="category"
                dataKey="name"
                width={115}
                tick={{ fill: '#aeb6c5', fontSize: 11 }}
                axisLine={false}
                tickLine={false}
              />
              <Tooltip
                cursor={{ fill: '#222a36' }}
                contentStyle={{ background: '#171d27', border: '1px solid #343e4f' }}
                formatter={(v) => fmt(Number(v))}
              />
              <Bar dataKey="arr" fill="#8bb9ff" radius={[0, 3, 3, 0]} barSize={16} />
            </BarChart>
          </ResponsiveContainer>
        </article>
      </div>
    </section>
  );
}
function Stat({
  label,
  value,
  delta,
  detail,
  icon,
}: {
  label: string;
  value: string;
  delta?: string;
  detail?: string;
  icon: React.ReactNode;
}) {
  return (
    <article className="stat">
      <span className="stat-icon">{icon}</span>
      <p>{label}</p>
      <div>
        <h2>{value}</h2>
        {delta && <b className="positive">{delta}</b>}
      </div>
      <small>{detail || 'vs. last launch cycle'}</small>
    </article>
  );
}
function Releases({
  launches,
  q,
  setQ,
  stage,
  setStage,
  onSelect,
  onCreate,
}: {
  launches: Launch[];
  q: string;
  setQ: (s: string) => void;
  stage: string;
  setStage: (s: string) => void;
  onSelect: (l: Launch) => void;
  onCreate: () => void;
}) {
  const filtered = launches.filter(
    (l) =>
      (stage === 'All stages' || l.stage === stage) &&
      l.name.toLowerCase().includes(q.toLowerCase()),
  );
  return (
    <section className="page">
      <div className="page-title">
        <div>
          <span className="eyebrow">LAUNCH OPERATIONS</span>
          <h1>Releases</h1>
          <p>One operational workspace for every product change.</p>
        </div>
        <button className="primary" onClick={onCreate}>
          <Plus size={17} />
          New launch
        </button>
      </div>
      <div className="toolbar">
        <label className="search">
          <Search size={16} />
          <input placeholder="Search releases" value={q} onChange={(e) => setQ(e.target.value)} />
        </label>
        <label className="select">
          <Filter size={15} />
          <select value={stage} onChange={(e) => setStage(e.target.value)}>
            <option>All stages</option>
            <option>Planning</option>
            <option>Readiness</option>
            <option>In launch</option>
            <option>Measuring</option>
          </select>
        </label>
        <span className="result-count">{filtered.length} launches</span>
      </div>
      <div className="release-table">
        <div className="release-head">
          <span>Release</span>
          <span>Stage</span>
          <span>Readiness</span>
          <span>ARR affected</span>
          <span>Launch date</span>
          <span />
        </div>
        {filtered.map((l) => (
          <button className="release-row" key={l.id} onClick={() => onSelect(l)}>
            <div className="release-name">
              <span className="launch-symbol" style={{ borderColor: l.color }}>
                <Sparkles size={15} style={{ color: l.color }} />
              </span>
              <div>
                <b>{l.name}</b>
                <small>
                  {l.code} · {l.owner}
                </small>
              </div>
            </div>
            <span>
              <i className={'stage ' + l.stage.toLowerCase().replace(' ', '-')}>{l.stage}</i>
            </span>
            <span className="readiness">
              <b>{l.readiness}%</b>
              <i>
                <em style={{ width: l.readiness + '%' }} />
              </i>
            </span>
            <strong>{fmt(l.arr)}</strong>
            <span>{l.date}</span>
            <ChevronRight size={17} />
          </button>
        ))}
      </div>
      {!filtered.length && (
        <div className="empty">
          <Search size={28} />
          <h3>No releases found</h3>
          <p>Try adjusting the search or stage filter.</p>
        </div>
      )}
    </section>
  );
}
function Workspace({
  launch,
  tab,
  setTab,
  onBack,
  onUpdate,
  setModal,
}: {
  launch: Launch;
  tab: string;
  setTab: (x: string) => void;
  onBack: () => void;
  onUpdate: (id: number, fn: (l: Launch) => Launch) => void;
  setModal: (x: 'event' | 'blocker') => void;
}) {
  const tabs = ['Overview', 'Accounts', 'Activity', 'Executive recap'];
  const adoption = [
    { d: 'Wk 0', v: 3 },
    { d: 'Wk 1', v: 11 },
    { d: 'Wk 2', v: 21 },
    { d: 'Wk 3', v: 31 },
    { d: 'Wk 4', v: 38 },
  ];
  const [accountQ, setAccountQ] = useState('');
  const accounts = launch.accounts.filter((a) =>
    a.name.toLowerCase().includes(accountQ.toLowerCase()),
  );
  return (
    <section className="workspace-page">
      <div className="crumb">
        <button onClick={onBack}>
          <ChevronLeft size={16} /> Releases
        </button>
        <span>/</span>
        <b>{launch.code}</b>
      </div>
      <div className="workspace-hero">
        <div>
          <div className="launch-kicker">
            <span className="dot" style={{ background: launch.color }} />
            {launch.stage}
          </div>
          <h1>{launch.name}</h1>
          <p>{launch.description}</p>
        </div>
        <div className="hero-actions">
          <button className="secondary" onClick={() => setModal('event')}>
            <Plus size={16} />
            Add update
          </button>
          <button className="primary" onClick={() => setModal('blocker')}>
            <AlertTriangle size={16} />
            Log blocker
          </button>
        </div>
      </div>
      <div className="release-meta">
        <div>
          <span>Launch date</span>
          <b>{launch.date}</b>
        </div>
        <div>
          <span>DRI</span>
          <b>{launch.owner}</b>
        </div>
        <div>
          <span>Affected ARR</span>
          <b>{fmt(launch.arr)}</b>
        </div>
        <div>
          <span>Plan</span>
          <b>
            <i className="scale">Scale</i> $299/mo
          </b>
        </div>
      </div>
      <div className="tabs">
        {tabs.map((t) => (
          <button className={tab === t ? 'active' : ''} onClick={() => setTab(t)} key={t}>
            {t}
          </button>
        ))}
      </div>
      {tab === 'Overview' && (
        <div className="workspace-grid">
          <div>
            <article className="panel readiness-panel">
              <div className="panel-title">
                <div>
                  <h3>Launch readiness</h3>
                  <p>Cross-functional deliverables</p>
                </div>
                <strong className="big-score">{launch.readiness}%</strong>
              </div>
              <div className="readiness-ring">
                <div
                  className="ring"
                  style={{
                    background: `conic-gradient(#c7f36a ${launch.readiness * 3.6}deg,#2c3542 0)`,
                  }}
                >
                  <span>{launch.readiness}%</span>
                </div>
                <div>
                  <b>
                    {launch.checklist.filter((c) => c.done).length} of {launch.checklist.length}{' '}
                    items complete
                  </b>
                  <p>Target: complete critical work before launch.</p>
                </div>
              </div>
              <div className="checklist">
                {launch.checklist.length ? (
                  launch.checklist.map((c, i) => (
                    <label key={c.label}>
                      <input
                        type="checkbox"
                        checked={c.done}
                        onChange={() =>
                          onUpdate(launch.id, (l) => ({
                            ...l,
                            readiness: Math.min(100, Math.max(0, l.readiness + (c.done ? -6 : 6))),
                            checklist: l.checklist.map((x, j) =>
                              j === i ? { ...x, done: !x.done } : x,
                            ),
                          }))
                        }
                      />
                      <span className={c.done ? 'done' : ''}>
                        {c.done ? <Check size={14} /> : <Circle size={14} />} {c.label}
                      </span>
                      <small>{c.team}</small>
                    </label>
                  ))
                ) : (
                  <p className="muted">No workstreams defined yet.</p>
                )}
              </div>
            </article>
            <article className="panel adoption-panel">
              <div className="panel-title">
                <div>
                  <h3>Target-account adoption</h3>
                  <p>Activated administrators · first 4 weeks</p>
                </div>
                <b className="positive">+12 pts</b>
              </div>
              <ResponsiveContainer width="100%" height={215}>
                <AreaChart data={adoption}>
                  <CartesianGrid stroke="#29313e" vertical={false} />
                  <XAxis
                    dataKey="d"
                    tick={{ fill: '#818b9d', fontSize: 11 }}
                    axisLine={false}
                    tickLine={false}
                  />
                  <YAxis
                    tick={{ fill: '#818b9d', fontSize: 11 }}
                    axisLine={false}
                    tickLine={false}
                    unit="%"
                  />
                  <Tooltip contentStyle={{ background: '#171d27', border: '1px solid #343e4f' }} />
                  <Area
                    type="monotone"
                    dataKey="v"
                    stroke="#91e6d4"
                    fill="#91e6d4"
                    fillOpacity={0.12}
                  />
                </AreaChart>
              </ResponsiveContainer>
            </article>
            <article className="panel blockers">
              <div className="panel-title">
                <div>
                  <h3>Open blockers</h3>
                  <p>Resolve before broad rollout</p>
                </div>
                <span className="count danger">{launch.blockers}</span>
              </div>
              {launch.blockers ? (
                <>
                  <div className="blocker">
                    <AlertTriangle size={17} />
                    <div>
                      <b>Enterprise security FAQ</b>
                      <p>Missing approved SOC 2 wording · Sales</p>
                    </div>
                    <button className="icon">
                      <MoreHorizontal size={16} />
                    </button>
                  </div>
                  <div className="blocker">
                    <AlertTriangle size={17} />
                    <div>
                      <b>Pilot account setup</b>
                      <p>Vantage Logistics admin has not responded · CS</p>
                    </div>
                    <button className="icon">
                      <MoreHorizontal size={16} />
                    </button>
                  </div>
                </>
              ) : (
                <div className="empty small">
                  <CheckCircle2 size={24} />
                  <p>No blockers logged. Nice work.</p>
                </div>
              )}
            </article>
            <article className="panel timeline">
              <div className="panel-title">
                <div>
                  <h3>Launch activity</h3>
                  <p>Signals and decisions across the launch</p>
                </div>
                <button className="text-button" onClick={() => setTab('Activity')}>
                  View all
                </button>
              </div>
              <Timeline items={launch.timeline.slice(-3)} />
            </article>
          </div>
          <aside className="recap-card">
            <span className="eyebrow">EXECUTIVE RECAP</span>
            <h2>On track, with two risks to clear</h2>
            <p>
              {launch.name} is <b>{launch.readiness}% ready</b> and has reached{' '}
              <b>{launch.adoption}% adoption</b> across its target cohort.
            </p>
            <div className="recap-points">
              <div>
                <CheckCircle2 />
                Core enablement and in-app guidance are live.
              </div>
              <div>
                <AlertTriangle />
                Resolve security wording before expanding to financial services.
              </div>
              <div>
                <Users />
                Focus CS outreach on $425k ARR of low-adoption accounts.
              </div>
            </div>
            <button className="secondary wide" onClick={() => setTab('Executive recap')}>
              Open full recap <ArrowUpRight size={15} />
            </button>
            <small>Learning capture is included on your Scale plan.</small>
          </aside>
        </div>
      )}
      {tab === 'Accounts' && <Accounts accounts={accounts} q={accountQ} setQ={setAccountQ} />}{' '}
      {tab === 'Activity' && (
        <article className="panel activity-full">
          <div className="panel-title">
            <div>
              <h3>Launch event timeline</h3>
              <p>Every decision, signal, and blocker in one operational record.</p>
            </div>
            <button className="secondary" onClick={() => setModal('event')}>
              <Plus size={15} />
              Add event
            </button>
          </div>
          <Timeline items={launch.timeline} />
        </article>
      )}{' '}
      {tab === 'Executive recap' && <Executive launch={launch} />}
    </section>
  );
}
function Timeline({ items }: { items: Event[] }) {
  return (
    <div className="timeline-list">
      {items.length ? (
        items.map((e, i) => (
          <div className="timeline-event" key={i}>
            <span className={e.type === 'Blocker' ? 'event-icon bad' : 'event-icon'}>
              {e.type === 'Blocker' ? <AlertTriangle size={14} /> : <Activity size={14} />}
            </span>
            <div>
              <small>
                {e.date} · {e.type}
              </small>
              <b>{e.title}</b>
              <p>{e.detail}</p>
            </div>
          </div>
        ))
      ) : (
        <p className="muted">No activity yet.</p>
      )}
    </div>
  );
}
function Accounts({
  accounts,
  q,
  setQ,
}: {
  accounts: Account[];
  q: string;
  setQ: (x: string) => void;
}) {
  return (
    <article className="panel accounts">
      <div className="panel-title">
        <div>
          <h3>Affected accounts</h3>
          <p>Target cohort, readiness, and adoption health</p>
        </div>
        <label className="search small-search">
          <Search size={15} />
          <input placeholder="Search accounts" value={q} onChange={(e) => setQ(e.target.value)} />
        </label>
      </div>
      <div className="account-table">
        <div className="account-head">
          <span>Account</span>
          <span>Segment</span>
          <span>ARR</span>
          <span>Adoption</span>
          <span>Readiness</span>
          <span>Risk</span>
        </div>
        {accounts.map((a) => (
          <div className="account-row" key={a.name}>
            <b>{a.name}</b>
            <span>{a.segment}</span>
            <strong>{fmt(a.arr)}</strong>
            <span>{a.adoption}%</span>
            <span className="readiness">
              <b>{a.readiness}%</b>
              <i>
                <em style={{ width: a.readiness + '%' }} />
              </i>
            </span>
            <i className={'risk ' + a.risk.toLowerCase()}>{a.risk}</i>
          </div>
        ))}
      </div>
      {!accounts.length && (
        <div className="empty">
          <Users size={28} />
          <h3>No matching accounts</h3>
          <p>Try a different search term.</p>
        </div>
      )}
    </article>
  );
}
function Executive({ launch }: { launch: Launch }) {
  return (
    <div className="exec-grid">
      <article className="panel exec-main">
        <span className="eyebrow">WEEKLY LAUNCH READOUT</span>
        <h2>{launch.name}: ready to expand deliberately</h2>
        <p>
          Launch health is strong overall. Enablement is complete, and early customer activation
          signals are positive. The team should resolve the outstanding security and outreach issues
          before moving beyond the pilot cohort.
        </p>
        <div className="exec-stats">
          <div>
            <b>{launch.readiness}%</b>
            <span>Readiness</span>
          </div>
          <div>
            <b>{fmt(launch.arr)}</b>
            <span>ARR affected</span>
          </div>
          <div>
            <b>{launch.adoption}%</b>
            <span>Adoption</span>
          </div>
        </div>
        <h3>Recommendation</h3>
        <p>
          Maintain the current rollout pace. Review blocker status in the Friday launch standup and
          use the pilot feedback to tighten the administrator onboarding sequence.
        </p>
      </article>
      <article className="panel">
        <h3>Reusable learning</h3>
        <p className="muted">Capture what worked so the next enterprise launch starts ahead.</p>
        <div className="learning">
          <Sparkles />
          <div>
            <b>What resonated</b>
            <p>Admins responded well to the 3-step setup guide.</p>
          </div>
        </div>
        <div className="learning">
          <HelpCircle />
          <div>
            <b>What to improve</b>
            <p>Security collateral needs an earlier approval gate.</p>
          </div>
        </div>
      </article>
    </div>
  );
}
function Integrations() {
  const sources = [
    ['Github', 'Engineering delivery signals', Github, 'Connected', '14 repositories'],
    ['Linear', 'Product milestones and projects', LayoutList, 'Connected', '3 active teams'],
    ['HubSpot', 'Accounts, segments and ARR', Users, 'Connected', '2,184 companies'],
    ['Segment', 'Adoption events and cohorts', Activity, 'Needs setup', 'Map activation event'],
  ];
  return (
    <section className="page">
      <div className="page-title">
        <div>
          <span className="eyebrow">DATA FOUNDATION</span>
          <h1>Data sources</h1>
          <p>Connect the operational signals that make every launch trustworthy.</p>
        </div>
        <button className="secondary">
          <Settings size={16} />
          Manage fields
        </button>
      </div>
      <div className="integration-intro">
        <div>
          <span className="intro-icon">
            <Blocks size={22} />
          </span>
          <div>
            <h3>One shared launch record</h3>
            <p>
              Launchline brings product delivery, customer exposure, and adoption together. We show
              source context rather than inventing attribution.
            </p>
          </div>
        </div>
        <span className="scale">Scale plan</span>
      </div>
      <div className="integration-grid">
        {sources.map(([name, desc, Icon, status, meta]) => {
          const I = Icon as React.ElementType;
          return (
            <article className="integration" key={String(name)}>
              <div className="integration-top">
                <span className="source-icon">
                  <I size={20} />
                </span>
                <i className={status === 'Connected' ? 'connected' : 'setup'}>{String(status)}</i>
              </div>
              <h3>{String(name)}</h3>
              <p>{String(desc)}</p>
              <div className="integration-foot">
                <span>{String(meta)}</span>
                <button className="text-button">
                  {status === 'Connected' ? 'Configure' : 'Connect'} <ArrowUpRight size={13} />
                </button>
              </div>
            </article>
          );
        })}
      </div>
      <article className="panel source-map">
        <div>
          <h3>How signals flow into a launch</h3>
          <p>Mapped fields update continuously and retain source context.</p>
        </div>
        <div className="flow">
          <span>Linear project</span>
          <ArrowUpRight />
          <span>Launch workspace</span>
          <ArrowUpRight />
          <span>Executive recap</span>
        </div>
      </article>
    </section>
  );
}
function Modal({
  kind,
  close,
  create,
  onSubmit,
}: {
  kind: 'launch' | 'event' | 'blocker';
  close: () => void;
  create: (s: string) => void;
  launch: Launch | null;
  onSubmit: (s: string) => void;
}) {
  const [value, setValue] = useState('');
  const title =
    kind === 'launch'
      ? 'Create a launch workspace'
      : kind === 'event'
        ? 'Add launch activity'
        : 'Log a blocker';
  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true">
      <form
        className="modal"
        onSubmit={(e) => {
          e.preventDefault();
          if (value.trim()) {
            kind === 'launch' ? create(value) : onSubmit(value);
          }
        }}
      >
        <div className="modal-title">
          <div>
            <span className="eyebrow">
              {kind === 'launch' ? 'NEW RELEASE' : 'LAUNCH WORKSPACE'}
            </span>
            <h2>{title}</h2>
          </div>
          <button type="button" className="icon" onClick={close}>
            <X />
          </button>
        </div>
        <label>
          {kind === 'launch' ? 'Release name' : 'Title'}
          <input
            autoFocus
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder={
              kind === 'launch'
                ? 'e.g. SAML JIT provisioning'
                : kind === 'event'
                  ? 'e.g. Customer webinar completed'
                  : 'e.g. Legal review is overdue'
            }
          />
        </label>
        {kind === 'launch' && (
          <label>
            Launch stage
            <select>
              <option>Planning</option>
              <option>Readiness</option>
            </select>
          </label>
        )}
        <div className="modal-actions">
          <button type="button" className="secondary" onClick={close}>
            Cancel
          </button>
          <button className="primary" type="submit">
            {kind === 'launch'
              ? 'Create workspace'
              : kind === 'event'
                ? 'Add event'
                : 'Log blocker'}
          </button>
        </div>
      </form>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
