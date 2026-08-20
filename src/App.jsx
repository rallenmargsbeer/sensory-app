import React, { useState, useEffect, useMemo } from 'react';
import { Radar, RadarChart, PolarGrid, PolarAngleAxis, PolarRadiusAxis, ResponsiveContainer, Legend } from 'recharts';
import { Beaker, ClipboardList, Archive, Settings, LayoutDashboard, Plus, X, Check, User, Upload, Users, ChevronRight, LogOut } from 'lucide-react';
import Papa from 'papaparse';
import { supabase } from './supabaseClient';

// ============================================================
// Trait taxonomy — fixed master list of every trait scored, per your
// spider diagram spec. Two sections (Aroma, Flavour & Body), each with
// Category > Trait groups. Every SKU/tasting uses this exact same list;
// only the scores differ.
// ============================================================
const INTENSITY_LEVELS = [
  { label: 'Absent', score: 1 },
  { label: 'Low', score: 3 },
  { label: 'Medium', score: 5 },
  { label: 'High', score: 7 },
  { label: 'Very High', score: 9 },
];

function slug(s) { return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, ''); }
function traitId(category, trait) { return `${slug(category)}__${slug(trait)}`; }

const TRAIT_TAXONOMY = {
  aroma: [
    { category: 'Malt', traits: ['Caramel', 'Toast', 'Biscuit', 'Bread', 'Roast', 'Choc'] },
    { category: 'Hops', traits: ['Citrus', 'Floral', 'Pine', 'Fruity', 'Herbal', 'Earthy', 'Diesel', 'Noble', 'Other'] },
    { category: 'Esters', traits: ['Apple', 'Fruity', 'Bready'] },
    { category: 'Phenols', traits: ['Phenolic'] },
    { category: 'Other', traits: ['Other 1', 'Other 2', 'Other 3'] },
  ],
  flavor: [
    { category: 'Malt', traits: ['Sweetness', 'Caramel', 'Toasty', 'Biscuity', 'Cracker', 'Bready', 'Roasted', 'Chocolate'] },
    { category: 'Hops', traits: ['Citrus', 'Floral', 'Fruity', 'Resinous', 'Herbal', 'Spicy', 'Earthy', 'Grassy', 'Savoury'] },
    { category: 'Ester Profile', traits: ['Apple', 'Fruity', 'Bready', 'Phenolic'] },
    { category: 'Bitterness', traits: ['Initial bitterness', 'Lingering Bitterness'] },
    { category: 'Acidity', traits: ['Tartness', 'Lactic', 'Acetic'] },
    { category: 'Body', traits: ['Crispness', 'Salty', 'Viscosity', 'Carbonation'] },
    { category: 'Alcohol', traits: ['Heat'] },
    { category: 'Other', traits: ['Other 1'] },
  ],
};

const SECTION_LABELS = { aroma: 'Aroma', flavor: 'Flavour & Body' };

// Only these exact names get imported — anything else is ignored.
const CORE_BEERS = ['Drift', 'Pale', 'Kolsch', 'River Dog', 'In The Pines', 'Red IPA', 'Mermid', 'Stout', 'Brown', 'Draught'];

function defaultSectionScores(section) {
  const out = {};
  TRAIT_TAXONOMY[section].forEach(group => group.traits.forEach(t => { out[traitId(group.category, t)] = 1; }));
  return out;
}
function defaultAllScores() { return { aroma: defaultSectionScores('aroma'), flavor: defaultSectionScores('flavor') }; }
function normalizeTarget(target) {
  if (target && typeof target.aroma === 'object' && typeof target.flavor === 'object') return target;
  return defaultAllScores(); // handles the old 5-attribute format from before this rebuild
}
function getScore(scoresObj, section, id) { return (scoresObj && scoresObj[section] && scoresObj[section][id]) ?? 1; }

// Some trait names repeat within a section under different categories
// (e.g. "Fruity" under both Hops and Esters) — disambiguate only those
// for radar chart labels.
function traitLabelsFor(section) {
  const nameCounts = {};
  TRAIT_TAXONOMY[section].forEach(g => g.traits.forEach(t => { nameCounts[t] = (nameCounts[t] || 0) + 1; }));
  const labels = {};
  TRAIT_TAXONOMY[section].forEach(g => g.traits.forEach(t => {
    const id = traitId(g.category, t);
    labels[id] = nameCounts[t] > 1 ? `${t} (${g.category})` : t;
  }));
  return labels;
}

const OFF_FLAVORS = [
  'Diacetyl (buttery)', 'DMS (cooked corn)', 'Acetaldehyde (green apple)',
  'Oxidation (cardboard/papery)', 'Phenolic (band-aid/clove)', 'Astringent (drying/tannic)',
  'Unintended sour/acidic', 'Skunked (lightstruck)', 'Metallic', 'Yeasty/Sulfury',
  'Infection (off-aroma/haze)', 'Solvent/Fusel',
];

const RETENTION_INTERVALS = [30, 90, 180];

function todayISO() { return new Date().toISOString().slice(0, 10); }
function daysBetween(a, b) { return Math.round((new Date(b) - new Date(a)) / 86400000); }
function addDays(dateStr, n) { const d = new Date(dateStr); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); }

// ============================================================
// Data layer — talks to Supabase instead of window.storage
// ============================================================
function useSupabaseData(session) {
  const [skus, setSkus] = useState([]);
  const [batches, setBatches] = useState([]);
  const [retention, setRetention] = useState([]);
  const [sessions, setSessions] = useState([]);
  const [panels, setPanels] = useState([]);
  const [panelBatches, setPanelBatches] = useState([]);
  const [profiles, setProfiles] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const loadAll = async () => {
    setLoading(true); setError(null);
    try {
      const [s, b, r, se, p, pb, pr] = await Promise.all([
        supabase.from('skus').select('*'),
        supabase.from('batches').select('*'),
        supabase.from('retention_checkpoints').select('*'),
        supabase.from('sessions').select('*'),
        supabase.from('panels').select('*'),
        supabase.from('panel_batches').select('*'),
        supabase.from('profiles').select('*'),
      ]);
      if (s.error) throw s.error;
      setSkus(s.data || []);
      setBatches((b.data || []).sort((a, b2) => Number(b2.batch_number) - Number(a.batch_number)));
      setRetention(r.data || []);
      setSessions(se.data || []);
      setPanels(p.data || []);
      setPanelBatches(pb.data || []);
      setProfiles(pr.data || []);
    } catch (e) {
      setError(e.message || 'Failed to load data.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { if (session) loadAll(); }, [session]);

  const profileName = (id) => (profiles.find(p => p.id === id) || {}).name || 'Unknown';

  // ---- mutations ----
  const addSku = async (sku) => {
    const { error } = await supabase.from('skus').insert({
      name: sku.name, style: sku.style, abv: sku.abv, descriptors: sku.descriptors,
      watchouts: sku.watchouts, target: sku.target, tolerance: sku.tolerance, notes: sku.notes,
    });
    if (error) throw error;
    await loadAll();
  };

  const updateSku = async (sku) => {
    const { error } = await supabase.from('skus').update({
      name: sku.name, style: sku.style, abv: sku.abv, descriptors: sku.descriptors,
      watchouts: sku.watchouts, target: sku.target, tolerance: sku.tolerance, notes: sku.notes,
    }).eq('id', sku.id);
    if (error) throw error;
    await loadAll();
  };

  const addBatch = async ({ skuId, batchNumber, packageDate, format }) => {
    const { data, error } = await supabase.from('batches').insert({
      sku_id: skuId, batch_number: batchNumber, package_date: packageDate || null, format,
    }).select().single();
    if (error) throw error;
    const checkpoints = RETENTION_INTERVALS.map(days => ({
      batch_id: data.id, days, due_date: addDays(packageDate || todayISO(), days), assessed: false,
    }));
    const { error: rErr } = await supabase.from('retention_checkpoints').insert(checkpoints);
    if (rErr) throw rErr;
    await loadAll();
    return data.id;
  };

  // Imports batches directly from parsed sheet rows: creates any missing
  // SKUs, creates/updates batches, sets up retention checkpoints. Used by
  // the Batches tab importer. Returns a summary of what happened.
  const importBatches = async (rows) => {
    let added = 0, skipped = 0;
    for (const row of rows) {
      if (!row.packagedDate) { skipped++; continue; } // not yet packaged (or kegged, not canned) — don't import
      const existing = batches.find(b => b.batch_number === row.batchNumber);
      if (existing) { skipped++; continue; }

      let sku = skus.find(s => s.name.toLowerCase() === row.skuName.toLowerCase());
      if (!sku) {
        const { data: newSku, error: skuErr } = await supabase.from('skus').insert({
          name: row.skuName, style: '', abv: 0, descriptors: [], watchouts: [],
          target: defaultAllScores(), tolerance: 2,
          notes: 'Auto-created from a sheet import — set a real target profile.',
        }).select().single();
        if (skuErr) throw skuErr;
        sku = newSku;
        skus.push(sku); // keep local lookup current within this loop
      }

      const packageDate = row.packagedDate;
      const { data: newBatch, error: batchErr } = await supabase.from('batches').insert({
        sku_id: sku.id, batch_number: row.batchNumber, package_date: packageDate, format: 'Can',
      }).select().single();
      if (batchErr) throw batchErr;
      batches.push(newBatch);

      const checkpoints = RETENTION_INTERVALS.map(days => ({
        batch_id: newBatch.id, days, due_date: addDays(packageDate, days), assessed: false,
      }));
      await supabase.from('retention_checkpoints').insert(checkpoints);
      added++;
    }
    await loadAll();
    return { added, skipped };
  };

  const addSession = async (sess) => {
    const { error } = await supabase.from('sessions').insert({
      batch_id: sess.batchId, taster_id: session.user.id, date: sess.date, scores: sess.scores,
      overall: sess.overall, off_flavors: sess.offFlavors, notes: sess.notes,
      retention_checkpoint_id: sess.retentionCheckpointId || null,
    });
    if (error) throw error;
    if (sess.retentionCheckpointId) {
      await supabase.from('retention_checkpoints').update({ assessed: true }).eq('id', sess.retentionCheckpointId);
    }
    await loadAll();
  };

  const createPanel = async ({ date, label, batchIds }) => {
    const { data: panel, error } = await supabase.from('panels').insert({ date, label }).select().single();
    if (error) throw error;
    await supabase.from('panel_batches').insert(batchIds.map(bid => ({ panel_id: panel.id, batch_id: bid })));
    await loadAll();
  };

  return {
    skus, batches, retention, sessions, panels, panelBatches, profiles, profileName,
    loading, error, reload: loadAll,
    addSku, updateSku, addBatch, addSession, createPanel, importBatches,
  };
}

// ============================================================
// Shared UI pieces
// ============================================================
const Pill = ({ children, tone = 'neutral' }) => {
  const tones = {
    neutral: { background: 'var(--surface-2)', color: 'var(--text-muted)' },
    good: { background: 'rgba(122,157,122,0.16)', color: 'var(--good)' },
    bad: { background: 'rgba(196,90,68,0.16)', color: 'var(--bad)' },
    warn: { background: 'rgba(199,143,60,0.18)', color: 'var(--accent)' },
  };
  return <span style={{ ...tones[tone], fontSize: 11, fontWeight: 600, padding: '3px 9px', borderRadius: 20, letterSpacing: 0.3, textTransform: 'uppercase', fontFamily: 'var(--font-mono)' }}>{children}</span>;
};

const Card = ({ children, style }) => (
  <div style={{ background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: 10, padding: 20, ...style }}>{children}</div>
);

const Button = ({ children, onClick, variant = 'primary', style, type = 'button', disabled }) => {
  const variants = {
    primary: { background: 'var(--accent)', color: '#1a1410', border: '1px solid var(--accent)' },
    ghost: { background: 'transparent', color: 'var(--text)', border: '1px solid var(--line)' },
    danger: { background: 'transparent', color: 'var(--bad)', border: '1px solid rgba(196,90,68,0.4)' },
  };
  return (
    <button type={type} onClick={onClick} disabled={disabled} style={{
      ...variants[variant], fontFamily: 'var(--font-body)', fontWeight: 600, fontSize: 13.5,
      padding: '9px 16px', borderRadius: 7, cursor: disabled ? 'not-allowed' : 'pointer',
      opacity: disabled ? 0.5 : 1, display: 'inline-flex', alignItems: 'center', gap: 6,
    }}>{children}</button>
  );
};

const Field = ({ label, children }) => (
  <label style={{ display: 'block', marginBottom: 14 }}>
    <span style={{ display: 'block', fontSize: 12, fontWeight: 600, color: 'var(--text-muted)', marginBottom: 6, textTransform: 'uppercase', letterSpacing: 0.4 }}>{label}</span>
    {children}
  </label>
);

const inputStyle = {
  width: '100%', background: 'var(--surface-2)', border: '1px solid var(--line)', borderRadius: 6,
  padding: '9px 11px', color: 'var(--text)', fontSize: 14, fontFamily: 'var(--font-body)', boxSizing: 'border-box',
};

function IntensityPicker({ value, onChange, target, tolerance }) {
  const offTarget = target != null && Math.abs(value - target) > tolerance;
  return (
    <div style={{ display: 'flex', gap: 4 }}>
      {INTENSITY_LEVELS.map(lvl => {
        const active = value === lvl.score;
        const isTarget = target === lvl.score;
        return (
          <button key={lvl.score} type="button" onClick={() => onChange(lvl.score)} title={lvl.label} style={{
            flex: 1, padding: '6px 2px', fontSize: 10.5, borderRadius: 5, cursor: 'pointer', fontFamily: 'var(--font-mono)',
            border: `1px solid ${isTarget ? 'var(--accent)' : 'var(--line)'}`,
            background: active ? (offTarget ? 'rgba(196,90,68,0.22)' : 'rgba(122,157,122,0.22)') : 'transparent',
            color: active ? (offTarget ? 'var(--bad)' : 'var(--good)') : 'var(--text-muted)',
            fontWeight: active ? 700 : 400,
          }}>{lvl.label.split(' ').map(w => w[0]).join('')}</button>
        );
      })}
    </div>
  );
}

function TraitSpiderChart({ section, target, actual, height = 420 }) {
  const labels = traitLabelsFor(section);
  const chartData = TRAIT_TAXONOMY[section].flatMap(g => g.traits.map(t => {
    const id = traitId(g.category, t);
    return { trait: labels[id], Target: target ? (target[id] ?? 1) : 0, Batch: actual ? (actual[id] ?? 1) : 0 };
  }));
  return (
    <ResponsiveContainer width="100%" height={height}>
      <RadarChart data={chartData} outerRadius="78%">
        <PolarGrid stroke="var(--line)" />
        <PolarAngleAxis dataKey="trait" tick={{ fill: 'var(--text-muted)', fontSize: 10.5, fontFamily: 'var(--font-mono)' }} />
        <PolarRadiusAxis domain={[0, 9]} tick={false} axisLine={false} />
        {target && <Radar name="TTT Target" dataKey="Target" stroke="var(--text-faint)" strokeDasharray="4 3" fill="var(--text-faint)" fillOpacity={0.05} />}
        {actual && <Radar name="This Batch" dataKey="Batch" stroke="var(--accent)" fill="var(--accent)" fillOpacity={0.28} />}
        <Legend wrapperStyle={{ fontSize: 12, fontFamily: 'var(--font-body)' }} />
      </RadarChart>
    </ResponsiveContainer>
  );
}

function TraitSectionEditor({ section, scores, onChange, target, tolerance }) {
  return (
    <div>
      {TRAIT_TAXONOMY[section].map(group => (
        <div key={group.category} style={{ marginBottom: 16 }}>
          <p style={{ fontSize: 11.5, fontWeight: 700, color: 'var(--accent)', textTransform: 'uppercase', letterSpacing: 0.4, margin: '0 0 8px' }}>{group.category}</p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {group.traits.map(t => {
              const id = traitId(group.category, t);
              return (
                <div key={id} style={{ display: 'grid', gridTemplateColumns: '110px 1fr', gap: 10, alignItems: 'center' }}>
                  <span style={{ fontSize: 12.5, color: 'var(--text-muted)' }}>{t}</span>
                  <IntensityPicker value={scores[id] ?? 1} onChange={v => onChange(id, v)} target={target ? (target[id] ?? null) : null} tolerance={tolerance ?? 0} />
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

function TagInput({ values, onChange, placeholder }) {
  const [draft, setDraft] = useState('');
  const add = () => { if (draft.trim()) { onChange([...values, draft.trim()]); setDraft(''); } };
  return (
    <div>
      <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
        <input style={inputStyle} value={draft} onChange={e => setDraft(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); add(); } }} placeholder={placeholder} />
        <Button variant="ghost" onClick={add}>Add</Button>
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {values.map((v, i) => (
          <span key={i} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12, background: 'var(--surface-2)', color: 'var(--text-muted)', padding: '4px 8px 4px 10px', borderRadius: 20 }}>
            {v} <X size={12} style={{ cursor: 'pointer' }} onClick={() => onChange(values.filter((_, idx) => idx !== i))} />
          </span>
        ))}
      </div>
    </div>
  );
}

// ============================================================
// Auth screen
// ============================================================
function AuthScreen() {
  const [mode, setMode] = useState('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true); setError('');
    try {
      if (mode === 'signin') {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
      } else {
        const { error } = await supabase.auth.signUp({ email, password, options: { data: { name } } });
        if (error) throw error;
      }
    } catch (e) {
      setError(e.message || 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--bg)' }}>
      <Card style={{ width: 360 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 20 }}>
          <div style={{ width: 34, height: 34, borderRadius: 8, background: 'var(--accent)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Beaker size={18} color="#1a1410" />
          </div>
          <div>
            <p style={{ margin: 0, fontFamily: 'var(--font-display)', fontSize: 19, fontWeight: 700, lineHeight: 1 }}>Panel</p>
            <p style={{ margin: 0, fontSize: 11, color: 'var(--text-faint)', fontFamily: 'var(--font-mono)', letterSpacing: 0.5 }}>SENSORY LOG</p>
          </div>
        </div>

        {mode === 'signup' && <Field label="Your name"><input style={inputStyle} value={name} onChange={e => setName(e.target.value)} /></Field>}
        <Field label="Email"><input type="email" style={inputStyle} value={email} onChange={e => setEmail(e.target.value)} /></Field>
        <Field label="Password"><input type="password" style={inputStyle} value={password} onChange={e => setPassword(e.target.value)} /></Field>

        {error && <p style={{ color: 'var(--bad)', fontSize: 12.5, marginBottom: 12 }}>{error}</p>}

        <Button onClick={submit} disabled={busy || !email || !password || (mode === 'signup' && !name)} style={{ width: '100%', justifyContent: 'center', marginBottom: 10 }}>
          {busy ? 'Working…' : mode === 'signin' ? 'Sign in' : 'Create account'}
        </Button>
        <p style={{ fontSize: 12.5, color: 'var(--text-muted)', textAlign: 'center', margin: 0 }}>
          {mode === 'signin' ? "New here?" : 'Already have an account?'}{' '}
          <span style={{ color: 'var(--accent)', cursor: 'pointer' }} onClick={() => { setMode(mode === 'signin' ? 'signup' : 'signin'); setError(''); }}>
            {mode === 'signin' ? 'Create an account' : 'Sign in'}
          </span>
        </p>
      </Card>
    </div>
  );
}

// ============================================================
// Tasting form
// ============================================================
function TastingForm({ store, currentProfile, onDone, presetBatchId }) {
  const [batchId, setBatchId] = useState(presetBatchId || (store.batches[0] ? store.batches[0].id : ''));
  useEffect(() => { if (presetBatchId) setBatchId(presetBatchId); }, [presetBatchId]);
  const [scores, setScores] = useState(defaultAllScores());
  const [activeSection, setActiveSection] = useState('aroma');
  const [overall, setOverall] = useState('pass');
  const [offFlavors, setOffFlavors] = useState([]);
  const [notes, setNotes] = useState('');
  const [retentionCheckpointId, setRetentionCheckpointId] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  const batch = store.batches.find(b => b.id === batchId);
  const sku = batch ? store.skus.find(s => s.id === batch.sku_id) : null;
  const dueCheckpoints = batch ? store.retention.filter(r => r.batch_id === batch.id && !r.assessed) : [];

  const toggleOff = (f) => setOffFlavors(prev =>
    prev.some(x => x.flavor === f) ? prev.filter(x => x.flavor !== f) : [...prev, { flavor: f, intensity: 3 }]);
  const setOffIntensity = (f, intensity) => setOffFlavors(prev => prev.map(x => x.flavor === f ? { ...x, intensity } : x));
  const setTraitScore = (section, id, v) => setScores(s => ({ ...s, [section]: { ...s[section], [id]: v } }));

  const submit = async () => {
    if (!batchId) return;
    setSubmitting(true); setError('');
    try {
      await store.addSession({ batchId, date: todayISO(), scores, overall, offFlavors, notes, retentionCheckpointId: retentionCheckpointId || null });
      onDone();
    } catch (e) {
      setError(e.message || 'Could not submit — try again.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div>
      <Card style={{ marginBottom: 20 }}>
        <h4 style={{ margin: '0 0 2px', fontFamily: 'var(--font-display)', fontSize: 18 }}>{sku ? sku.name : 'No SKU selected'}</h4>
        <p style={{ margin: '0 0 16px', fontSize: 12.5, color: 'var(--text-muted)' }}>{sku ? `${sku.style} · ${sku.abv}% ABV` : ''}</p>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20 }}>
          {Object.keys(SECTION_LABELS).map(sec => (
            <div key={sec}>
              <p style={{ margin: '0 0 4px', fontSize: 12, fontWeight: 700, color: 'var(--text-faint)', textTransform: 'uppercase', textAlign: 'center' }}>{SECTION_LABELS[sec]}</p>
              <TraitSpiderChart section={sec} target={sku ? sku.target[sec] : null} actual={scores[sec]} height={440} />
            </div>
          ))}
        </div>
      </Card>

      <div style={{ display: 'grid', gridTemplateColumns: '1.15fr 0.85fr', gap: 24 }}>
        <Card>
          <h3 style={{ margin: '0 0 4px', fontFamily: 'var(--font-display)', fontSize: 20 }}>Log a tasting</h3>
          <p style={{ margin: '0 0 20px', color: 'var(--text-muted)', fontSize: 13 }}>Tasting as <strong style={{ color: 'var(--text)' }}>{currentProfile.name}</strong></p>

          <Field label="Batch">
            <select style={inputStyle} value={batchId} onChange={e => { setBatchId(e.target.value); setRetentionCheckpointId(''); }}>
              {store.batches.map(b => {
                const s = store.skus.find(sk => sk.id === b.sku_id);
                return <option key={b.id} value={b.id}>{b.batch_number} — {s ? s.name : 'Unknown SKU'}</option>;
              })}
            </select>
          </Field>

          {dueCheckpoints.length > 0 && (
            <Field label="Retention checkpoint (optional)">
              <select style={inputStyle} value={retentionCheckpointId} onChange={e => setRetentionCheckpointId(e.target.value)}>
                <option value="">Not a scheduled checkpoint</option>
                {dueCheckpoints.map(r => <option key={r.id} value={r.id}>Day {r.days} — due {r.due_date}</option>)}
              </select>
            </Field>
          )}

          <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
            {Object.keys(SECTION_LABELS).map(sec => (
              <button key={sec} type="button" onClick={() => setActiveSection(sec)} style={{
                flex: 1, padding: '9px 0', borderRadius: 7, fontWeight: 700, fontSize: 13, cursor: 'pointer',
                border: `1px solid ${activeSection === sec ? 'var(--accent)' : 'var(--line)'}`,
                background: activeSection === sec ? 'rgba(199,143,60,0.16)' : 'transparent',
                color: activeSection === sec ? 'var(--accent)' : 'var(--text-muted)',
              }}>{SECTION_LABELS[sec]}</button>
            ))}
          </div>

          <TraitSectionEditor section={activeSection} scores={scores[activeSection]} onChange={(id, v) => setTraitScore(activeSection, id, v)}
            target={sku ? sku.target[activeSection] : null} tolerance={sku ? sku.tolerance : 2} />

                    <Field label="Off-flavors detected">
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: offFlavors.length > 0 ? 10 : 0 }}>
              {OFF_FLAVORS.map(f => {
                const selected = offFlavors.some(x => x.flavor === f);
                return (
                  <button key={f} type="button" onClick={() => toggleOff(f)} style={{
                    fontSize: 12, padding: '6px 10px', borderRadius: 20, cursor: 'pointer',
                    border: `1px solid ${selected ? 'var(--bad)' : 'var(--line)'}`,
                    background: selected ? 'rgba(196,90,68,0.16)' : 'transparent',
                    color: selected ? 'var(--bad)' : 'var(--text-muted)',
                  }}>{f}</button>
                );
              })}
            </div>
            {offFlavors.length > 0 && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {offFlavors.map(({ flavor, intensity }) => (
                  <div key={flavor} style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 10, alignItems: 'center', background: 'var(--surface-2)', borderRadius: 6, padding: '8px 10px' }}>
                    <span style={{ fontSize: 12.5, color: 'var(--bad)' }}>{flavor}</span>
                    <div style={{ display: 'flex', gap: 4 }}>
                      {[1, 2, 3, 4, 5].map(n => (
                        <button key={n} type="button" onClick={() => setOffIntensity(flavor, n)} style={{
                          width: 24, height: 24, borderRadius: 5, fontSize: 11, cursor: 'pointer', fontFamily: 'var(--font-mono)',
                          border: `1px solid ${intensity === n ? 'var(--bad)' : 'var(--line)'}`,
                          background: intensity === n ? 'rgba(196,90,68,0.28)' : 'transparent',
                          color: intensity === n ? 'var(--bad)' : 'var(--text-muted)', fontWeight: intensity === n ? 700 : 400,
                        }}>{n}</button>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Field>

          <Field label="Tasting notes">
            <textarea style={{ ...inputStyle, minHeight: 90, resize: 'vertical', fontFamily: 'var(--font-body)' }}
              value={notes} onChange={e => setNotes(e.target.value)} placeholder="What stood out?" />
          </Field>

          <Field label="Overall call">
            <div style={{ display: 'flex', gap: 8 }}>
              {['pass', 'flag', 'fail'].map(v => (
                <button key={v} type="button" onClick={() => setOverall(v)} style={{
                  flex: 1, padding: '9px 0', borderRadius: 7, textTransform: 'capitalize', fontWeight: 600, fontSize: 13, cursor: 'pointer',
                  border: `1px solid ${overall === v ? 'var(--accent)' : 'var(--line)'}`,
                  background: overall === v ? 'rgba(199,143,60,0.16)' : 'transparent',
                  color: overall === v ? 'var(--accent)' : 'var(--text-muted)',
                }}>{v}</button>
              ))}
            </div>
          </Field>

          {error && <p style={{ color: 'var(--bad)', fontSize: 12.5, marginBottom: 8 }}>{error}</p>}
          <Button onClick={submit} disabled={!batchId || submitting} style={{ width: '100%', justifyContent: 'center' }}>
            <Check size={15} /> {submitting ? 'Submitting…' : 'Submit tasting'}
          </Button>
        </Card>

        {sku && (
          <Card style={{ alignSelf: 'start' }}>
            <p style={{ margin: '0 0 8px', fontSize: 12, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase' }}>True-to-type reference</p>
            <p style={{ margin: '0 0 10px', fontSize: 13.5, lineHeight: 1.5 }}>{sku.notes}</p>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, marginBottom: 10 }}>{sku.descriptors.map(d => <Pill key={d}>{d}</Pill>)}</div>
            {sku.watchouts.length > 0 && <p style={{ margin: 0, fontSize: 12, color: 'var(--bad)' }}>Watch for: {sku.watchouts.join(', ')}</p>}
          </Card>
        )}
      </div>
    </div>
  );
}

// ============================================================
// Panels
// ============================================================
function PanelsView({ store, isLead, currentProfile, onLogTasting }) {
  const [building, setBuilding] = useState(false);
  const [label, setLabel] = useState('');
  const [date, setDate] = useState(todayISO());
  const [selected, setSelected] = useState([]);
  const [busy, setBusy] = useState(false);

  const toggleSelect = (id) => setSelected(prev => prev.includes(id) ? prev.filter(b => b !== id) : [...prev, id]);

  const create = async () => {
    if (selected.length === 0) return;
    setBusy(true);
    try {
      await store.createPanel({ date, label: label || `Panel — ${date}`, batchIds: selected });
      setBuilding(false); setLabel(''); setSelected([]);
    } finally {
      setBusy(false);
    }
  };

  const sortedPanels = useMemo(() => [...store.panels].sort((a, b) => b.date.localeCompare(a.date)), [store.panels]);

  const panelProgress = (panel) => {
    const batchIds = store.panelBatches.filter(pb => pb.panel_id === panel.id).map(pb => pb.batch_id);
    const total = batchIds.length;
    const doneByMe = batchIds.filter(bid => store.sessions.some(s => s.batch_id === bid && s.taster_id === currentProfile.id)).length;
    return { total, doneByMe, batchIds };
  };

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
        <div>
          <h3 style={{ fontFamily: 'var(--font-display)', fontSize: 22, margin: '0 0 4px' }}>Sensory panels</h3>
          <p style={{ color: 'var(--text-muted)', fontSize: 13.5, margin: 0 }}>{isLead ? 'Build a panel by picking which batches need tasting.' : 'Work through your assigned panel one batch at a time.'}</p>
        </div>
        {isLead && <Button onClick={() => setBuilding(v => !v)}><Plus size={15} /> Build panel</Button>}
      </div>

      {building && (
        <Card style={{ marginBottom: 20 }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }}>
            <Field label="Date"><input type="date" style={inputStyle} value={date} onChange={e => setDate(e.target.value)} /></Field>
            <Field label="Label (optional)"><input style={inputStyle} value={label} onChange={e => setLabel(e.target.value)} placeholder="e.g. Tuesday panel" /></Field>
          </div>
          <p style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: 8 }}>Select batches ({selected.length} chosen)</p>
          {store.batches.length === 0 && <p style={{ color: 'var(--text-muted)', fontSize: 13.5 }}>No batches yet — add some on the Batches tab first.</p>}
          <div style={{ maxHeight: 280, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 14 }}>
            {store.batches.map(b => {
              const sku = store.skus.find(s => s.id === b.sku_id);
              return (
                <label key={b.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px', borderRadius: 6, cursor: 'pointer', background: selected.includes(b.id) ? 'var(--surface-2)' : 'transparent' }}>
                  <input type="checkbox" checked={selected.includes(b.id)} onChange={() => toggleSelect(b.id)} />
                  <span style={{ fontSize: 13.5 }}><strong>{b.batch_number}</strong> — {sku ? sku.name : 'Unknown SKU'}</span>
                  {b.package_date && <span style={{ marginLeft: 'auto', fontSize: 11.5, color: 'var(--text-faint)', fontFamily: 'var(--font-mono)' }}>packaged {b.package_date}</span>}
                </label>
              );
            })}
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <Button onClick={create} disabled={selected.length === 0 || busy}>{busy ? 'Creating…' : `Create panel with ${selected.length} batch${selected.length !== 1 ? 'es' : ''}`}</Button>
            <Button variant="ghost" onClick={() => setBuilding(false)}>Cancel</Button>
          </div>
        </Card>
      )}

      {sortedPanels.length === 0 && !building && <p style={{ color: 'var(--text-muted)' }}>No panels yet.{isLead ? ' Build one to get started.' : ' Check back once your QA lead sets one up.'}</p>}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        {sortedPanels.map(panel => {
          const progress = panelProgress(panel);
          return (
            <Card key={panel.id}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 12 }}>
                <div>
                  <p style={{ margin: 0, fontWeight: 700, fontSize: 15, fontFamily: 'var(--font-display)' }}>{panel.label}</p>
                  <p style={{ margin: '2px 0 0', fontSize: 12.5, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>{panel.date} · {progress.total} batches</p>
                </div>
                <Pill tone={progress.doneByMe === progress.total ? 'good' : 'warn'}>{progress.doneByMe}/{progress.total} done by you</Pill>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {progress.batchIds.map(bid => {
                  const batch = store.batches.find(b => b.id === bid);
                  const sku = batch ? store.skus.find(s => s.id === batch.sku_id) : null;
                  const myTasting = store.sessions.find(s => s.batch_id === bid && s.taster_id === currentProfile.id);
                  const totalTastings = store.sessions.filter(s => s.batch_id === bid).length;
                  return (
                    <div key={bid} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 12px', background: 'var(--surface-2)', borderRadius: 6 }}>
                      <span style={{ fontSize: 13.5 }}>{batch ? batch.batch_number : '—'} — {sku ? sku.name : ''}</span>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <span style={{ fontSize: 11.5, color: 'var(--text-faint)' }}>{totalTastings} tasting{totalTastings !== 1 ? 's' : ''} logged</span>
                        {myTasting ? <Pill tone="good">You've tasted this</Pill> : (
                          <Button variant="ghost" onClick={() => onLogTasting(bid)} style={{ fontSize: 12, padding: '6px 10px' }}>Taste now <ChevronRight size={13} /></Button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </Card>
          );
        })}
      </div>
    </div>
  );
}

// ============================================================
// Retention queue
// ============================================================
function RetentionQueue({ store, onLogTasting }) {
  const rows = useMemo(() => {
    return store.retention.map(r => {
      const batch = store.batches.find(b => b.id === r.batch_id);
      const sku = batch ? store.skus.find(s => s.id === batch.sku_id) : null;
      return { ...r, batch, sku };
    }).filter(r => r.batch).sort((a, b) => a.due_date.localeCompare(b.due_date));
  }, [store.retention, store.batches, store.skus]);

  const today = todayISO();
  const overdue = rows.filter(r => !r.assessed && r.due_date < today);
  const dueSoon = rows.filter(r => !r.assessed && r.due_date >= today && daysBetween(today, r.due_date) <= 7);
  const upcoming = rows.filter(r => !r.assessed && daysBetween(today, r.due_date) > 7);
  const done = rows.filter(r => r.assessed);

  const Group = ({ title, items }) => items.length > 0 && (
    <div style={{ marginBottom: 22 }}>
      <p style={{ fontSize: 12, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.5, color: 'var(--text-muted)', marginBottom: 10 }}>{title} · {items.length}</p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {items.map(r => (
          <div key={r.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: 8, padding: '12px 16px' }}>
            <div>
              <p style={{ margin: 0, fontWeight: 600, fontSize: 14 }}>{r.batch.batch_number} <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}>· {r.sku ? r.sku.name : ''}</span></p>
              <p style={{ margin: '2px 0 0', fontSize: 12.5, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>Day {r.days} checkpoint · due {r.due_date}</p>
            </div>
            {r.assessed ? <Pill tone="good">Assessed</Pill> : <Button variant="ghost" onClick={() => onLogTasting(r.batch.id)} style={{ fontSize: 12.5, padding: '7px 12px' }}>Log tasting <ChevronRight size={14} /></Button>}
          </div>
        ))}
      </div>
    </div>
  );

  return (
    <div>
      <h3 style={{ fontFamily: 'var(--font-display)', fontSize: 22, margin: '0 0 4px' }}>Retention library queue</h3>
      <p style={{ color: 'var(--text-muted)', fontSize: 13.5, margin: '0 0 24px' }}>Every packaged batch gets checkpoints at {RETENTION_INTERVALS.join(' / ')} days.</p>
      {rows.length === 0 && <p style={{ color: 'var(--text-muted)' }}>No batches in retention yet.</p>}
      <Group title="Overdue" items={overdue} />
      <Group title="Due within 7 days" items={dueSoon} />
      <Group title="Upcoming" items={upcoming} />
      <Group title="Completed" items={done} />
    </div>
  );
}

// ============================================================
// Batches
// ============================================================
function ImportBatchesModal({ store, onClose }) {
  const [rawText, setRawText] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);

  const doImport = async () => {
    const parsed = Papa.parse(rawText.trim(), { header: true, skipEmptyLines: true });
    if (parsed.errors.length && parsed.data.length === 0) {
      setError('Could not parse that. Make sure you copied the header row along with the data.');
      return;
    }
    const rows = parsed.data
      .map(r => ({
        batchNumber: (r['Batch Number'] || '').trim(),
        skuName: (r['SKU Name'] || '').trim(),
        dateBrewed: (r['Date Brewed'] || '').trim(),
        packagedDate: (r['Packaged Date'] || r['Package Date'] || '').trim(),
      }))
      .filter(r => r.batchNumber && /^\d+$/.test(r.batchNumber) && r.skuName && CORE_BEERS.includes(r.skuName) && r.packagedDate);
    setBusy(true); setError('');
    try {
      const summary = await store.importBatches(rows);
      setResult(summary);
    } catch (e) {
      setError(e.message || 'Could not import.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 50, padding: 20 }}>
      <div style={{ background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: 12, padding: 24, width: 560 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
          <h3 style={{ margin: 0, fontFamily: 'var(--font-display)', fontSize: 18 }}>Import batches from a sheet</h3>
          <X size={18} style={{ cursor: 'pointer', color: 'var(--text-muted)' }} onClick={onClose} />
        </div>

        {result ? (
          <div style={{ padding: '12px 0' }}>
            <p style={{ fontSize: 14, marginBottom: 6 }}>Import complete.</p>
            <ul style={{ fontSize: 13.5, color: 'var(--text-muted)', lineHeight: 1.8 }}>
              <li><strong style={{ color: 'var(--text)' }}>{result.added}</strong> batches added (new SKUs auto-created where needed — check their TTT profiles)</li>
              {result.skipped > 0 && <li><strong style={{ color: 'var(--text)' }}>{result.skipped}</strong> skipped — batch number already exists</li>}
            </ul>
            <Button onClick={onClose} style={{ marginTop: 8 }}>Done</Button>
          </div>
        ) : (
          <>
            <p style={{ color: 'var(--text-muted)', fontSize: 13, margin: '0 0 14px' }}>Paste your Batch Log rows (including the header row): Batch Number, SKU Name, Date Brewed, Packaged Date.</p>
            <textarea style={{ ...inputStyle, minHeight: 160, fontFamily: 'var(--font-mono)', fontSize: 12 }}
              placeholder={'Batch Number\tSKU Name\tDate Brewed\tPackaged Date\n363\tKolsch\t2026-06-16\t2026-07-06'}
              value={rawText} onChange={e => setRawText(e.target.value)} />
            {error && <p style={{ color: 'var(--bad)', fontSize: 12.5, marginTop: 8 }}>{error}</p>}
            <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
              <Button onClick={doImport} disabled={!rawText.trim() || busy}>{busy ? 'Importing…' : 'Import'}</Button>
              <Button variant="ghost" onClick={onClose}>Cancel</Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function BatchesView({ store, isLead }) {
  const [showNew, setShowNew] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [form, setForm] = useState({ skuId: '', batchNumber: '', packageDate: todayISO(), format: 'Can' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => { if (!form.skuId && store.skus[0]) setForm(f => ({ ...f, skuId: store.skus[0].id })); }, [store.skus]);

  const add = async () => {
    if (!form.skuId || !form.batchNumber) return;
    setBusy(true); setError('');
    try {
      await store.addBatch(form);
      setForm({ skuId: store.skus[0]?.id || '', batchNumber: '', packageDate: todayISO(), format: 'Can' });
      setShowNew(false);
    } catch (e) {
      setError(e.message || 'Could not add batch.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
        <div>
          <h3 style={{ fontFamily: 'var(--font-display)', fontSize: 22, margin: '0 0 4px' }}>Batches</h3>
          <p style={{ color: 'var(--text-muted)', fontSize: 13.5, margin: 0 }}>Packaged batches and their tasting history.</p>
        </div>
        {isLead && (
          <div style={{ display: 'flex', gap: 8 }}>
            <Button variant="ghost" onClick={() => setShowImport(true)}><Upload size={15} /> Import from sheet</Button>
            <Button onClick={() => setShowNew(v => !v)}><Plus size={15} /> New batch</Button>
          </div>
        )}
      </div>

      {showImport && <ImportBatchesModal store={store} onClose={() => setShowImport(false)} />}

      {showNew && (
        <Card style={{ marginBottom: 20 }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr auto', gap: 12, alignItems: 'end' }}>
            <Field label="SKU"><select style={inputStyle} value={form.skuId} onChange={e => setForm(f => ({ ...f, skuId: e.target.value }))}>
              {store.skus.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select></Field>
            <Field label="Batch #"><input style={inputStyle} value={form.batchNumber} onChange={e => setForm(f => ({ ...f, batchNumber: e.target.value }))} /></Field>
            <Field label="Package date"><input type="date" style={inputStyle} value={form.packageDate} onChange={e => setForm(f => ({ ...f, packageDate: e.target.value }))} /></Field>
            <Field label="Format"><select style={inputStyle} value={form.format} onChange={e => setForm(f => ({ ...f, format: e.target.value }))}>
              <option>Can</option><option>Bottle</option><option>Keg</option>
            </select></Field>
            <Button onClick={add} disabled={busy} style={{ marginBottom: 14 }}>{busy ? 'Adding…' : 'Add'}</Button>
          </div>
          {error && <p style={{ color: 'var(--bad)', fontSize: 12.5 }}>{error}</p>}
        </Card>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {store.batches.map(b => {
          const sku = store.skus.find(s => s.id === b.sku_id);
          const sessions = store.sessions.filter(s => s.batch_id === b.id);
          const flagged = sessions.filter(s => s.overall !== 'pass').length;
          const checkpoints = store.retention.filter(r => r.batch_id === b.id);
          return (
            <Card key={b.id}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                <div>
                  <p style={{ margin: 0, fontWeight: 700, fontSize: 15 }}>{b.batch_number}</p>
                  <p style={{ margin: '2px 0 0', color: 'var(--text-muted)', fontSize: 13 }}>{sku ? sku.name : 'Unknown SKU'} · {b.format} · packaged {b.package_date || '—'}</p>
                </div>
                <div style={{ display: 'flex', gap: 6 }}>
                  <Pill>{sessions.length} tasting{sessions.length !== 1 ? 's' : ''}</Pill>
                  {flagged > 0 && <Pill tone="bad">{flagged} flagged</Pill>}
                </div>
              </div>
              <div style={{ display: 'flex', gap: 6, marginTop: 10 }}>
                {checkpoints.map(r => (
                  <span key={r.id} title={`Day ${r.days} — ${r.due_date}`} style={{ fontSize: 11, fontFamily: 'var(--font-mono)', padding: '3px 8px', borderRadius: 4, background: r.assessed ? 'rgba(122,157,122,0.16)' : 'var(--surface-2)', color: r.assessed ? 'var(--good)' : 'var(--text-faint)' }}>D{r.days} {r.assessed ? '✓' : ''}</span>
                ))}
              </div>
            </Card>
          );
        })}
      </div>
    </div>
  );
}

// ============================================================
// SKU / TTT profiles
// ============================================================
function SkuEditor({ sku, onCancel, onSave, busy }) {
  const [s, setS] = useState({ ...sku, target: normalizeTarget(sku.target) });
  const [activeSection, setActiveSection] = useState('aroma');
  const setTraitTarget = (section, id, v) => setS(x => ({ ...x, target: { ...x.target, [section]: { ...x.target[section], [id]: v } } }));

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1.15fr 0.85fr', gap: 24 }}>
      <Card>
        <h3 style={{ margin: '0 0 16px', fontFamily: 'var(--font-display)', fontSize: 18 }}>{sku.name ? `Edit ${sku.name}` : 'New SKU'}</h3>
        <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 12 }}>
          <Field label="Name"><input style={inputStyle} value={s.name} onChange={e => setS(x => ({ ...x, name: e.target.value }))} /></Field>
          <Field label="ABV %"><input type="number" step="0.1" style={inputStyle} value={s.abv} onChange={e => setS(x => ({ ...x, abv: Number(e.target.value) }))} /></Field>
        </div>
        <Field label="Style"><input style={inputStyle} value={s.style} onChange={e => setS(x => ({ ...x, style: e.target.value }))} /></Field>
        <Field label="Reference notes"><textarea style={{ ...inputStyle, minHeight: 70, fontFamily: 'var(--font-body)' }} value={s.notes} onChange={e => setS(x => ({ ...x, notes: e.target.value }))} /></Field>
        <Field label="Key descriptors"><TagInput values={s.descriptors} onChange={v => setS(x => ({ ...x, descriptors: v }))} placeholder="e.g. caramel, add & press enter" /></Field>
        <Field label="Off-flavor watch-outs"><TagInput values={s.watchouts} onChange={v => setS(x => ({ ...x, watchouts: v }))} placeholder="e.g. diacetyl, add & press enter" /></Field>
        <Field label={`Tolerance band (± ${s.tolerance} — how far a tasting can be from target before it's flagged)`}>
          <input type="range" min={0} max={8} step={2} value={s.tolerance} onChange={e => setS(x => ({ ...x, tolerance: Number(e.target.value) }))} style={{ width: '100%' }} />
        </Field>
        <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
          <Button onClick={() => onSave(s)} disabled={!s.name || busy}>{busy ? 'Saving…' : <><Check size={15} /> Save profile</>}</Button>
          <Button variant="ghost" onClick={onCancel}>Cancel</Button>
        </div>
      </Card>
      <Card>
        <p style={{ margin: '0 0 12px', fontSize: 12, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase' }}>Target profile</p>
        <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
          {Object.keys(SECTION_LABELS).map(sec => (
            <button key={sec} type="button" onClick={() => setActiveSection(sec)} style={{
              flex: 1, padding: '8px 0', borderRadius: 7, fontWeight: 700, fontSize: 12.5, cursor: 'pointer',
              border: `1px solid ${activeSection === sec ? 'var(--accent)' : 'var(--line)'}`,
              background: activeSection === sec ? 'rgba(199,143,60,0.16)' : 'transparent',
              color: activeSection === sec ? 'var(--accent)' : 'var(--text-muted)',
            }}>{SECTION_LABELS[sec]}</button>
          ))}
        </div>
        <TraitSectionEditor section={activeSection} scores={s.target[activeSection]} onChange={(id, v) => setTraitTarget(activeSection, id, v)} target={null} tolerance={0} />
        <TraitSpiderChart section={activeSection} target={s.target[activeSection]} actual={null} height={220} />
      </Card>
    </div>
  );
}

function SkuProfiles({ store, isLead }) {
  const [editing, setEditing] = useState(null);
  const [busy, setBusy] = useState(false);
  const [previewSection, setPreviewSection] = useState('aroma');

  const save = async (sku) => {
    setBusy(true);
    try {
      if (sku.id) await store.updateSku(sku); else await store.addSku(sku);
      setEditing(null);
    } finally {
      setBusy(false);
    }
  };

  if (editing) return <SkuEditor sku={editing} onCancel={() => setEditing(null)} onSave={save} busy={busy} />;

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
        <div>
          <h3 style={{ fontFamily: 'var(--font-display)', fontSize: 22, margin: '0 0 4px' }}>True-to-type profiles</h3>
          <p style={{ color: 'var(--text-muted)', fontSize: 13.5, margin: 0 }}>What "correct" looks like for each SKU.</p>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <div style={{ display: 'flex', gap: 4 }}>
            {Object.keys(SECTION_LABELS).map(sec => (
              <button key={sec} type="button" onClick={() => setPreviewSection(sec)} style={{
                padding: '6px 10px', borderRadius: 6, fontSize: 11.5, fontWeight: 600, cursor: 'pointer',
                border: `1px solid ${previewSection === sec ? 'var(--accent)' : 'var(--line)'}`,
                background: previewSection === sec ? 'rgba(199,143,60,0.16)' : 'transparent',
                color: previewSection === sec ? 'var(--accent)' : 'var(--text-muted)',
              }}>{SECTION_LABELS[sec]}</button>
            ))}
          </div>
        </div>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: 16 }}>
        {store.skus.map(sku => {
          const target = normalizeTarget(sku.target);
          return (
            <Card key={sku.id}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                <div>
                  <p style={{ margin: 0, fontWeight: 700, fontSize: 15, fontFamily: 'var(--font-display)' }}>{sku.name}</p>
                  <p style={{ margin: '2px 0 10px', color: 'var(--text-muted)', fontSize: 12.5 }}>{sku.style} · {sku.abv}% ABV</p>
                </div>
                {isLead && <Button variant="ghost" onClick={() => setEditing(sku)} style={{ padding: '5px 10px', fontSize: 12 }}>Edit</Button>}
              </div>
              <TraitSpiderChart section={previewSection} target={target[previewSection]} actual={null} height={190} />
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, marginTop: 8 }}>{sku.descriptors.map(d => <Pill key={d}>{d}</Pill>)}</div>
            </Card>
          );
        })}
      </div>
    </div>
  );
}

// ============================================================
// Dashboard
// ============================================================
function exportSessionsCSV(store) {
  const traitLabelsAroma = traitLabelsFor('aroma');
  const traitLabelsFlavor = traitLabelsFor('flavor');
  const aromaIds = TRAIT_TAXONOMY.aroma.flatMap(g => g.traits.map(t => traitId(g.category, t)));
  const flavorIds = TRAIT_TAXONOMY.flavor.flatMap(g => g.traits.map(t => traitId(g.category, t)));

  const rows = store.sessions
    .slice()
    .sort((a, b) => a.date.localeCompare(b.date))
    .map(s => {
      const batch = store.batches.find(b => b.id === s.batch_id);
      const sku = batch ? store.skus.find(x => x.id === batch.sku_id) : null;
      const row = {
        Date: s.date,
        Taster: store.profileName(s.taster_id),
        'Batch Number': batch ? batch.batch_number : '',
        SKU: sku ? sku.name : '',
        Overall: s.overall,
        'Off-Flavors': (s.off_flavors || []).map(f => `${f.flavor} (${f.intensity}/5)`).join('; '),
        Notes: s.notes || '',
      };
      aromaIds.forEach(id => { row[`Aroma: ${traitLabelsAroma[id]}`] = s.scores?.aroma?.[id] ?? ''; });
      flavorIds.forEach(id => { row[`Flavour & Body: ${traitLabelsFlavor[id]}`] = s.scores?.flavor?.[id] ?? ''; });
      return row;
    });

  const csv = Papa.unparse(rows);
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `tastings-export-${todayISO()}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

function OffFlavorReport({ store }) {
  const stats = useMemo(() => {
    const byFlavor = {};
    OFF_FLAVORS.forEach(f => { byFlavor[f] = { count: 0, intensitySum: 0, skuCounts: {} }; });

    store.sessions.forEach(s => {
      const batch = store.batches.find(b => b.id === s.batch_id);
      const sku = batch ? store.skus.find(x => x.id === batch.sku_id) : null;
      (s.off_flavors || []).forEach(({ flavor, intensity }) => {
        if (!byFlavor[flavor]) return;
        byFlavor[flavor].count += 1;
        byFlavor[flavor].intensitySum += intensity;
        if (sku) byFlavor[flavor].skuCounts[sku.name] = (byFlavor[flavor].skuCounts[sku.name] || 0) + 1;
      });
    });

    return Object.entries(byFlavor)
      .map(([flavor, d]) => ({
        flavor,
        count: d.count,
        avgIntensity: d.count > 0 ? (d.intensitySum / d.count) : 0,
        topSku: Object.entries(d.skuCounts).sort((a, b) => b[1] - a[1])[0],
      }))
      .filter(x => x.count > 0)
      .sort((a, b) => b.count - a.count);
  }, [store.sessions, store.batches, store.skus]);

  const maxCount = Math.max(1, ...stats.map(s => s.count));

  return (
    <Card style={{ marginTop: 20 }}>
      <p style={{ margin: '0 0 4px', fontSize: 13, fontWeight: 700, textTransform: 'uppercase', color: 'var(--text-muted)' }}>Off-flavor incidence</p>
      <p style={{ margin: '0 0 16px', fontSize: 12.5, color: 'var(--text-faint)' }}>Across every tasting logged. A recurring pattern here usually points at process, not a single bad batch.</p>
      {stats.length === 0 ? (
        <p style={{ color: 'var(--text-muted)', fontSize: 13.5 }}>No off-flavors logged yet — clean panel so far.</p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {stats.map(s => (
            <div key={s.flavor}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                <span style={{ fontSize: 13, fontWeight: 600 }}>{s.flavor}</span>
                <span style={{ fontSize: 12, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
                  {s.count}× · avg {s.avgIntensity.toFixed(1)}/5{s.topSku ? ` · mostly ${s.topSku[0]}` : ''}
                </span>
              </div>
              <div style={{ height: 6, background: 'var(--surface-2)', borderRadius: 3, overflow: 'hidden' }}>
                <div style={{ width: `${(s.count / maxCount) * 100}%`, height: '100%', background: s.avgIntensity >= 3.5 ? 'var(--bad)' : 'var(--accent)' }} />
              </div>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

function Dashboard({ store }) {
  const today = todayISO();
  const overdue = store.retention.filter(r => !r.assessed && r.due_date < today);
  const recent = [...store.sessions].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 8);
  const flaggedRecent = store.sessions.filter(s => s.overall !== 'pass').slice(-5).reverse();

  const stat = (label, value, tone) => (
    <Card style={{ flex: 1 }}>
      <p style={{ margin: '0 0 6px', fontSize: 12, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.4 }}>{label}</p>
      <p style={{ margin: 0, fontSize: 30, fontFamily: 'var(--font-display)', color: tone || 'var(--text)' }}>{value}</p>
    </Card>
  );

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
        <h3 style={{ fontFamily: 'var(--font-display)', fontSize: 22, margin: 0 }}>Dashboard</h3>
        <Button variant="ghost" onClick={() => exportSessionsCSV(store)} disabled={store.sessions.length === 0}>
          <Upload size={15} style={{ transform: 'rotate(180deg)' }} /> Export all tastings (CSV)
        </Button>
      </div>
      <div style={{ display: 'flex', gap: 16, marginBottom: 24 }}>
        {stat('SKUs tracked', store.skus.length)}
        {stat('Active batches', store.batches.length)}
        {stat('Overdue retention', overdue.length, overdue.length > 0 ? 'var(--bad)' : 'var(--good)')}
        {stat('Total tastings logged', store.sessions.length)}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20 }}>
        <Card>
          <p style={{ margin: '0 0 14px', fontSize: 13, fontWeight: 700, textTransform: 'uppercase', color: 'var(--text-muted)' }}>Recent submissions</p>
          {recent.length === 0 && <p style={{ color: 'var(--text-muted)', fontSize: 13.5 }}>Nothing logged yet.</p>}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {recent.map(s => {
              const b = store.batches.find(x => x.id === s.batch_id);
              return (
                <div key={s.id} style={{ display: 'flex', justifyContent: 'space-between', borderBottom: '1px solid var(--line)', paddingBottom: 8 }}>
                  <div>
                    <p style={{ margin: 0, fontSize: 13.5, fontWeight: 600 }}>{b ? b.batch_number : '—'}</p>
                    <p style={{ margin: '2px 0 0', fontSize: 12, color: 'var(--text-muted)' }}>{store.profileName(s.taster_id)} · {s.date}</p>
                  </div>
                  <Pill tone={s.overall === 'pass' ? 'good' : s.overall === 'flag' ? 'warn' : 'bad'}>{s.overall}</Pill>
                </div>
              );
            })}
          </div>
        </Card>
        <Card>
          <p style={{ margin: '0 0 14px', fontSize: 13, fontWeight: 700, textTransform: 'uppercase', color: 'var(--text-muted)' }}>Flagged / failed tastings</p>
          {flaggedRecent.length === 0 && <p style={{ color: 'var(--text-muted)', fontSize: 13.5 }}>No flags — panel's tracking clean.</p>}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {flaggedRecent.map(s => {
              const b = store.batches.find(x => x.id === s.batch_id);
              return (
                <div key={s.id} style={{ borderBottom: '1px solid var(--line)', paddingBottom: 8 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <p style={{ margin: 0, fontSize: 13.5, fontWeight: 600 }}>{b ? b.batch_number : '—'}</p>
                    <Pill tone="bad">{s.overall}</Pill>
                  </div>
                  {s.off_flavors.length > 0 && <p style={{ margin: '4px 0 0', fontSize: 12, color: 'var(--bad)' }}>{s.off_flavors.map(f => `${f.flavor} (${f.intensity}/5)`).join(', ')}</p>}
                  {s.notes && <p style={{ margin: '4px 0 0', fontSize: 12, color: 'var(--text-muted)' }}>"{s.notes.slice(0, 90)}{s.notes.length > 90 ? '…' : ''}"</p>}
                </div>
              );
            })}
          </div>
        </Card>
      </div>
      <OffFlavorReport store={store} />
    </div>
  );
}

// ============================================================
// Root app
// ============================================================
export default function App() {
  const [session, setSession] = useState(undefined);
  const [profile, setProfile] = useState(null);
  const [tab, setTab] = useState('panels');
  const [presetBatchId, setPresetBatchId] = useState(null);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data: listener } = supabase.auth.onAuthStateChange((_event, s) => setSession(s));
    return () => listener.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (!session) { setProfile(null); return; }
    supabase.from('profiles').select('*').eq('id', session.user.id).single().then(({ data }) => setProfile(data));
  }, [session]);

  const store = useSupabaseData(session);
  const isLead = profile?.role === 'lead';

  const tabs = [
    { id: 'panels', label: 'Panels', icon: Users, allowed: true },
    { id: 'submit', label: 'Submit tasting', icon: ClipboardList, allowed: true },
    { id: 'retention', label: 'Retention queue', icon: Archive, allowed: true },
    { id: 'batches', label: 'Batches', icon: Beaker, allowed: true },
    { id: 'skus', label: 'TTT profiles', icon: Settings, allowed: true },
    { id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard, allowed: isLead },
  ].filter(t => t.allowed);

  useEffect(() => { if (!tabs.find(t => t.id === tab)) setTab('panels'); }, [isLead]);

  const themeVars = {
    '--bg': '#17140F', '--surface': '#1F1B15', '--surface-2': '#28221A', '--line': '#3A3226',
    '--text': '#EDE6D6', '--text-muted': '#A79E8D', '--text-faint': '#6B6355',
    '--accent': '#C78F3C', '--good': '#7A9D7A', '--bad': '#C45A44',
    '--font-display': "'Fraunces', serif", '--font-body': "'Inter', sans-serif", '--font-mono': "'IBM Plex Mono', monospace",
  };

  if (session === undefined) {
    return <div style={{ ...themeVars, background: 'var(--bg)', minHeight: '100vh' }} />;
  }
  if (!session) {
    return <div style={themeVars}><AuthScreen /></div>;
  }
  if (!profile || store.loading) {
    return (
      <div style={{ ...themeVars, background: 'var(--bg)', color: 'var(--text)', minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <p style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-muted)' }}>Loading…</p>
      </div>
    );
  }

  return (
    <div style={{ ...themeVars, background: 'var(--bg)', color: 'var(--text)', minHeight: '100vh', fontFamily: 'var(--font-body)' }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,500;9..144,700&family=Inter:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500&display=swap');
        * { box-sizing: border-box; }
        body { margin: 0; }
        input[type=range] { -webkit-appearance: none; background: transparent; height: 20px; }
        input[type=range]::-webkit-slider-runnable-track { height: 4px; background: var(--line); border-radius: 2px; }
        input[type=range]::-webkit-slider-thumb { -webkit-appearance: none; margin-top: -6px; width: 16px; height: 16px; border-radius: 50%; background: currentColor; cursor: pointer; border: 2px solid var(--surface); }
      `}</style>

      <header style={{ borderBottom: '1px solid var(--line)', padding: '18px 28px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{ width: 34, height: 34, borderRadius: 8, background: 'var(--accent)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Beaker size={18} color="#1a1410" />
          </div>
          <div>
            <p style={{ margin: 0, fontFamily: 'var(--font-display)', fontSize: 19, fontWeight: 700, lineHeight: 1 }}>Panel</p>
            <p style={{ margin: 0, fontSize: 11, color: 'var(--text-faint)', fontFamily: 'var(--font-mono)', letterSpacing: 0.5 }}>SENSORY LOG</p>
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <User size={15} color="var(--text-faint)" />
          <span style={{ fontSize: 13.5 }}>{profile.name}</span>
          <Pill tone={isLead ? 'good' : 'neutral'}>{isLead ? 'QA Lead' : 'Staff'}</Pill>
          <Button variant="ghost" onClick={() => supabase.auth.signOut()} style={{ padding: '6px 10px', fontSize: 12 }}><LogOut size={13} /> Sign out</Button>
        </div>
      </header>

      <div style={{ display: 'flex' }}>
        <nav style={{ width: 210, borderRight: '1px solid var(--line)', padding: '20px 12px', flexShrink: 0 }}>
          {tabs.map(t => (
            <button key={t.id} onClick={() => { setTab(t.id); setPresetBatchId(null); }} style={{
              width: '100%', display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', marginBottom: 4,
              borderRadius: 7, border: 'none', cursor: 'pointer', textAlign: 'left', fontSize: 13.5, fontWeight: 600,
              background: tab === t.id ? 'var(--surface-2)' : 'transparent',
              color: tab === t.id ? 'var(--accent)' : 'var(--text-muted)',
            }}><t.icon size={16} /> {t.label}</button>
          ))}
          {store.error && <p style={{ fontSize: 11, color: 'var(--bad)', marginTop: 16, padding: '0 12px' }}>{store.error}</p>}
        </nav>

        <main style={{ flex: 1, padding: '28px 32px', maxWidth: 1180 }}>
          {tab === 'panels' && <PanelsView store={store} isLead={isLead} currentProfile={profile} onLogTasting={(bid) => { setPresetBatchId(bid); setTab('submit'); }} />}
          {tab === 'submit' && <TastingForm store={store} currentProfile={profile} onDone={() => setTab('panels')} presetBatchId={presetBatchId} />}
          {tab === 'retention' && <RetentionQueue store={store} onLogTasting={(bid) => { setPresetBatchId(bid); setTab('submit'); }} />}
          {tab === 'batches' && <BatchesView store={store} isLead={isLead} />}
          {tab === 'skus' && <SkuProfiles store={store} isLead={isLead} />}
          {tab === 'dashboard' && isLead && <Dashboard store={store} />}
        </main>
      </div>
    </div>
  );
}
