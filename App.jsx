import React, { useState, useEffect, useMemo } from 'react';
import { Radar, RadarChart, PolarGrid, PolarAngleAxis, PolarRadiusAxis, ResponsiveContainer, Legend } from 'recharts';
import { Beaker, ClipboardList, Archive, Settings, LayoutDashboard, Plus, X, Check, User, Upload, FileSpreadsheet, Users, ChevronRight, LogOut } from 'lucide-react';
import Papa from 'papaparse';
import { supabase } from './supabaseClient';

const ATTRS = [
  { key: 'appearance', label: 'Appearance' },
  { key: 'aroma', label: 'Aroma' },
  { key: 'flavor', label: 'Flavor' },
  { key: 'mouthfeel', label: 'Mouthfeel' },
  { key: 'finish', label: 'Finish' },
];

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
  const [sheetBatches, setSheetBatches] = useState([]);
  const [profiles, setProfiles] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const loadAll = async () => {
    setLoading(true); setError(null);
    try {
      const [s, b, r, se, p, pb, sb, pr] = await Promise.all([
        supabase.from('skus').select('*'),
        supabase.from('batches').select('*'),
        supabase.from('retention_checkpoints').select('*'),
        supabase.from('sessions').select('*'),
        supabase.from('panels').select('*'),
        supabase.from('panel_batches').select('*'),
        supabase.from('sheet_batches').select('*'),
        supabase.from('profiles').select('*'),
      ]);
      if (s.error) throw s.error;
      setSkus(s.data || []);
      setBatches(b.data || []);
      setRetention(r.data || []);
      setSessions(se.data || []);
      setPanels(p.data || []);
      setPanelBatches(pb.data || []);
      setSheetBatches((sb.data || []).sort((a, b2) => Number(b2.batch_number) - Number(a.batch_number)));
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

  // Ensures a batch (and SKU) exists for a sheet row; returns batch id. Used by Panels.
  const ensureBatchFromSheetRow = async (row) => {
    const existing = batches.find(b => b.batch_number === row.batch_number);
    if (existing) return existing.id;

    let sku = skus.find(s => s.name.toLowerCase() === row.sku_name.toLowerCase());
    if (!sku) {
      const { data: newSku, error: skuErr } = await supabase.from('skus').insert({
        name: row.sku_name, style: '', abv: 0, descriptors: [], watchouts: [],
        target: { appearance: 3, aroma: 3, flavor: 3, mouthfeel: 3, finish: 3 }, tolerance: 1,
        notes: 'Auto-created from the Batch Log sheet — set a real target profile.',
      }).select().single();
      if (skuErr) throw skuErr;
      sku = newSku;
    }

    const packageDate = row.packaged_date || todayISO();
    const { data: newBatch, error: batchErr } = await supabase.from('batches').insert({
      sku_id: sku.id, batch_number: row.batch_number, package_date: packageDate, format: 'Can',
    }).select().single();
    if (batchErr) throw batchErr;

    const checkpoints = RETENTION_INTERVALS.map(days => ({
      batch_id: newBatch.id, days, due_date: addDays(packageDate, days), assessed: false,
    }));
    await supabase.from('retention_checkpoints').insert(checkpoints);
    return newBatch.id;
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

  const createPanel = async ({ date, label, batchNumbers }) => {
    const batchIds = [];
    for (const bn of batchNumbers) {
      const row = sheetBatches.find(r => r.batch_number === bn);
      if (!row) continue;
      const id = await ensureBatchFromSheetRow(row);
      batchIds.push(id);
    }
    const { data: panel, error } = await supabase.from('panels').insert({ date, label }).select().single();
    if (error) throw error;
    await supabase.from('panel_batches').insert(batchIds.map(bid => ({ panel_id: panel.id, batch_id: bid })));
    await loadAll();
  };

  const refreshSheetBatches = async (rows) => {
    await supabase.from('sheet_batches').delete().neq('batch_number', '__none__');
    if (rows.length > 0) {
      await supabase.from('sheet_batches').insert(rows.map(r => ({
        batch_number: r.batchNumber, sku_name: r.skuName, date_brewed: r.dateBrewed || null, packaged_date: r.packagedDate || null,
      })));
    }
    await loadAll();
  };

  return {
    skus, batches, retention, sessions, panels, panelBatches, sheetBatches, profiles, profileName,
    loading, error, reload: loadAll,
    addSku, updateSku, addBatch, addSession, createPanel, refreshSheetBatches,
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

function ScoreSlider({ value, onChange, target, tolerance }) {
  const inTolerance = target == null || Math.abs(value - target) <= tolerance;
  return (
    <div>
      <div style={{ position: 'relative', height: 28 }}>
        {target != null && (
          <div style={{ position: 'absolute', top: 8, height: 12, left: `${((target - tolerance - 1) / 4) * 100}%`, width: `${(tolerance * 2 / 4) * 100}%`, background: 'rgba(122,157,122,0.18)', borderRadius: 3 }} />
        )}
        <input type="range" min={1} max={5} step={1} value={value} onChange={e => onChange(Number(e.target.value))}
          style={{ width: '100%', position: 'relative', accentColor: inTolerance || target == null ? 'var(--good)' : 'var(--bad)' }} />
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: 'var(--text-faint)', fontFamily: 'var(--font-mono)' }}>
        <span>1</span><span>2</span><span>3</span><span>4</span><span>5</span>
      </div>
    </div>
  );
}

function FlavorRadar({ target, actual, height = 260 }) {
  const chartData = ATTRS.map(a => ({ attribute: a.label, Target: target ? target[a.key] : 0, Batch: actual ? actual[a.key] : 0 }));
  return (
    <ResponsiveContainer width="100%" height={height}>
      <RadarChart data={chartData} outerRadius="72%">
        <PolarGrid stroke="var(--line)" />
        <PolarAngleAxis dataKey="attribute" tick={{ fill: 'var(--text-muted)', fontSize: 11, fontFamily: 'var(--font-mono)' }} />
        <PolarRadiusAxis domain={[0, 5]} tick={false} axisLine={false} />
        {target && <Radar name="TTT Target" dataKey="Target" stroke="var(--text-faint)" strokeDasharray="4 3" fill="var(--text-faint)" fillOpacity={0.05} />}
        {actual && <Radar name="This Batch" dataKey="Batch" stroke="var(--accent)" fill="var(--accent)" fillOpacity={0.28} />}
        <Legend wrapperStyle={{ fontSize: 12, fontFamily: 'var(--font-body)' }} />
      </RadarChart>
    </ResponsiveContainer>
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
  const [scores, setScores] = useState({ appearance: 3, aroma: 3, flavor: 3, mouthfeel: 3, finish: 3 });
  const [overall, setOverall] = useState('pass');
  const [offFlavors, setOffFlavors] = useState([]);
  const [notes, setNotes] = useState('');
  const [retentionCheckpointId, setRetentionCheckpointId] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  const batch = store.batches.find(b => b.id === batchId);
  const sku = batch ? store.skus.find(s => s.id === batch.sku_id) : null;
  const dueCheckpoints = batch ? store.retention.filter(r => r.batch_id === batch.id && !r.assessed) : [];

  const toggleOff = (f) => setOffFlavors(prev => prev.includes(f) ? prev.filter(x => x !== f) : [...prev, f]);

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
    <div style={{ display: 'grid', gridTemplateColumns: '1.1fr 0.9fr', gap: 24 }}>
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

        {ATTRS.map(a => (
          <Field key={a.key} label={`${a.label} — ${scores[a.key]}/5`}>
            <ScoreSlider value={scores[a.key]} onChange={v => setScores(s => ({ ...s, [a.key]: v }))} target={sku ? sku.target[a.key] : null} tolerance={sku ? sku.tolerance : 1} />
          </Field>
        ))}

        <Field label="Off-flavors detected">
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {OFF_FLAVORS.map(f => (
              <button key={f} type="button" onClick={() => toggleOff(f)} style={{
                fontSize: 12, padding: '6px 10px', borderRadius: 20, cursor: 'pointer',
                border: `1px solid ${offFlavors.includes(f) ? 'var(--bad)' : 'var(--line)'}`,
                background: offFlavors.includes(f) ? 'rgba(196,90,68,0.16)' : 'transparent',
                color: offFlavors.includes(f) ? 'var(--bad)' : 'var(--text-muted)',
              }}>{f}</button>
            ))}
          </div>
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

      <div>
        <Card style={{ marginBottom: 16 }}>
          <h4 style={{ margin: '0 0 4px', fontFamily: 'var(--font-display)', fontSize: 16 }}>{sku ? sku.name : 'No SKU'}</h4>
          <p style={{ margin: '0 0 14px', fontSize: 12.5, color: 'var(--text-muted)' }}>{sku ? `${sku.style} · ${sku.abv}% ABV` : ''}</p>
          <FlavorRadar target={sku ? sku.target : null} actual={scores} height={230} />
        </Card>
        {sku && (
          <Card>
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
function RefreshSheetModal({ store, onClose }) {
  const [rawText, setRawText] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const doRefresh = async () => {
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
      .filter(r => r.batchNumber && /^\d+$/.test(r.batchNumber) && r.skuName);
    setBusy(true);
    try {
      await store.refreshSheetBatches(rows);
      onClose();
    } catch (e) {
      setError(e.message || 'Could not save.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 50, padding: 20 }}>
      <div style={{ background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: 12, padding: 24, width: 560 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
          <h3 style={{ margin: 0, fontFamily: 'var(--font-display)', fontSize: 18 }}>Refresh batch list</h3>
          <X size={18} style={{ cursor: 'pointer', color: 'var(--text-muted)' }} onClick={onClose} />
        </div>
        <p style={{ color: 'var(--text-muted)', fontSize: 13, margin: '0 0 14px' }}>Paste the current Batch Log rows (including header) from your sheet.</p>
        <textarea style={{ ...inputStyle, minHeight: 160, fontFamily: 'var(--font-mono)', fontSize: 12 }}
          placeholder={'Batch Number\tSKU Name\tDate Brewed\tPackaged Date\n363\tKolsch\t2026-06-16\t2026-07-06'}
          value={rawText} onChange={e => setRawText(e.target.value)} />
        {error && <p style={{ color: 'var(--bad)', fontSize: 12.5, marginTop: 8 }}>{error}</p>}
        <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
          <Button onClick={doRefresh} disabled={!rawText.trim() || busy}>{busy ? 'Saving…' : 'Update list'}</Button>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
        </div>
      </div>
    </div>
  );
}

function PanelsView({ store, isLead, currentProfile, onLogTasting }) {
  const [building, setBuilding] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [label, setLabel] = useState('');
  const [date, setDate] = useState(todayISO());
  const [selected, setSelected] = useState([]);
  const [busy, setBusy] = useState(false);

  const toggleSelect = (bn) => setSelected(prev => prev.includes(bn) ? prev.filter(b => b !== bn) : [...prev, bn]);

  const create = async () => {
    if (selected.length === 0) return;
    setBusy(true);
    try {
      await store.createPanel({ date, label: label || `Panel — ${date}`, batchNumbers: selected });
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
        {isLead && (
          <div style={{ display: 'flex', gap: 8 }}>
            <Button variant="ghost" onClick={() => setRefreshing(true)}><Upload size={15} /> Refresh batch list</Button>
            <Button onClick={() => setBuilding(v => !v)}><Plus size={15} /> Build panel</Button>
          </div>
        )}
      </div>

      {refreshing && <RefreshSheetModal store={store} onClose={() => setRefreshing(false)} />}
      {isLead && <p style={{ fontSize: 12, color: 'var(--text-faint)', margin: '-12px 0 20px' }}>{store.sheetBatches.length} batches available in the list</p>}

      {building && (
        <Card style={{ marginBottom: 20 }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }}>
            <Field label="Date"><input type="date" style={inputStyle} value={date} onChange={e => setDate(e.target.value)} /></Field>
            <Field label="Label (optional)"><input style={inputStyle} value={label} onChange={e => setLabel(e.target.value)} placeholder="e.g. Tuesday panel" /></Field>
          </div>
          <p style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: 8 }}>Select batches ({selected.length} chosen)</p>
          {store.sheetBatches.length === 0 && <p style={{ color: 'var(--text-muted)', fontSize: 13.5 }}>No batches loaded yet — click "Refresh batch list" above first.</p>}
          <div style={{ maxHeight: 280, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 14 }}>
            {store.sheetBatches.map(row => (
              <label key={row.batch_number} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px', borderRadius: 6, cursor: 'pointer', background: selected.includes(row.batch_number) ? 'var(--surface-2)' : 'transparent' }}>
                <input type="checkbox" checked={selected.includes(row.batch_number)} onChange={() => toggleSelect(row.batch_number)} />
                <span style={{ fontSize: 13.5 }}><strong>{row.batch_number}</strong> — {row.sku_name}</span>
                {row.packaged_date && <span style={{ marginLeft: 'auto', fontSize: 11.5, color: 'var(--text-faint)', fontFamily: 'var(--font-mono)' }}>packaged {row.packaged_date}</span>}
              </label>
            ))}
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
function BatchesView({ store, isLead }) {
  const [showNew, setShowNew] = useState(false);
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
        {isLead && <Button onClick={() => setShowNew(v => !v)}><Plus size={15} /> New batch</Button>}
      </div>

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
  const [s, setS] = useState(sku);
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1.1fr 0.9fr', gap: 24 }}>
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
        <Field label={`Tolerance band (± ${s.tolerance})`}>
          <input type="range" min={0} max={2} step={0.5} value={s.tolerance} onChange={e => setS(x => ({ ...x, tolerance: Number(e.target.value) }))} style={{ width: '100%' }} />
        </Field>
        <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
          <Button onClick={() => onSave(s)} disabled={!s.name || busy}>{busy ? 'Saving…' : <><Check size={15} /> Save profile</>}</Button>
          <Button variant="ghost" onClick={onCancel}>Cancel</Button>
        </div>
      </Card>
      <Card>
        <p style={{ margin: '0 0 8px', fontSize: 12, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase' }}>Target profile</p>
        {ATTRS.map(a => (
          <Field key={a.key} label={`${a.label} — ${s.target[a.key]}/5`}>
            <ScoreSlider value={s.target[a.key]} onChange={v => setS(x => ({ ...x, target: { ...x.target, [a.key]: v } }))} target={null} tolerance={0} />
          </Field>
        ))}
        <FlavorRadar target={s.target} actual={null} height={200} />
      </Card>
    </div>
  );
}

function SkuProfiles({ store, isLead }) {
  const [editing, setEditing] = useState(null);
  const [busy, setBusy] = useState(false);

  const blank = () => ({ id: null, name: '', style: '', abv: 5.0, descriptors: [], watchouts: [], target: { appearance: 3, aroma: 3, flavor: 3, mouthfeel: 3, finish: 3 }, tolerance: 1, notes: '' });

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
        {isLead && <Button onClick={() => setEditing(blank())}><Plus size={15} /> New SKU</Button>}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: 16 }}>
        {store.skus.map(sku => (
          <Card key={sku.id}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
              <div>
                <p style={{ margin: 0, fontWeight: 700, fontSize: 15, fontFamily: 'var(--font-display)' }}>{sku.name}</p>
                <p style={{ margin: '2px 0 10px', color: 'var(--text-muted)', fontSize: 12.5 }}>{sku.style} · {sku.abv}% ABV</p>
              </div>
              {isLead && <Button variant="ghost" onClick={() => setEditing(sku)} style={{ padding: '5px 10px', fontSize: 12 }}>Edit</Button>}
            </div>
            <FlavorRadar target={sku.target} actual={null} height={190} />
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, marginTop: 8 }}>{sku.descriptors.map(d => <Pill key={d}>{d}</Pill>)}</div>
          </Card>
        ))}
      </div>
    </div>
  );
}

// ============================================================
// Dashboard
// ============================================================
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
      <h3 style={{ fontFamily: 'var(--font-display)', fontSize: 22, margin: '0 0 20px' }}>Dashboard</h3>
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
                  {s.off_flavors.length > 0 && <p style={{ margin: '4px 0 0', fontSize: 12, color: 'var(--bad)' }}>{s.off_flavors.join(', ')}</p>}
                  {s.notes && <p style={{ margin: '4px 0 0', fontSize: 12, color: 'var(--text-muted)' }}>"{s.notes.slice(0, 90)}{s.notes.length > 90 ? '…' : ''}"</p>}
                </div>
              );
            })}
          </div>
        </Card>
      </div>
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
