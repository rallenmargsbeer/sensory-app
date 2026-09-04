import React, { useState, useEffect, useMemo } from 'react';
import { Radar, RadarChart, PolarGrid, PolarAngleAxis, PolarRadiusAxis, ResponsiveContainer, Legend, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip } from 'recharts';
import { Beaker, ClipboardList, Archive, Settings, LayoutDashboard, Plus, X, Check, User, Upload, Users, ChevronRight, ChevronDown, LogOut, TrendingUp, Droplet, Calendar, UserCog, Search, FlaskConical, MapPin, LayoutGrid } from 'lucide-react';
import Papa from 'papaparse';
import { supabase } from './supabaseClient';

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
const CORE_BEERS = ['Drift', 'Pale', 'Kolsch', 'River Dog', 'In The Pines', 'Red IPA', 'Mermid', 'Stout', 'Brown', 'Draught'];

function defaultSectionScores(section) {
  const out = {};
  TRAIT_TAXONOMY[section].forEach(group => group.traits.forEach(t => { out[traitId(group.category, t)] = 1; }));
  return out;
}
function defaultAllScores() { return { aroma: defaultSectionScores('aroma'), flavor: defaultSectionScores('flavor') }; }
function normalizeTarget(target) {
  if (target && typeof target.aroma === 'object' && typeof target.flavor === 'object') return target;
  return defaultAllScores();
}
function getScore(scoresObj, section, id) { return (scoresObj && scoresObj[section] && scoresObj[section][id]) ?? 1; }

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
const QC_READ_DAYS = 5;
const CHECK_SESSION_COMPLETION_URL = 'https://qglmuisievxvntfgztfl.supabase.co/functions/v1/check-session-completion';

function todayISO() { return new Date().toISOString().slice(0, 10); }
function daysBetween(a, b) { return Math.round((new Date(b) - new Date(a)) / 86400000); }
function addDays(dateStr, n) { const d = new Date(dateStr); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); }

function useSupabaseData(session) {
  const [skus, setSkus] = useState([]);
  const [batches, setBatches] = useState([]);
  const [retention, setRetention] = useState([]);
  const [sessions, setSessions] = useState([]);
  const [panels, setPanels] = useState([]);
  const [panelBatches, setPanelBatches] = useState([]);
  const [briteChecks, setBriteChecks] = useState([]);
  const [sensorySessions, setSensorySessions] = useState([]);
  const [sensorySessionPanels, setSensorySessionPanels] = useState([]);
  const [sensorySessionParticipants, setSensorySessionParticipants] = useState([]);
  const [profiles, setProfiles] = useState([]);
  const [qcLocations, setQcLocations] = useState([]);
  const [qcSamples, setQcSamples] = useState([]);
  const [qcTests, setQcTests] = useState([]);
  const [loading, setLoading] = useState(true);
  const [initialLoadDone, setInitialLoadDone] = useState(false);
  const [error, setError] = useState(null);

  const loadAll = async () => {
    setLoading(true); setError(null);
    try {
      const [s, b, r, se, p, pb, bc, ss, ssp, sspt, pr, ql, qs, qt] = await Promise.all([
        supabase.from('skus').select('*'),
        supabase.from('batches').select('*'),
        supabase.from('retention_checkpoints').select('*'),
        supabase.from('sessions').select('*'),
        supabase.from('panels').select('*'),
        supabase.from('panel_batches').select('*'),
        supabase.from('brite_checks').select('*'),
        supabase.from('sensory_sessions').select('*'),
        supabase.from('sensory_session_panels').select('*'),
        supabase.from('sensory_session_participants').select('*'),
        supabase.from('profiles').select('*'),
        supabase.from('qc_locations').select('*'),
        supabase.from('qc_samples').select('*'),
        supabase.from('qc_tests').select('*'),
      ]);
      if (s.error) throw s.error;
      setSkus(s.data || []);
      setBatches((b.data || []).sort((a, b2) => Number(b2.batch_number) - Number(a.batch_number)));
      setRetention(r.data || []);
      setSessions(se.data || []);
      setPanels(p.data || []);
      setPanelBatches(pb.data || []);
      setBriteChecks(bc.data || []);
      setSensorySessions(ss.data || []);
      setSensorySessionPanels(ssp.data || []);
      setSensorySessionParticipants(sspt.data || []);
      setProfiles(pr.data || []);
      setQcLocations(ql.data || []);
      setQcSamples(qs.data || []);
      setQcTests(qt.data || []);
    } catch (e) {
      setError(e.message || 'Failed to load data.');
    } finally {
      setLoading(false);
      setInitialLoadDone(true);
    }
  };

  useEffect(() => { if (session) loadAll(); }, [session]);

  const profileName = (id) => (profiles.find(p => p.id === id) || {}).name || 'Unknown';

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

  const importBatches = async (rows) => {
    let added = 0, skipped = 0, graduated = 0;
    for (const row of rows) {
      const existing = batches.find(b => b.batch_number === row.batchNumber);
      if (existing) {
        if (!existing.package_date && row.packagedDate) {
          const { error: updateErr } = await supabase.from('batches').update({ package_date: row.packagedDate }).eq('id', existing.id);
          if (updateErr) throw updateErr;
          const checkpoints = RETENTION_INTERVALS.map(days => ({
            batch_id: existing.id, days, due_date: addDays(row.packagedDate, days), assessed: false,
          }));
          await supabase.from('retention_checkpoints').insert(checkpoints);
          graduated++;
        } else {
          skipped++;
        }
        continue;
      }

      let sku = skus.find(s => s.name.toLowerCase() === row.skuName.toLowerCase());
      if (!sku) {
        const { data: newSku, error: skuErr } = await supabase.from('skus').insert({
          name: row.skuName, style: '', abv: 0, descriptors: [], watchouts: [],
          target: defaultAllScores(), tolerance: 2,
          notes: 'Auto-created from a sheet import — set a real target profile.',
        }).select().single();
        if (skuErr) throw skuErr;
        sku = newSku;
        skus.push(sku);
      }

      const packageDate = row.packagedDate || null;
      const { data: newBatch, error: batchErr } = await supabase.from('batches').insert({
        sku_id: sku.id, batch_number: row.batchNumber, package_date: packageDate, format: 'Can',
      }).select().single();
      if (batchErr) throw batchErr;
      batches.push(newBatch);

      if (packageDate) {
        const checkpoints = RETENTION_INTERVALS.map(days => ({
          batch_id: newBatch.id, days, due_date: addDays(packageDate, days), assessed: false,
        }));
        await supabase.from('retention_checkpoints').insert(checkpoints);
      }
      added++;
    }
    await loadAll();
    return { added, skipped };
  };

  const triggerCompletionCheck = () => {
    fetch(CHECK_SESSION_COMPLETION_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${session.access_token}`, 'Content-Type': 'application/json' },
      body: '{}',
    }).catch(() => {});
  };

  const addSession = async (sess) => {
    const { error } = await supabase.from('sessions').insert({
      batch_id: sess.batchId, taster_id: session.user.id, date: sess.date, scores: sess.scores,
      overall: sess.overall, off_flavors: sess.offFlavors, notes: sess.notes,
      retention_checkpoint_id: sess.retentionCheckpointId || null,
      tasting_type: sess.tastingType || 'ttt',
    });
    if (error) throw error;
    if (sess.retentionCheckpointId) {
      await supabase.from('retention_checkpoints').update({ assessed: true }).eq('id', sess.retentionCheckpointId);
    }
    await loadAll();
    triggerCompletionCheck();
  };

  const updateSession = async (sessionId, sess) => {
    const { error } = await supabase.from('sessions').update({
      batch_id: sess.batchId, date: sess.date, scores: sess.scores,
      overall: sess.overall, off_flavors: sess.offFlavors, notes: sess.notes,
      retention_checkpoint_id: sess.retentionCheckpointId || null,
      tasting_type: sess.tastingType || 'ttt',
    }).eq('id', sessionId);
    if (error) throw error;
    if (sess.retentionCheckpointId) {
      await supabase.from('retention_checkpoints').update({ assessed: true }).eq('id', sess.retentionCheckpointId);
    }
    await loadAll();
    triggerCompletionCheck();
  };

  const deleteSession = async (sessionId) => {
    const { error } = await supabase.from('sessions').delete().eq('id', sessionId);
    if (error) throw error;
    await loadAll();
  };

  const createPanel = async ({ date, label, batchIds, panelType }) => {
    const { data: panel, error } = await supabase.from('panels').insert({ date, label, panel_type: panelType || 'ttt' }).select().single();
    if (error) throw error;
    await supabase.from('panel_batches').insert(batchIds.map(bid => ({ panel_id: panel.id, batch_id: bid })));
    await loadAll();
  };

  const deletePanel = async (panelId) => {
    const { error } = await supabase.from('panels').delete().eq('id', panelId);
    if (error) throw error;
    await loadAll();
  };

  const addBriteCheck = async ({ batchId, decision, notes }) => {
    const { error } = await supabase.from('brite_checks').insert({
      batch_id: batchId, taster_id: session.user.id, date: todayISO(), decision, notes: notes || '',
    });
    if (error) throw error;
    await loadAll();
  };

  const createSensorySession = async ({ date, label, panelIds, participantIds }) => {
    const { data: sess, error } = await supabase.from('sensory_sessions').insert({ date, label }).select().single();
    if (error) throw error;
    if (panelIds.length > 0) {
      await supabase.from('sensory_session_panels').insert(panelIds.map(pid => ({ sensory_session_id: sess.id, panel_id: pid })));
    }
    if (participantIds.length > 0) {
      await supabase.from('sensory_session_participants').insert(participantIds.map(uid => ({ sensory_session_id: sess.id, user_id: uid })));
    }
    await loadAll();
  };

  const deleteSensorySession = async (sensorySessionId) => {
    const { error } = await supabase.from('sensory_sessions').delete().eq('id', sensorySessionId);
    if (error) throw error;
    await loadAll();
  };

  const updateSessionParticipants = async (sensorySessionId, participantIds) => {
    const { error: delErr } = await supabase.from('sensory_session_participants').delete().eq('sensory_session_id', sensorySessionId);
    if (delErr) throw delErr;
    if (participantIds.length > 0) {
      const { error: insErr } = await supabase.from('sensory_session_participants').insert(
        participantIds.map(uid => ({ sensory_session_id: sensorySessionId, user_id: uid }))
      );
      if (insErr) throw insErr;
    }
    await loadAll();
  };

  const updateProfileRole = async (profileId, role) => {
    const { error } = await supabase.from('profiles').update({ role }).eq('id', profileId);
    if (error) throw error;
    await loadAll();
  };

  const addQcSample = async ({ sampleType, batchId, locationId, notes }) => {
    const pulledDate = todayISO();
    const { data, error } = await supabase.from('qc_samples').insert({
      sample_type: sampleType, batch_id: batchId || null, location_id: locationId || null,
      pulled_by: session.user.id, pulled_date: pulledDate, notes: notes || '',
    }).select().single();
    if (error) throw error;
    const dueDate = addDays(pulledDate, QC_READ_DAYS);
    const tests = ['wild_yeast', 'b_tube'].map(testType => ({ sample_id: data.id, test_type: testType, due_date: dueDate }));
    const { error: tErr } = await supabase.from('qc_tests').insert(tests);
    if (tErr) throw tErr;
    await loadAll();
  };

  const logQcResult = async ({ testId, result, notes }) => {
    const { error } = await supabase.from('qc_tests').update({
      result, read_date: todayISO(), read_by: session.user.id, notes: notes || '',
    }).eq('id', testId);
    if (error) throw error;
    await loadAll();
  };

  const addQcLocation = async ({ name, sortOrder }) => {
    const { error } = await supabase.from('qc_locations').insert({ name, sort_order: sortOrder || 0 });
    if (error) throw error;
    await loadAll();
  };

  const updateQcLocation = async (locationId, fields) => {
    const { error } = await supabase.from('qc_locations').update(fields).eq('id', locationId);
    if (error) throw error;
    await loadAll();
  };

  const deleteQcSample = async (sampleId) => {
    await supabase.from('qc_tests').delete().eq('sample_id', sampleId);
    const { error } = await supabase.from('qc_samples').delete().eq('id', sampleId);
    if (error) throw error;
    await loadAll();
  };

  return {
    skus, batches, retention, sessions, panels, panelBatches, briteChecks, profiles, profileName,
    sensorySessions, sensorySessionPanels, sensorySessionParticipants, qcLocations, qcSamples, qcTests,
    loading, initialLoadDone, error, reload: loadAll,
    addSku, updateSku, addBatch, addSession, updateSession, deleteSession, createPanel, deletePanel, importBatches, addBriteCheck,
    createSensorySession, deleteSensorySession, updateSessionParticipants, updateProfileRole,
    addQcSample, logQcResult, addQcLocation, updateQcLocation, deleteQcSample,
  };
}

const Pill = ({ children, tone = 'neutral' }) => {
  const tones = {
    neutral: { background: 'var(--surface-2)', color: 'var(--text-muted)' },
    good: { background: 'rgba(114,149,107,0.16)', color: 'var(--good)' },
    bad: { background: 'rgba(184,71,43,0.16)', color: 'var(--bad)' },
    warn: { background: 'rgba(243,112,58,0.18)', color: 'var(--accent)' },
  };
  return <span style={{ ...tones[tone], fontSize: 11, fontWeight: 600, padding: '3px 9px', borderRadius: 20, letterSpacing: 0.3, textTransform: 'uppercase', fontFamily: 'var(--font-mono)' }}>{children}</span>;
};

const Card = ({ children, style, className }) => (
  <div className={className} style={{ background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: 10, padding: 20, ...style }}>{children}</div>
);

const Button = ({ children, onClick, variant = 'primary', style, type = 'button', disabled }) => {
  const variants = {
    primary: { background: 'var(--accent)', color: '#1a1410', border: '1px solid var(--accent)' },
    ghost: { background: 'transparent', color: 'var(--text)', border: '1px solid var(--line)' },
    danger: { background: 'transparent', color: 'var(--bad)', border: '1px solid rgba(184,71,43,0.4)' },
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
            background: active ? (offTarget ? 'rgba(184,71,43,0.22)' : 'rgba(114,149,107,0.22)') : 'transparent',
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

const COMPARE_COLORS = ['var(--accent)', '#7A9CC6', '#B98CC7', 'var(--teal)', 'var(--gold)', 'var(--forest)', '#C7597A', '#5B8C7B'];

function MultiBatchSpiderChart({ section, target, series, height = 420 }) {
  const labels = traitLabelsFor(section);
  const chartData = TRAIT_TAXONOMY[section].flatMap(g => g.traits.map(t => {
    const id = traitId(g.category, t);
    const row = { trait: labels[id], Target: target ? (target[id] ?? 1) : 0 };
    series.forEach(s => { row[s.label] = s.scores ? (s.scores[id] ?? 1) : 1; });
    return row;
  }));
  return (
    <ResponsiveContainer width="100%" height={height}>
      <RadarChart data={chartData} outerRadius="78%">
        <PolarGrid stroke="var(--line)" />
        <PolarAngleAxis dataKey="trait" tick={{ fill: 'var(--text-muted)', fontSize: 10.5, fontFamily: 'var(--font-mono)' }} />
        <PolarRadiusAxis domain={[0, 9]} tick={false} axisLine={false} />
        {target && <Radar name="TTT Target" dataKey="Target" stroke="var(--text-faint)" strokeDasharray="4 3" fill="var(--text-faint)" fillOpacity={0.04} />}
        {series.map((s, i) => (
          <Radar key={s.label} name={s.label} dataKey={s.label} stroke={COMPARE_COLORS[i % COMPARE_COLORS.length]} fill={COMPARE_COLORS[i % COMPARE_COLORS.length]} fillOpacity={0.15} strokeWidth={2} />
        ))}
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
    <div style={{ minHeight: '100vh', position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden', background: 'var(--navy)' }}>
      <div style={{ position: 'absolute', inset: 0, backgroundImage: 'url(/pattern-bg.jpg)', backgroundSize: 'cover', backgroundPosition: 'center', opacity: 0.16 }} />
      <div style={{ position: 'relative', zIndex: 1 }}>
        <Card className="modal-card" style={{ width: 360 }}>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', marginBottom: 22 }}>
            <img src="/logo-green.png" alt="Margaret River Beer Co" style={{ height: 40, width: 'auto', marginBottom: 8 }} />
            <p style={{ margin: 0, fontSize: 11, color: 'var(--text-faint)', fontFamily: 'var(--font-mono)', letterSpacing: 0.8, textTransform: 'uppercase' }}>Sensory Log</p>
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
    </div>
  );
}

function TastingForm({ store, currentProfile, onDone, presetBatchId, presetTastingType, activePanelId, editSession }) {
  const [batchId, setBatchId] = useState(editSession ? editSession.batch_id : (presetBatchId || (store.batches[0] ? store.batches[0].id : '')));
  useEffect(() => { if (presetBatchId && !editSession) setBatchId(presetBatchId); }, [presetBatchId]);
  const [tastingType, setTastingType] = useState(editSession ? editSession.tasting_type : (presetTastingType || 'ttt'));
  useEffect(() => { if (presetTastingType && !editSession) setTastingType(presetTastingType); }, [presetTastingType]);
  const [scores, setScores] = useState(editSession ? editSession.scores : defaultAllScores());
  const [activeSection, setActiveSection] = useState('aroma');
  const [overall, setOverall] = useState(editSession ? editSession.overall : 'pass');
  const [offFlavors, setOffFlavors] = useState(editSession ? (editSession.off_flavors || []) : []);
  const [notes, setNotes] = useState(editSession ? (editSession.notes || '') : '');
  const [retentionCheckpointId, setRetentionCheckpointId] = useState(editSession ? (editSession.retention_checkpoint_id || '') : '');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [justAdvanced, setJustAdvanced] = useState('');

  const batch = store.batches.find(b => b.id === batchId);
  const sku = batch ? store.skus.find(s => s.id === batch.sku_id) : null;
  const dueCheckpoints = batch ? store.retention.filter(r => r.batch_id === batch.id && (!r.assessed || r.id === retentionCheckpointId)) : [];

  const toggleOff = (f) => setOffFlavors(prev =>
    prev.some(x => x.flavor === f) ? prev.filter(x => x.flavor !== f) : [...prev, { flavor: f, intensity: 3 }]);
  const setOffIntensity = (f, intensity) => setOffFlavors(prev => prev.map(x => x.flavor === f ? { ...x, intensity } : x));
  const setTraitScore = (section, id, v) => setScores(s => ({ ...s, [section]: { ...s[section], [id]: v } }));

  const findNextInPanel = (justSubmittedBatchId) => {
    if (!activePanelId) return null;
    const doneBatchIds = new Set(
      store.sessions.filter(s => s.taster_id === currentProfile.id && s.tasting_type === tastingType).map(s => s.batch_id)
    );
    doneBatchIds.add(justSubmittedBatchId);
    const panelBatchIds = store.panelBatches.filter(pb => pb.panel_id === activePanelId).map(pb => pb.batch_id);
    return panelBatchIds.find(bid => !doneBatchIds.has(bid)) || null;
  };

  const submit = async () => {
    if (!batchId) return;
    setSubmitting(true); setError('');
    try {
      const payload = {
        batchId, date: editSession ? editSession.date : todayISO(), scores, overall, offFlavors, notes,
        retentionCheckpointId: tastingType === 'retention' ? (retentionCheckpointId || null) : null,
        tastingType,
      };
      if (editSession) {
        await store.updateSession(editSession.id, payload);
        onDone();
        return;
      }

      const submittedBatchId = batchId;
      await store.addSession(payload);

      const next = findNextInPanel(submittedBatchId);
      if (next) {
        const submittedBatch = store.batches.find(b => b.id === submittedBatchId);
        setJustAdvanced(`Saved ${submittedBatch ? submittedBatch.batch_number : 'that one'} — now tasting the next beer in this panel.`);
        setBatchId(next);
        setScores(defaultAllScores());
        setActiveSection('aroma');
        setOverall('pass');
        setOffFlavors([]);
        setNotes('');
        setRetentionCheckpointId('');
      } else {
        onDone();
      }
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
        <div className="responsive-grid-2" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20 }}>
          {Object.keys(SECTION_LABELS).map(sec => (
            <div key={sec}>
              <p style={{ margin: '0 0 4px', fontSize: 12, fontWeight: 700, color: 'var(--text-faint)', textTransform: 'uppercase', textAlign: 'center' }}>{SECTION_LABELS[sec]}</p>
              <TraitSpiderChart section={sec} target={sku ? sku.target[sec] : null} actual={scores[sec]} height={440} />
            </div>
          ))}
        </div>
      </Card>

      <div className="responsive-grid-2" style={{ display: 'grid', gridTemplateColumns: '1.15fr 0.85fr', gap: 24 }}>
        <Card>
          <h3 style={{ margin: '0 0 4px', fontFamily: 'var(--font-display)', fontSize: 20 }}>{editSession ? 'Edit tasting' : 'Log a tasting'}</h3>
          <p style={{ margin: '0 0 20px', color: 'var(--text-muted)', fontSize: 13 }}>Tasting as <strong style={{ color: 'var(--text)' }}>{currentProfile.name}</strong></p>
          {justAdvanced && <p style={{ margin: '0 0 16px', padding: '8px 12px', background: 'rgba(122,157,122,0.16)', color: 'var(--good)', borderRadius: 6, fontSize: 12.5 }}>{justAdvanced}</p>}

          <Field label="Tasting type">
            <div style={{ display: 'flex', gap: 8 }}>
              <button type="button" onClick={() => setTastingType('ttt')} style={{
                flex: 1, padding: '9px 0', borderRadius: 7, fontWeight: 700, fontSize: 13, cursor: 'pointer',
                border: `1px solid ${tastingType === 'ttt' ? 'var(--accent)' : 'var(--line)'}`,
                background: tastingType === 'ttt' ? 'rgba(243,112,58,0.16)' : 'transparent',
                color: tastingType === 'ttt' ? 'var(--accent)' : 'var(--text-muted)',
              }}>True to Type</button>
              <button type="button" onClick={() => setTastingType('retention')} style={{
                flex: 1, padding: '9px 0', borderRadius: 7, fontWeight: 700, fontSize: 13, cursor: 'pointer',
                border: `1px solid ${tastingType === 'retention' ? 'var(--accent)' : 'var(--line)'}`,
                background: tastingType === 'retention' ? 'rgba(243,112,58,0.16)' : 'transparent',
                color: tastingType === 'retention' ? 'var(--accent)' : 'var(--text-muted)',
              }}>Retention</button>
            </div>
          </Field>

          <Field label="Batch">
            <select style={inputStyle} value={batchId} onChange={e => { setBatchId(e.target.value); setRetentionCheckpointId(''); }}>
              {store.batches.filter(b => b.package_date).map(b => {
                const s = store.skus.find(sk => sk.id === b.sku_id);
                return <option key={b.id} value={b.id}>{b.batch_number} — {s ? s.name : 'Unknown SKU'}</option>;
              })}
            </select>
          </Field>

          {tastingType === 'retention' && dueCheckpoints.length > 0 && (
            <Field label="Retention checkpoint">
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
                background: activeSection === sec ? 'rgba(243,112,58,0.16)' : 'transparent',
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
                    background: selected ? 'rgba(184,71,43,0.16)' : 'transparent',
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
                          background: intensity === n ? 'rgba(184,71,43,0.28)' : 'transparent',
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
                  background: overall === v ? 'rgba(243,112,58,0.16)' : 'transparent',
                  color: overall === v ? 'var(--accent)' : 'var(--text-muted)',
                }}>{v}</button>
              ))}
            </div>
          </Field>

          {error && <p style={{ color: 'var(--bad)', fontSize: 12.5, marginBottom: 8 }}>{error}</p>}
          <Button onClick={submit} disabled={!batchId || submitting} style={{ width: '100%', justifyContent: 'center' }}>
            <Check size={15} /> {submitting ? 'Saving…' : editSession ? 'Save changes' : 'Submit tasting'}
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

function DeletePanelButton({ panel, store }) {
  const [busy, setBusy] = useState(false);

  const handleClick = async () => {
    if (!window.confirm(`Delete "${panel.label}"? This removes the panel itself — the batches and any tastings already logged stay untouched.`)) return;
    setBusy(true);
    try {
      await store.deletePanel(panel.id);
    } catch (e) {
      alert(e.message || 'Could not delete — try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Button variant="danger" onClick={handleClick} disabled={busy} style={{ padding: '6px 10px', fontSize: 12 }}>
      <X size={13} /> {busy ? 'Deleting…' : 'Delete'}
    </Button>
  );
}

function computeSessionProgress(sess, store) {
  const panelIds = store.sensorySessionPanels.filter(sp => sp.sensory_session_id === sess.id).map(sp => sp.panel_id);
  const participantIds = store.sensorySessionParticipants.filter(pp => pp.sensory_session_id === sess.id).map(pp => pp.user_id);
  const panelsInfo = panelIds.map(pid => store.panels.find(p => p.id === pid)).filter(Boolean);

  const batchEntries = [];
  panelsInfo.forEach(panel => {
    const bids = store.panelBatches.filter(pb => pb.panel_id === panel.id).map(pb => pb.batch_id);
    bids.forEach(bid => batchEntries.push({ batchId: bid, panelType: panel.panel_type, panelId: panel.id }));
  });

  let total = 0, done = 0;
  batchEntries.forEach(be => {
    participantIds.forEach(uid => {
      total++;
      if (store.sessions.some(s => s.batch_id === be.batchId && s.taster_id === uid && s.tasting_type === be.panelType)) done++;
    });
  });

  return { panelsInfo, participantIds, batchEntries, total, done };
}

function SessionBuilder({ store }) {
  const [building, setBuilding] = useState(false);
  const [date, setDate] = useState(todayISO());
  const [label, setLabel] = useState('');
  const [selectedPanelIds, setSelectedPanelIds] = useState([]);
  const [selectedParticipantIds, setSelectedParticipantIds] = useState([]);
  const [busy, setBusy] = useState(false);

  const togglePanel = (id) => setSelectedPanelIds(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);
  const toggleParticipant = (id) => setSelectedParticipantIds(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);

  const create = async () => {
    if (selectedPanelIds.length === 0 || selectedParticipantIds.length === 0) return;
    setBusy(true);
    try {
      await store.createSensorySession({ date, label: label || `Session — ${date}`, panelIds: selectedPanelIds, participantIds: selectedParticipantIds });
      setBuilding(false); setLabel(''); setSelectedPanelIds([]); setSelectedParticipantIds([]);
    } finally {
      setBusy(false);
    }
  };

  const sortedPanels = useMemo(() => [...store.panels].sort((a, b) => b.date.localeCompare(a.date)), [store.panels]);

  return (
    <>
      <Button onClick={() => setBuilding(v => !v)}><Plus size={15} /> Build session</Button>
      {building && (
        <Card style={{ marginTop: 14, marginBottom: 20 }}>
          <div className="responsive-grid-2" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }}>
            <Field label="Date"><input type="date" style={inputStyle} value={date} onChange={e => setDate(e.target.value)} /></Field>
            <Field label="Label (optional)"><input style={inputStyle} value={label} onChange={e => setLabel(e.target.value)} placeholder="e.g. Thursday session" /></Field>
          </div>
          <Field label={`Panels to include (${selectedPanelIds.length} chosen)`}>
            <div style={{ maxHeight: 180, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 4 }}>
              {sortedPanels.map(p => (
                <label key={p.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 8px', borderRadius: 6, cursor: 'pointer', background: selectedPanelIds.includes(p.id) ? 'var(--surface-2)' : 'transparent' }}>
                  <input type="checkbox" checked={selectedPanelIds.includes(p.id)} onChange={() => togglePanel(p.id)} />
                  <span style={{ fontSize: 13 }}>{p.label}</span>
                  <Pill tone={p.panel_type === 'retention' ? 'warn' : 'neutral'}>{p.panel_type === 'retention' ? 'Retention' : 'TTT'}</Pill>
                </label>
              ))}
              {sortedPanels.length === 0 && <p style={{ color: 'var(--text-muted)', fontSize: 13 }}>No panels exist yet — build one on the Panels tab first.</p>}
            </div>
          </Field>
          <Field label={`Assign participants (${selectedParticipantIds.length} chosen)`}>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {store.profiles.map(p => (
                <button key={p.id} type="button" onClick={() => toggleParticipant(p.id)} style={{
                  fontSize: 12, padding: '6px 10px', borderRadius: 20, cursor: 'pointer',
                  border: `1px solid ${selectedParticipantIds.includes(p.id) ? 'var(--accent)' : 'var(--line)'}`,
                  background: selectedParticipantIds.includes(p.id) ? 'rgba(243,112,58,0.16)' : 'transparent',
                  color: selectedParticipantIds.includes(p.id) ? 'var(--accent)' : 'var(--text-muted)',
                }}>{p.name}</button>
              ))}
            </div>
          </Field>
          <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
            <Button onClick={create} disabled={busy || selectedPanelIds.length === 0 || selectedParticipantIds.length === 0}>{busy ? 'Creating…' : 'Create session'}</Button>
            <Button variant="ghost" onClick={() => setBuilding(false)}>Cancel</Button>
          </div>
        </Card>
      )}
    </>
  );
}

function SessionResultBatch({ be, store, relevantTastings }) {
  const [mode, setMode] = useState('averaged');

  const batch = store.batches.find(b => b.id === be.batchId);
  const sku = batch ? store.skus.find(s => s.id === batch.sku_id) : null;
  const target = sku ? normalizeTarget(sku.target) : null;
  const tastings = relevantTastings.filter(t => t.batch_id === be.batchId && t.tasting_type === be.panelType);

  const avgScoresBySection = { aroma: {}, flavor: {} };
  ['aroma', 'flavor'].forEach(section => {
    TRAIT_TAXONOMY[section].forEach(g => g.traits.forEach(t => {
      const id = traitId(g.category, t);
      const vals = tastings.map(s => s.scores?.[section]?.[id]).filter(v => v != null);
      avgScoresBySection[section][id] = vals.length > 0 ? vals.reduce((a, c) => a + c, 0) / vals.length : null;
    }));
  });

  const seriesBySection = {
    aroma: tastings.map(t => ({ label: store.profileName(t.taster_id), scores: t.scores?.aroma || {} })),
    flavor: tastings.map(t => ({ label: store.profileName(t.taster_id), scores: t.scores?.flavor || {} })),
  };

  return (
    <div style={{ marginBottom: 32, paddingBottom: 28, borderBottom: '1px solid var(--line)' }}>
      <div className="header-row-stack" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <h3 style={{ margin: 0, fontFamily: 'var(--font-display)', fontSize: 18 }}>{batch ? batch.batch_number : '—'} — {sku ? sku.name : 'Unknown SKU'}</h3>
          <Pill tone={be.panelType === 'retention' ? 'warn' : 'neutral'}>{be.panelType === 'retention' ? 'Retention' : 'TTT'}</Pill>
        </div>
        {tastings.length > 1 && (
          <div className="no-print" style={{ display: 'flex', gap: 6 }}>
            <button type="button" onClick={() => setMode('averaged')} style={{
              fontSize: 12, padding: '6px 12px', borderRadius: 20, cursor: 'pointer',
              border: `1px solid ${mode === 'averaged' ? 'var(--accent)' : 'var(--line)'}`,
              background: mode === 'averaged' ? 'rgba(243,112,58,0.16)' : 'transparent',
              color: mode === 'averaged' ? 'var(--accent)' : 'var(--text-muted)',
            }}>Averaged</button>
            <button type="button" onClick={() => setMode('individual')} style={{
              fontSize: 12, padding: '6px 12px', borderRadius: 20, cursor: 'pointer',
              border: `1px solid ${mode === 'individual' ? 'var(--accent)' : 'var(--line)'}`,
              background: mode === 'individual' ? 'rgba(243,112,58,0.16)' : 'transparent',
              color: mode === 'individual' ? 'var(--accent)' : 'var(--text-muted)',
            }}>Individual ({tastings.length})</button>
          </div>
        )}
      </div>

      <div className="responsive-grid-2" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20, marginBottom: 18 }}>
        {mode === 'averaged' ? (
          <>
            <TraitSpiderChart section="aroma" target={target ? target.aroma : null} actual={avgScoresBySection.aroma} height={420} />
            <TraitSpiderChart section="flavor" target={target ? target.flavor : null} actual={avgScoresBySection.flavor} height={420} />
          </>
        ) : (
          <>
            <MultiBatchSpiderChart section="aroma" target={target ? target.aroma : null} series={seriesBySection.aroma} height={420} />
            <MultiBatchSpiderChart section="flavor" target={target ? target.flavor : null} series={seriesBySection.flavor} height={420} />
          </>
        )}
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
        {tastings.map(t => (
          <div key={t.id} style={{ flex: '1 1 220px', border: '1px solid var(--line)', borderRadius: 8, padding: '10px 12px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span style={{ fontSize: 12.5, fontWeight: 600 }}>{store.profileName(t.taster_id)}</span>
              <Pill tone={t.overall === 'pass' ? 'good' : t.overall === 'flag' ? 'warn' : 'bad'}>{t.overall}</Pill>
            </div>
            {(t.off_flavors || []).length > 0 && <p style={{ margin: '4px 0 0', fontSize: 11.5, color: 'var(--bad)' }}>{t.off_flavors.map(f => `${f.flavor} (${f.intensity}/5)`).join(', ')}</p>}
            {t.notes && <p style={{ margin: '4px 0 0', fontSize: 11.5, color: 'var(--text-muted)' }}>"{t.notes}"</p>}
          </div>
        ))}
        {tastings.length === 0 && <p style={{ fontSize: 12.5, color: 'var(--text-muted)' }}>No tastings recorded.</p>}
      </div>
    </div>
  );
}

function SessionResultsModal({ sess, store, onClose }) {
  const progress = computeSessionProgress(sess, store);

  const relevantTastings = useMemo(() => {
    return progress.batchEntries.flatMap(be =>
      store.sessions.filter(s => s.batch_id === be.batchId && s.tasting_type === be.panelType && progress.participantIds.includes(s.taster_id))
    );
  }, [progress, store.sessions]);

  const passCount = relevantTastings.filter(t => t.overall === 'pass').length;
  const flagCount = relevantTastings.filter(t => t.overall === 'flag').length;
  const failCount = relevantTastings.filter(t => t.overall === 'fail').length;
  const allOffFlavors = relevantTastings.flatMap(t => t.off_flavors || []);

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'flex-start', justifyContent: 'center', zIndex: 60, padding: '32px 20px', overflowY: 'auto' }}>
      <div className="modal-card" style={{ background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: 12, padding: 32, width: 1200, maxWidth: '96vw' }}>
        <div className="no-print header-row-stack" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
          <Button variant="ghost" onClick={onClose}><X size={15} /> Close</Button>
          <Button onClick={() => window.print()}><Upload size={15} style={{ transform: 'rotate(180deg)' }} /> Print / Save as PDF</Button>
        </div>

        <div id="batch-report-printable">
          <div style={{ borderBottom: '2px solid var(--accent)', paddingBottom: 14, marginBottom: 20 }}>
            <p style={{ margin: 0, fontSize: 11, color: 'var(--text-faint)', textTransform: 'uppercase', letterSpacing: 0.5, fontFamily: 'var(--font-mono)' }}>Session Results</p>
            <h2 style={{ margin: '2px 0 4px', fontFamily: 'var(--font-display)', fontSize: 26 }}>{sess.label}</h2>
            <p style={{ margin: 0, fontSize: 13, color: 'var(--text-muted)' }}>
              {sess.date} · Participants: {progress.participantIds.map(uid => store.profileName(uid)).join(', ') || 'none'}
            </p>
          </div>

          <div style={{ display: 'flex', gap: 12, marginBottom: 24 }}>
            <Card style={{ flex: 1 }}>
              <p style={{ margin: '0 0 4px', fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase' }}>Tastings</p>
              <p style={{ margin: 0, fontSize: 26, fontFamily: 'var(--font-display)' }}>{relevantTastings.length}</p>
            </Card>
            <Card style={{ flex: 1 }}>
              <p style={{ margin: '0 0 4px', fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase' }}>Pass</p>
              <p style={{ margin: 0, fontSize: 26, fontFamily: 'var(--font-display)', color: 'var(--good)' }}>{passCount}</p>
            </Card>
            <Card style={{ flex: 1 }}>
              <p style={{ margin: '0 0 4px', fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase' }}>Flag</p>
              <p style={{ margin: 0, fontSize: 26, fontFamily: 'var(--font-display)', color: 'var(--accent)' }}>{flagCount}</p>
            </Card>
            <Card style={{ flex: 1 }}>
              <p style={{ margin: '0 0 4px', fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase' }}>Fail</p>
              <p style={{ margin: 0, fontSize: 26, fontFamily: 'var(--font-display)', color: 'var(--bad)' }}>{failCount}</p>
            </Card>
          </div>

          {allOffFlavors.length > 0 && (
            <Card style={{ marginBottom: 24 }}>
              <p style={{ margin: '0 0 8px', fontSize: 12, fontWeight: 700, textTransform: 'uppercase', color: 'var(--text-muted)' }}>Off-flavors noted this session</p>
              <p style={{ margin: 0, fontSize: 13, color: 'var(--bad)' }}>{allOffFlavors.map(f => `${f.flavor} (${f.intensity}/5)`).join(', ')}</p>
            </Card>
          )}

          {progress.batchEntries.map(be => (
            <SessionResultBatch key={`${be.batchId}-${be.panelType}`} be={be} store={store} relevantTastings={relevantTastings} />
          ))}
        </div>
      </div>
    </div>
  );
}

function SessionCard({ sess, store, isLead, currentProfile, onLogTasting }) {
  const progress = computeSessionProgress(sess, store);
  const [expanded, setExpanded] = useState(!isLead);
  const [showResults, setShowResults] = useState(false);

  const handleDelete = async () => {
    if (!window.confirm(`Delete "${sess.label}"? This does not affect the underlying panels, batches, or tastings.`)) return;
    try {
      await store.deleteSensorySession(sess.id);
    } catch (e) {
      alert(e.message || 'Could not delete — try again.');
    }
  };

  return (
    <Card>
      {showResults && <SessionResultsModal sess={sess} store={store} onClose={() => setShowResults(false)} />}
      <div className="header-row-stack" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 10 }}>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <p style={{ margin: 0, fontWeight: 700, fontSize: 15, fontFamily: 'var(--font-display)' }}>{sess.label}</p>
            <Pill tone={sess.status === 'complete' ? 'good' : 'warn'}>{sess.status === 'complete' ? 'Complete' : 'Open'}</Pill>
          </div>
          <p style={{ margin: '2px 0 0', fontSize: 12.5, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>{sess.date} · {progress.done}/{progress.total} tastings done</p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          {sess.status === 'complete' ? (
            <Button variant="ghost" onClick={() => setShowResults(true)} style={{ fontSize: 12, padding: '6px 10px' }}>View results</Button>
          ) : (
            <Button variant="ghost" onClick={() => setExpanded(v => !v)} style={{ fontSize: 12, padding: '6px 10px' }}>{expanded ? 'Hide' : 'View'}</Button>
          )}
          {isLead && <Button variant="danger" onClick={handleDelete} style={{ fontSize: 12, padding: '6px 10px' }}><X size={13} /> Delete</Button>}
        </div>
      </div>

      {isLead && (
        <p style={{ fontSize: 12, color: 'var(--text-faint)', marginBottom: expanded ? 12 : 0 }}>
          Participants: {progress.participantIds.length > 0 ? progress.participantIds.map(uid => store.profileName(uid)).join(', ') : 'none assigned'}
        </p>
      )}

      {sess.status !== 'complete' && expanded && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {progress.batchEntries.map(be => {
            const batch = store.batches.find(b => b.id === be.batchId);
            const sku = batch ? store.skus.find(s => s.id === batch.sku_id) : null;
            const myTasting = store.sessions.find(s => s.batch_id === be.batchId && s.taster_id === currentProfile.id && s.tasting_type === be.panelType);
            return (
              <div key={`${be.batchId}-${be.panelType}`} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 12px', background: 'var(--surface-2)', borderRadius: 6 }}>
                <span style={{ fontSize: 13.5 }}>{batch ? batch.batch_number : '—'} — {sku ? sku.name : ''} <Pill tone={be.panelType === 'retention' ? 'warn' : 'neutral'}>{be.panelType === 'retention' ? 'Retention' : 'TTT'}</Pill></span>
                {!isLead && (myTasting ? <Pill tone="good">You've tasted this</Pill> : (
                  <Button variant="ghost" onClick={() => onLogTasting(be.batchId, be.panelType, be.panelId)} style={{ fontSize: 12, padding: '6px 10px' }}>Taste now <ChevronRight size={13} /></Button>
                ))}
              </div>

            );
          })}
        </div>
      )}
    </Card>
  );
}

function SessionsView({ store, isLead, currentProfile, onLogTasting }) {
  const mySessions = useMemo(() => {
    const ids = store.sensorySessionParticipants.filter(pp => pp.user_id === currentProfile.id).map(pp => pp.sensory_session_id);
    return store.sensorySessions.filter(s => ids.includes(s.id)).sort((a, b) => b.date.localeCompare(a.date));
  }, [store.sensorySessions, store.sensorySessionParticipants, currentProfile.id]);

  const allSessionsSorted = useMemo(() => [...store.sensorySessions].sort((a, b) => b.date.localeCompare(a.date)), [store.sensorySessions]);
  const sessionsToShow = isLead ? allSessionsSorted : mySessions;

  return (
    <div>
      <div className="header-row-stack" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
        <div>
          <h3 style={{ fontFamily: 'var(--font-display)', fontSize: 22, margin: '0 0 4px' }}>Sessions</h3>
          <p style={{ color: 'var(--text-muted)', fontSize: 13.5, margin: 0 }}>{isLead ? 'All sensory sessions.' : "Sessions you're assigned to."}</p>
        </div>
        {isLead && <SessionBuilder store={store} />}
      </div>

      {sessionsToShow.length === 0 && (
        <p style={{ color: 'var(--text-muted)' }}>{isLead ? 'No sessions yet — build one above.' : 'No sessions assigned to you right now.'}</p>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        {sessionsToShow.map(sess => (
          <SessionCard key={sess.id} sess={sess} store={store} isLead={isLead} currentProfile={currentProfile} onLogTasting={onLogTasting} />
        ))}
      </div>
    </div>
  );
}

function PanelsView({ store, isLead, currentProfile, onLogTasting }) {
  const [building, setBuilding] = useState(false);
  const [label, setLabel] = useState('');
  const [date, setDate] = useState(todayISO());
  const [panelType, setPanelType] = useState('ttt');
  const [selected, setSelected] = useState([]);
  const [busy, setBusy] = useState(false);

  const toggleSelect = (id) => setSelected(prev => prev.includes(id) ? prev.filter(b => b !== id) : [...prev, id]);

  const create = async () => {
    if (selected.length === 0) return;
    setBusy(true);
    try {
      await store.createPanel({ date, label: label || `Panel — ${date}`, batchIds: selected, panelType });
      setBuilding(false); setLabel(''); setSelected([]); setPanelType('ttt');
    } finally {
      setBusy(false);
    }
  };

  const sortedPanels = useMemo(() => [...store.panels].sort((a, b) => b.date.localeCompare(a.date)), [store.panels]);

  const panelProgress = (panel) => {
    const batchIds = store.panelBatches.filter(pb => pb.panel_id === panel.id).map(pb => pb.batch_id);
    const total = batchIds.length;
    const doneByMe = batchIds.filter(bid =>
      store.sessions.some(s => s.batch_id === bid && s.taster_id === currentProfile.id && s.tasting_type === panel.panel_type)
    ).length;
    return { total, doneByMe, batchIds };
  };

  return (
    <div>
      <div className="header-row-stack" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
        <div>
          <h3 style={{ fontFamily: 'var(--font-display)', fontSize: 22, margin: '0 0 4px' }}>Sensory panels</h3>
          <p style={{ color: 'var(--text-muted)', fontSize: 13.5, margin: 0 }}>{isLead ? 'Build a panel by picking which batches need tasting.' : 'Work through your assigned panel one batch at a time.'}</p>
        </div>
        {isLead && <Button onClick={() => setBuilding(v => !v)}><Plus size={15} /> Build panel</Button>}
      </div>

      {building && (
        <Card style={{ marginBottom: 20 }}>
          <div className="responsive-grid-2" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }}>
            <Field label="Date"><input type="date" style={inputStyle} value={date} onChange={e => setDate(e.target.value)} /></Field>
            <Field label="Label (optional)"><input style={inputStyle} value={label} onChange={e => setLabel(e.target.value)} placeholder="e.g. Tuesday panel" /></Field>
          </div>
          <Field label="Panel type">
            <div style={{ display: 'flex', gap: 8 }}>
              <button type="button" onClick={() => setPanelType('ttt')} style={{
                flex: 1, padding: '9px 0', borderRadius: 7, fontWeight: 700, fontSize: 13, cursor: 'pointer',
                border: `1px solid ${panelType === 'ttt' ? 'var(--accent)' : 'var(--line)'}`,
                background: panelType === 'ttt' ? 'rgba(243,112,58,0.16)' : 'transparent',
                color: panelType === 'ttt' ? 'var(--accent)' : 'var(--text-muted)',
              }}>True to Type</button>
              <button type="button" onClick={() => setPanelType('retention')} style={{
                flex: 1, padding: '9px 0', borderRadius: 7, fontWeight: 700, fontSize: 13, cursor: 'pointer',
                border: `1px solid ${panelType === 'retention' ? 'var(--accent)' : 'var(--line)'}`,
                background: panelType === 'retention' ? 'rgba(243,112,58,0.16)' : 'transparent',
                color: panelType === 'retention' ? 'var(--accent)' : 'var(--text-muted)',
              }}>Retention</button>
            </div>
          </Field>
          <p style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: 8 }}>Select batches ({selected.length} chosen)</p>
          {store.batches.length === 0 && <p style={{ color: 'var(--text-muted)', fontSize: 13.5 }}>No batches yet — add some on the Batches tab first.</p>}
          <div style={{ maxHeight: 280, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 14 }}>
            {store.batches.filter(b => b.package_date).map(b => {
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
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <p style={{ margin: 0, fontWeight: 700, fontSize: 15, fontFamily: 'var(--font-display)' }}>{panel.label}</p>
                    <Pill tone={panel.panel_type === 'retention' ? 'warn' : 'neutral'}>{panel.panel_type === 'retention' ? 'Retention' : 'True to Type'}</Pill>
                  </div>
                  <p style={{ margin: '2px 0 0', fontSize: 12.5, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>{panel.date} · {progress.total} batches</p>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <Pill tone={progress.doneByMe === progress.total ? 'good' : 'warn'}>{progress.doneByMe}/{progress.total} done by you</Pill>
                  {isLead && <DeletePanelButton panel={panel} store={store} />}
                </div>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {progress.batchIds.map(bid => {
                  const batch = store.batches.find(b => b.id === bid);
                  const sku = batch ? store.skus.find(s => s.id === batch.sku_id) : null;
                  const myTasting = store.sessions.find(s => s.batch_id === bid && s.taster_id === currentProfile.id && s.tasting_type === panel.panel_type);
                  const totalTastings = store.sessions.filter(s => s.batch_id === bid && s.tasting_type === panel.panel_type).length;
                  return (
                    <div key={bid} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 12px', background: 'var(--surface-2)', borderRadius: 6 }}>
                      <span style={{ fontSize: 13.5 }}>{batch ? batch.batch_number : '—'} — {sku ? sku.name : ''}</span>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <span style={{ fontSize: 11.5, color: 'var(--text-faint)' }}>{totalTastings} tasting{totalTastings !== 1 ? 's' : ''} logged</span>
                        {myTasting ? <Pill tone="good">You've tasted this</Pill> : (
                          <Button variant="ghost" onClick={() => onLogTasting(bid, panel.panel_type, panel.id)} style={{ fontSize: 12, padding: '6px 10px' }}>Taste now <ChevronRight size={13} /></Button>
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
            {r.assessed ? <Pill tone="good">Assessed</Pill> : <Button variant="ghost" onClick={() => onLogTasting(r.batch.id, 'retention')} style={{ fontSize: 12.5, padding: '7px 12px' }}>Log tasting <ChevronRight size={14} /></Button>}
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

const QC_TEST_LABELS = { wild_yeast: 'Wild Yeast', b_tube: 'B Tube' };

function qcSampleLabel(sample, store) {
  if (!sample) return 'Unknown sample';
  if (sample.sample_type === 'environmental') {
    const loc = store.qcLocations.find(l => l.id === sample.location_id);
    return loc ? loc.name : 'Unknown location';
  }
  const batch = store.batches.find(b => b.id === sample.batch_id);
  const sku = batch ? store.skus.find(s => s.id === batch.sku_id) : null;
  const loc = sample.location_id ? store.qcLocations.find(l => l.id === sample.location_id) : null;
  const prefix = sample.sample_type === 'in_process' ? 'In-process · ' : '';
  return batch ? `${prefix}${batch.batch_number}${sku ? ' · ' + sku.name : ''}${loc ? ' · ' + loc.name : ''}` : 'Unknown batch';
}

function LogQcSampleModal({ store, onClose }) {
  const [sampleType, setSampleType] = useState('batch');
  const [batchId, setBatchId] = useState('');
  const [locationId, setLocationId] = useState('');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);

  const activeLocations = useMemo(() => store.qcLocations.filter(l => l.active), [store.qcLocations]);
  const sortedBatches = useMemo(() => [...store.batches].sort((a, b) => Number(b.batch_number) - Number(a.batch_number)), [store.batches]);
  const canSubmit = sampleType === 'environmental' ? !!locationId : !!batchId;

  const submit = async () => {
    setBusy(true); setError('');
    try {
      await store.addQcSample({
        sampleType,
        batchId: sampleType !== 'environmental' ? batchId : null,
        locationId: (sampleType === 'environmental' || sampleType === 'in_process') ? (locationId || null) : null,
        notes,
      });
      setDone(true);
    } catch (e) {
      setError(e.message || 'Could not save — try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 50, padding: 20 }}>
      <div className="modal-card" style={{ background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: 12, padding: 24, width: 480 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
          <h3 style={{ margin: 0, fontFamily: 'var(--font-display)', fontSize: 18 }}>Log a QC sample</h3>
          <X size={18} style={{ cursor: 'pointer', color: 'var(--text-muted)' }} onClick={onClose} />
        </div>

        {done ? (
          <div style={{ padding: '12px 0' }}>
            <p style={{ fontSize: 14, marginBottom: 6 }}>Sample logged — Wild Yeast and B Tube reads are due {addDays(todayISO(), QC_READ_DAYS)}.</p>
            <Button onClick={onClose} style={{ marginTop: 8 }}>Done</Button>
          </div>
        ) : (
          <>
            <p style={{ color: 'var(--text-muted)', fontSize: 13, margin: '0 0 14px' }}>Creates a Wild Yeast and a B Tube read, both due in {QC_READ_DAYS} days.</p>
            <Field label="Sample source">
              <div style={{ display: 'flex', gap: 8 }}>
                {[['batch', 'Packaged batch'], ['in_process', 'In-process'], ['environmental', 'Environmental']].map(([val, label]) => (
                  <button key={val} type="button" onClick={() => { setSampleType(val); setBatchId(''); setLocationId(''); }} style={{
                    flex: 1, padding: '8px 4px', borderRadius: 7, fontWeight: 700, fontSize: 12, cursor: 'pointer',
                    border: `1px solid ${sampleType === val ? 'var(--accent)' : 'var(--line)'}`,
                    background: sampleType === val ? 'rgba(243,112,58,0.16)' : 'transparent',
                    color: sampleType === val ? 'var(--accent)' : 'var(--text-muted)',
                  }}>{label}</button>
                ))}
              </div>
            </Field>
            {sampleType === 'environmental' ? (
              <Field label="Location">
                <select style={inputStyle} value={locationId} onChange={e => setLocationId(e.target.value)}>
                  <option value="">Select a location…</option>
                  {activeLocations.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
                </select>
              </Field>
            ) : (
              <>
                <Field label="Batch">
                  <select style={inputStyle} value={batchId} onChange={e => setBatchId(e.target.value)}>
                    <option value="">Select a batch…</option>
                    {sortedBatches.map(b => {
                      const sku = store.skus.find(s => s.id === b.sku_id);
                      return <option key={b.id} value={b.id}>{b.batch_number}{sku ? ` — ${sku.name}` : ''}</option>;
                    })}
                  </select>
                </Field>
                {sampleType === 'in_process' && (
                  <Field label="Location (optional) — where in the process">
                    <select style={inputStyle} value={locationId} onChange={e => setLocationId(e.target.value)}>
                      <option value="">Not specified</option>
                      {activeLocations.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
                    </select>
                  </Field>
                )}
              </>
            )}
            <Field label="Notes (optional)">
              <textarea style={{ ...inputStyle, minHeight: 60, fontFamily: 'var(--font-body)' }} value={notes} onChange={e => setNotes(e.target.value)} />
            </Field>
            {error && <p style={{ color: 'var(--bad)', fontSize: 12.5, marginBottom: 8 }}>{error}</p>}
            <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
              <Button onClick={submit} disabled={!canSubmit || busy}>{busy ? 'Saving…' : 'Log sample'}</Button>
              <Button variant="ghost" onClick={onClose}>Cancel</Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function QcTestRow({ test, sample, store }) {
  const [logging, setLogging] = useState(false);
  const [result, setResult] = useState('negative');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [deleting, setDeleting] = useState(false);

  const submit = async () => {
    setBusy(true); setError('');
    try {
      await store.logQcResult({ testId: test.id, result, notes });
      setLogging(false); setNotes(''); setResult('negative');
    } catch (e) {
      setError(e.message || 'Could not save — try again.');
    } finally {
      setBusy(false);
    }
  };

  const handleDeleteSample = async () => {
    if (!window.confirm('Delete this sample and both its tests? This cannot be undone.')) return;
    setDeleting(true);
    try {
      await store.deleteQcSample(sample.id);
    } catch (e) {
      alert(e.message || 'Could not delete — try again.');
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div style={{ background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: 8, padding: '12px 16px' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div>
          <p style={{ margin: 0, fontWeight: 600, fontSize: 14 }}>{qcSampleLabel(sample, store)}</p>
          <p style={{ margin: '2px 0 0', fontSize: 12.5, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
            {QC_TEST_LABELS[test.test_type]} · due {test.due_date}
          </p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {test.result === 'pending' ? (
            <>
              <Pill tone="warn">Pending</Pill>
              <Button variant="ghost" onClick={() => setLogging(v => !v)} style={{ fontSize: 12.5, padding: '7px 12px' }}>Log read</Button>
            </>
          ) : (
            <Pill tone={test.result === 'negative' ? 'good' : 'bad'}>{test.result === 'negative' ? 'Negative' : 'Positive'}</Pill>
          )}
          <Button variant="danger" onClick={handleDeleteSample} disabled={deleting} style={{ fontSize: 11, padding: '6px 8px' }}><X size={12} /></Button>
        </div>
      </div>

      {logging && (
        <div style={{ background: 'var(--surface-2)', borderRadius: 8, padding: 14, marginTop: 10 }}>
          <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
            <button type="button" onClick={() => setResult('negative')} style={{
              flex: 1, padding: '9px 0', borderRadius: 7, fontWeight: 700, fontSize: 13, cursor: 'pointer',
              border: `1px solid ${result === 'negative' ? 'var(--good)' : 'var(--line)'}`,
              background: result === 'negative' ? 'rgba(114,149,107,0.18)' : 'transparent',
              color: result === 'negative' ? 'var(--good)' : 'var(--text-muted)',
            }}>Negative</button>
            <button type="button" onClick={() => setResult('positive')} style={{
              flex: 1, padding: '9px 0', borderRadius: 7, fontWeight: 700, fontSize: 13, cursor: 'pointer',
              border: `1px solid ${result === 'positive' ? 'var(--bad)' : 'var(--line)'}`,
              background: result === 'positive' ? 'rgba(184,71,43,0.18)' : 'transparent',
              color: result === 'positive' ? 'var(--bad)' : 'var(--text-muted)',
            }}>Positive</button>
          </div>
          <textarea style={{ ...inputStyle, minHeight: 60, fontFamily: 'var(--font-body)', marginBottom: 10 }}
            value={notes} onChange={e => setNotes(e.target.value)} placeholder="Optional notes" />
          {error && <p style={{ color: 'var(--bad)', fontSize: 12.5, marginBottom: 8 }}>{error}</p>}
          <Button onClick={submit} disabled={busy} style={{ fontSize: 12.5 }}>{busy ? 'Saving…' : 'Submit read'}</Button>
        </div>
      )}
    </div>
  );
}

function QcLocationsAdmin({ store }) {
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState('');
  const [busy, setBusy] = useState(false);

  const addLocation = async () => {
    if (!newName.trim()) return;
    setBusy(true);
    try {
      await store.addQcLocation({ name: newName.trim(), sortOrder: store.qcLocations.length + 1 });
      setNewName(''); setAdding(false);
    } finally {
      setBusy(false);
    }
  };

  const rename = async (loc) => {
    const name = window.prompt('Rename location', loc.name);
    if (!name || !name.trim() || name.trim() === loc.name) return;
    await store.updateQcLocation(loc.id, { name: name.trim() });
  };

  const toggleActive = async (loc) => {
    await store.updateQcLocation(loc.id, { active: !loc.active });
  };

  return (
    <div style={{ marginTop: 32 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
        <p style={{ fontSize: 13, fontWeight: 700, textTransform: 'uppercase', color: 'var(--text-muted)', margin: 0 }}>Environmental locations</p>
        <Button variant="ghost" onClick={() => setAdding(v => !v)} style={{ fontSize: 12, padding: '6px 10px' }}><Plus size={13} /> Add location</Button>
      </div>
      {adding && (
        <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
          <input style={inputStyle} value={newName} onChange={e => setNewName(e.target.value)} placeholder="Location name" />
          <Button onClick={addLocation} disabled={!newName.trim() || busy} style={{ fontSize: 12.5 }}>{busy ? '…' : 'Add'}</Button>
        </div>
      )}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {[...store.qcLocations].sort((a, b) => a.sort_order - b.sort_order).map(loc => (
          <Card key={loc.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 16px' }}>
            <span style={{ fontSize: 13.5, fontWeight: 600, opacity: loc.active ? 1 : 0.5 }}>{loc.name}</span>
            <div style={{ display: 'flex', gap: 8 }}>
              <Button variant="ghost" onClick={() => rename(loc)} style={{ fontSize: 11.5, padding: '5px 9px' }}>Rename</Button>
              <Button variant="ghost" onClick={() => toggleActive(loc)} style={{ fontSize: 11.5, padding: '5px 9px' }}>{loc.active ? 'Deactivate' : 'Activate'}</Button>
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
}

function QcView({ store }) {
  const [showLogModal, setShowLogModal] = useState(false);

  const rows = useMemo(() => {
    return store.qcTests
      .map(t => {
        const sample = store.qcSamples.find(s => s.id === t.sample_id);
        return sample ? { ...t, sample } : null;
      })
      .filter(Boolean)
      .sort((a, b) => a.due_date.localeCompare(b.due_date));
  }, [store.qcTests, store.qcSamples]);

  const today = todayISO();
  const overdue = rows.filter(r => r.result === 'pending' && r.due_date < today);
  const dueSoon = rows.filter(r => r.result === 'pending' && r.due_date >= today && daysBetween(today, r.due_date) <= 2);

  const Group = ({ title, items }) => items.length > 0 && (
    <div style={{ marginBottom: 22 }}>
      <p style={{ fontSize: 12, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.5, color: 'var(--text-muted)', marginBottom: 10 }}>{title} · {items.length}</p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {items.map(r => <QcTestRow key={r.id} test={r} sample={r.sample} store={store} />)}
      </div>
    </div>
  );

  return (
    <div>
      <div className="header-row-stack" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
        <div>
          <h3 style={{ fontFamily: 'var(--font-display)', fontSize: 22, margin: '0 0 4px' }}>Log Sample</h3>
          <p style={{ color: 'var(--text-muted)', fontSize: 13.5, margin: 0 }}>FastOrange Wild Yeast + B Tube reads, due {QC_READ_DAYS} days after a sample is pulled.</p>
        </div>
        <Button onClick={() => setShowLogModal(true)}><Plus size={15} /> Log sample</Button>
      </div>

      {overdue.length === 0 && dueSoon.length === 0 && <p style={{ color: 'var(--text-muted)' }}>Nothing needs urgent attention right now — check Incubating for everything still pending.</p>}
      <Group title="Overdue" items={overdue} />
      <Group title="Due within 2 days" items={dueSoon} />

      {showLogModal && <LogQcSampleModal store={store} onClose={() => setShowLogModal(false)} />}
    </div>
  );
}

function TestTubeIcon({ status }) {
  const fill = status === 'overdue' ? 'var(--bad)' : status === 'soon' ? 'var(--accent)' : 'var(--teal)';
  return (
    <svg width="30" height="64" viewBox="0 0 30 64">
      <rect x="7" y="2" width="16" height="6" rx="2" fill="var(--line)" />
      <path d="M9 8 L9 46 A6 6 0 0 0 21 46 L21 8" fill="none" stroke="var(--line)" strokeWidth="2" strokeLinecap="round" />
      <path d="M9.5 24 L9.5 46 A5.5 5.5 0 0 0 20.5 46 L20.5 24 Z" fill={fill} opacity="0.85" />
    </svg>
  );
}

function IncubatingView({ store }) {
  const pending = useMemo(() => {
    return store.qcTests
      .filter(t => t.result === 'pending')
      .map(t => {
        const sample = store.qcSamples.find(s => s.id === t.sample_id);
        return sample ? { ...t, sample } : null;
      })
      .filter(Boolean)
      .sort((a, b) => a.due_date.localeCompare(b.due_date));
  }, [store.qcTests, store.qcSamples]);

  const today = todayISO();
  const statusFor = (dueDate) => {
    const days = daysBetween(today, dueDate);
    if (days < 0) return 'overdue';
    if (days <= 2) return 'soon';
    return 'upcoming';
  };

  const handleDelete = async (sampleId) => {
    if (!window.confirm('Delete this sample and both its tests? This cannot be undone.')) return;
    try {
      await store.deleteQcSample(sampleId);
    } catch (e) {
      alert(e.message || 'Could not delete — try again.');
    }
  };

  return (
    <div>
      <h3 style={{ fontFamily: 'var(--font-display)', fontSize: 22, margin: '0 0 4px' }}>Incubating</h3>
      <p style={{ color: 'var(--text-muted)', fontSize: 13.5, margin: '0 0 24px' }}>Every FastOrange read still pending, at a glance.</p>
      {pending.length === 0 ? (
        <p style={{ color: 'var(--text-muted)' }}>Nothing incubating right now.</p>
      ) : (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 22 }}>
          {pending.map(t => {
            const status = statusFor(t.due_date);
            const days = daysBetween(today, t.due_date);
            return (
              <div key={t.id} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', width: 130, background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: 10, padding: '14px 10px 10px' }}>
                <TestTubeIcon status={status} />
                <p style={{ margin: '8px 0 0', fontSize: 12, fontWeight: 600, textAlign: 'center', lineHeight: 1.3 }}>{qcSampleLabel(t.sample, store)}</p>
                <p style={{ margin: '2px 0 0', fontSize: 11, color: 'var(--text-muted)', textAlign: 'center' }}>{QC_TEST_LABELS[t.test_type]}</p>
                <p style={{ margin: '2px 0 8px', fontSize: 11, fontFamily: 'var(--font-mono)', fontWeight: 700, color: status === 'overdue' ? 'var(--bad)' : status === 'soon' ? 'var(--accent)' : 'var(--text-faint)' }}>
                  {days < 0 ? `${Math.abs(days)}d overdue` : days === 0 ? 'due today' : `${days}d left`}
                </p>
                <Button variant="danger" onClick={() => handleDelete(t.sample.id)} style={{ fontSize: 10.5, padding: '4px 8px' }}><X size={11} /></Button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function exportQcResultsCSV(store) {
  const rows = store.qcTests
    .slice()
    .sort((a, b) => (a.due_date || '').localeCompare(b.due_date || ''))
    .map(t => {
      const sample = store.qcSamples.find(s => s.id === t.sample_id);
      return {
        'Sample Type': sample ? sample.sample_type : '',
        Sample: qcSampleLabel(sample, store),
        'Pulled Date': sample ? sample.pulled_date : '',
        'Pulled By': sample ? store.profileName(sample.pulled_by) : '',
        'Test Type': QC_TEST_LABELS[t.test_type] || t.test_type,
        'Due Date': t.due_date,
        Result: t.result,
        'Read Date': t.read_date || '',
        'Read By': t.read_by ? store.profileName(t.read_by) : '',
        Notes: t.notes || '',
      };
    });
  const csv = Papa.unparse(rows);
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `qc-results-export-${todayISO()}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

function computeLocationPositiveRates(store) {
  const byLocation = {};
  store.qcTests.forEach(t => {
    if (t.result === 'pending') return;
    const sample = store.qcSamples.find(s => s.id === t.sample_id);
    if (!sample || !sample.location_id) return;
    if (!byLocation[sample.location_id]) byLocation[sample.location_id] = { total: 0, positive: 0 };
    byLocation[sample.location_id].total++;
    if (t.result === 'positive') byLocation[sample.location_id].positive++;
  });

  return Object.entries(byLocation)
    .map(([locationId, d]) => {
      const loc = store.qcLocations.find(l => l.id === locationId);
      return { locationId, name: loc ? loc.name : 'Unknown location', total: d.total, positive: d.positive, rate: d.positive / d.total };
    })
    .sort((a, b) => b.rate - a.rate);
}

function QcLocationTrends({ store }) {
  const rows = useMemo(() => computeLocationPositiveRates(store), [store.qcTests, store.qcSamples, store.qcLocations]);
  const maxRate = Math.max(0.01, ...rows.map(r => r.rate));

  return (
    <Card style={{ marginTop: 20 }}>
      <p style={{ margin: '0 0 4px', fontSize: 13, fontWeight: 700, textTransform: 'uppercase', color: 'var(--text-muted)' }}>Positive rate by location</p>
      <p style={{ margin: '0 0 16px', fontSize: 12.5, color: 'var(--text-faint)' }}>Across environmental and in-process samples with a location set. A recurring pattern here usually points at a sanitation or process issue, not a one-off.</p>
      {rows.length === 0 ? (
        <p style={{ color: 'var(--text-muted)', fontSize: 13.5 }}>No location-tagged results yet.</p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {rows.map(r => (
            <div key={r.locationId}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                <span style={{ fontSize: 13, fontWeight: 600 }}>{r.name}</span>
                <span style={{ fontSize: 12, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
                  {r.positive}/{r.total} positive · {Math.round(r.rate * 100)}%
                </span>
              </div>
              <div style={{ height: 6, background: 'var(--surface-2)', borderRadius: 3, overflow: 'hidden' }}>
                <div style={{ width: `${(r.rate / maxRate) * 100}%`, height: '100%', background: r.rate >= 0.2 ? 'var(--bad)' : 'var(--accent)' }} />
              </div>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

function QcDashboard({ store }) {
  const allTests = store.qcTests;
  const pending = allTests.filter(t => t.result === 'pending').length;
  const positive = allTests.filter(t => t.result === 'positive').length;
  const today = todayISO();
  const overdue = allTests.filter(t => t.result === 'pending' && t.due_date < today).length;

  const bySampleType = useMemo(() => {
    const counts = { batch: 0, in_process: 0, environmental: 0 };
    store.qcSamples.forEach(s => { if (counts[s.sample_type] != null) counts[s.sample_type]++; });
    return counts;
  }, [store.qcSamples]);

  const recentPositives = useMemo(() => {
    return allTests
      .filter(t => t.result === 'positive')
      .sort((a, b) => (b.read_date || '').localeCompare(a.read_date || ''))
      .slice(0, 10)
      .map(t => ({ ...t, sample: store.qcSamples.find(s => s.id === t.sample_id) }));
  }, [allTests, store.qcSamples]);

  const stat = (label, value, tone) => (
    <Card style={{ flex: 1 }}>
      <p style={{ margin: '0 0 6px', fontSize: 12, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.4 }}>{label}</p>
      <p style={{ margin: 0, fontSize: 30, fontFamily: 'var(--font-display)', color: tone || 'var(--text)' }}>{value}</p>
    </Card>
  );

  return (
    <div>
      <div className="header-row-stack" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
        <h3 style={{ fontFamily: 'var(--font-display)', fontSize: 22, margin: 0 }}>QC Dashboard</h3>
        <Button variant="ghost" onClick={() => exportQcResultsCSV(store)} disabled={store.qcTests.length === 0}>
          <Upload size={15} style={{ transform: 'rotate(180deg)' }} /> Export results (CSV)
        </Button>
      </div>
      <div className="dashboard-stats" style={{ display: 'flex', gap: 16, marginBottom: 24 }}>
        {stat('Samples logged', store.qcSamples.length)}
        {stat('Tests pending', pending)}
        {stat('Overdue', overdue, overdue > 0 ? 'var(--bad)' : 'var(--good)')}
        {stat('Positive results', positive, positive > 0 ? 'var(--bad)' : 'var(--good)')}
      </div>
      <Card style={{ marginBottom: 20 }}>
        <p style={{ margin: '0 0 14px', fontSize: 13, fontWeight: 700, textTransform: 'uppercase', color: 'var(--text-muted)' }}>Samples by source</p>
        <div style={{ display: 'flex', gap: 24 }}>
          <span style={{ fontSize: 13.5 }}><strong>{bySampleType.batch}</strong> packaged batch</span>
          <span style={{ fontSize: 13.5 }}><strong>{bySampleType.in_process}</strong> in-process</span>
          <span style={{ fontSize: 13.5 }}><strong>{bySampleType.environmental}</strong> environmental</span>
        </div>
      </Card>
      <Card>
        <p style={{ margin: '0 0 14px', fontSize: 13, fontWeight: 700, textTransform: 'uppercase', color: 'var(--text-muted)' }}>Recent positive results</p>
        {recentPositives.length === 0 ? (
          <p style={{ color: 'var(--text-muted)', fontSize: 13.5 }}>No positives logged — clean record so far.</p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {recentPositives.map(t => (
              <div key={t.id} style={{ display: 'flex', justifyContent: 'space-between', borderBottom: '1px solid var(--line)', paddingBottom: 6 }}>
                <span style={{ fontSize: 13 }}>{qcSampleLabel(t.sample, store)} <span style={{ color: 'var(--text-faint)' }}>· {QC_TEST_LABELS[t.test_type]}</span></span>
                <span style={{ fontSize: 12, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>{t.read_date}</span>
              </div>
            ))}
          </div>
        )}
      </Card>
      <QcLocationTrends store={store} />
    </div>
  );
}

function QcLocationsTab({ store }) {
  return (
    <div>
      <h3 style={{ fontFamily: 'var(--font-display)', fontSize: 22, margin: '0 0 4px' }}>Locations</h3>
      <p style={{ color: 'var(--text-muted)', fontSize: 13.5, margin: '0 0 20px' }}>Environmental sampling points and in-process sampling locations.</p>
      <QcLocationsAdmin store={store} />
    </div>
  );
}

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
      .filter(r => r.batchNumber && /^\d+$/.test(r.batchNumber) && r.skuName && CORE_BEERS.includes(r.skuName));
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
      <div className="modal-card" style={{ background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: 12, padding: 24, width: 560 }}>
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

function TeamManagement({ store, currentProfile }) {
  const [busyId, setBusyId] = useState(null);
  const sortedProfiles = useMemo(() => [...store.profiles].sort((a, b) => a.name.localeCompare(b.name)), [store.profiles]);

  const toggleRole = async (profile) => {
    const newRole = profile.role === 'lead' ? 'staff' : 'lead';
    if (!window.confirm(`Change ${profile.name} to ${newRole === 'lead' ? 'QA Lead' : 'Staff'}?`)) return;
    setBusyId(profile.id);
    try {
      await store.updateProfileRole(profile.id, newRole);
    } catch (e) {
      alert(e.message || 'Could not update — try again.');
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div>
      <h3 style={{ fontFamily: 'var(--font-display)', fontSize: 22, margin: '0 0 4px' }}>Team</h3>
      <p style={{ color: 'var(--text-muted)', fontSize: 13.5, margin: '0 0 20px' }}>Manage who has QA lead access. You can't change your own role here — ask another lead if needed.</p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {sortedProfiles.map(p => (
          <Card key={p.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '14px 18px' }}>
            <div>
              <p style={{ margin: 0, fontWeight: 600, fontSize: 14 }}>{p.name} {p.id === currentProfile.id && <span style={{ color: 'var(--text-faint)', fontWeight: 400 }}>(you)</span>}</p>
              <p style={{ margin: '2px 0 0', fontSize: 12, color: 'var(--text-muted)' }}>{p.email}</p>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <Pill tone={p.role === 'lead' ? 'good' : 'neutral'}>{p.role === 'lead' ? 'QA Lead' : 'Staff'}</Pill>
              {p.id !== currentProfile.id && (
                <Button variant="ghost" onClick={() => toggleRole(p)} disabled={busyId === p.id} style={{ fontSize: 12, padding: '6px 10px' }}>
                  {busyId === p.id ? '…' : `Make ${p.role === 'lead' ? 'Staff' : 'QA Lead'}`}
                </Button>
              )}
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
}

function PackagingSignOffView({ store, currentProfile }) {
  const briteBatches = useMemo(() =>
    store.batches
      .filter(b => !b.package_date)
      .sort((a, b) => Number(b.batch_number) - Number(a.batch_number)),
    [store.batches]
  );

  const historyBatches = useMemo(() => {
    const batchIdsWithChecks = new Set(store.briteChecks.map(c => c.batch_id));
    return store.batches
      .filter(b => b.package_date && batchIdsWithChecks.has(b.id))
      .sort((a, b) => Number(b.batch_number) - Number(a.batch_number));
  }, [store.batches, store.briteChecks]);

  return (
    <div>
      <h3 style={{ fontFamily: 'var(--font-display)', fontSize: 22, margin: '0 0 4px' }}>Packaging sign off</h3>
      <p style={{ color: 'var(--text-muted)', fontSize: 13.5, margin: '0 0 20px' }}>Batches sitting in Brite tank, awaiting clearance to package. Taste and give it a green or red light.</p>

      {briteBatches.length === 0 ? (
        <p style={{ color: 'var(--text-muted)' }}>Nothing waiting on sign off right now.</p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          {briteBatches.map(b => (
            <BriteBatchCard key={b.id} batch={b} store={store} currentProfile={currentProfile} />
          ))}
        </div>
      )}

      {historyBatches.length > 0 && (
        <div style={{ marginTop: 32 }}>
          <p style={{ fontSize: 13, fontWeight: 700, textTransform: 'uppercase', color: 'var(--text-muted)', margin: '0 0 4px' }}>History — already packaged</p>
          <p style={{ fontSize: 12.5, color: 'var(--text-faint)', margin: '0 0 14px' }}>Past sign-off checks for batches that have since gone through packaging.</p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {historyBatches.map(b => (
              <BriteHistoryCard key={b.id} batch={b} store={store} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function BriteHistoryCard({ batch, store }) {
  const sku = store.skus.find(s => s.id === batch.sku_id);
  const checks = store.briteChecks.filter(c => c.batch_id === batch.id).sort((a, b) => b.created_at.localeCompare(a.created_at));
  const latest = checks[0];

  return (
    <Card>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 8 }}>
        <div>
          <p style={{ margin: 0, fontWeight: 700, fontSize: 14 }}>{batch.batch_number} — {sku ? sku.name : 'Unknown SKU'}</p>
          <p style={{ margin: '2px 0 0', fontSize: 12, color: 'var(--text-muted)' }}>Packaged {batch.package_date} · {checks.length} check{checks.length !== 1 ? 's' : ''}</p>
        </div>
        {latest && <Pill tone={latest.decision === 'green' ? 'good' : 'bad'}>{latest.decision === 'green' ? 'Green light' : 'Red light'}</Pill>}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {checks.map(c => (
          <div key={c.id} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12.5, borderTop: '1px solid var(--line)', paddingTop: 6 }}>
            <span style={{ color: 'var(--text-muted)' }}>{store.profileName(c.taster_id)} · {c.date}{c.notes ? ` — "${c.notes}"` : ''}</span>
            <Pill tone={c.decision === 'green' ? 'good' : 'bad'}>{c.decision === 'green' ? 'Green' : 'Red'}</Pill>
          </div>
        ))}
      </div>
    </Card>
  );
}

function BriteBatchCard({ batch, store, currentProfile }) {
  const sku = store.skus.find(s => s.id === batch.sku_id);
  const checks = store.briteChecks.filter(c => c.batch_id === batch.id).sort((a, b) => b.created_at.localeCompare(a.created_at));
  const latest = checks[0];

  const [logging, setLogging] = useState(false);
  const [decision, setDecision] = useState('green');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async () => {
    setBusy(true); setError('');
    try {
      await store.addBriteCheck({ batchId: batch.id, decision, notes });
      setLogging(false); setNotes(''); setDecision('green');
    } catch (e) {
      setError(e.message || 'Could not save — try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 10 }}>
        <div>
          <p style={{ margin: 0, fontWeight: 700, fontSize: 15 }}>{batch.batch_number} — {sku ? sku.name : 'Unknown SKU'}</p>
          <p style={{ margin: '2px 0 0', fontSize: 12.5, color: 'var(--text-muted)' }}>{checks.length} check{checks.length !== 1 ? 's' : ''} logged</p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {latest ? (
            <Pill tone={latest.decision === 'green' ? 'good' : 'bad'}>{latest.decision === 'green' ? 'Green light' : 'Red light'}</Pill>
          ) : (
            <Pill tone="warn">Pending</Pill>
          )}
          <Button variant="ghost" onClick={() => setLogging(v => !v)} style={{ fontSize: 12.5, padding: '7px 12px' }}>Log check</Button>
        </div>
      </div>

      {logging && (
        <div style={{ background: 'var(--surface-2)', borderRadius: 8, padding: 14, marginBottom: checks.length > 0 ? 12 : 0 }}>
          <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
            <button type="button" onClick={() => setDecision('green')} style={{
              flex: 1, padding: '9px 0', borderRadius: 7, fontWeight: 700, fontSize: 13, cursor: 'pointer',
              border: `1px solid ${decision === 'green' ? 'var(--good)' : 'var(--line)'}`,
              background: decision === 'green' ? 'rgba(114,149,107,0.18)' : 'transparent',
              color: decision === 'green' ? 'var(--good)' : 'var(--text-muted)',
            }}>Green light</button>
            <button type="button" onClick={() => setDecision('red')} style={{
              flex: 1, padding: '9px 0', borderRadius: 7, fontWeight: 700, fontSize: 13, cursor: 'pointer',
              border: `1px solid ${decision === 'red' ? 'var(--bad)' : 'var(--line)'}`,
              background: decision === 'red' ? 'rgba(184,71,43,0.18)' : 'transparent',
              color: decision === 'red' ? 'var(--bad)' : 'var(--text-muted)',
            }}>Red light</button>
          </div>
          <textarea style={{ ...inputStyle, minHeight: 60, fontFamily: 'var(--font-body)', marginBottom: 10 }}
            value={notes} onChange={e => setNotes(e.target.value)} placeholder="Optional notes" />
          {error && <p style={{ color: 'var(--bad)', fontSize: 12.5, marginBottom: 8 }}>{error}</p>}
          <Button onClick={submit} disabled={busy} style={{ fontSize: 12.5 }}>{busy ? 'Saving…' : 'Submit check'}</Button>
        </div>
      )}

      {checks.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {checks.map(c => (
            <div key={c.id} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12.5, borderTop: '1px solid var(--line)', paddingTop: 6 }}>
              <span style={{ color: 'var(--text-muted)' }}>{store.profileName(c.taster_id)} · {c.date}{c.notes ? ` — "${c.notes}"` : ''}</span>
              <Pill tone={c.decision === 'green' ? 'good' : 'bad'}>{c.decision === 'green' ? 'Green' : 'Red'}</Pill>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

function BatchReportModal({ batch, store, onClose }) {
  const sku = store.skus.find(s => s.id === batch.sku_id);
  const target = sku ? normalizeTarget(sku.target) : null;
  const allSessions = store.sessions.filter(s => s.batch_id === batch.id).sort((a, b) => a.date.localeCompare(b.date));
  const ttSessions = allSessions.filter(s => s.tasting_type === 'ttt');
  const checkpoints = store.retention.filter(r => r.batch_id === batch.id).sort((a, b) => a.days - b.days);
  const briteChecks = store.briteChecks.filter(c => c.batch_id === batch.id).sort((a, b) => a.created_at.localeCompare(b.created_at));
  const qcSamplesForBatch = store.qcSamples.filter(s => s.batch_id === batch.id).sort((a, b) => a.pulled_date.localeCompare(b.pulled_date));

  const avgTtScores = (section) => {
    const out = {};
    TRAIT_TAXONOMY[section].forEach(g => g.traits.forEach(t => {
      const id = traitId(g.category, t);
      const vals = ttSessions.map(s => s.scores?.[section]?.[id]).filter(v => v != null);
      out[id] = vals.length > 0 ? vals.reduce((a, c) => a + c, 0) / vals.length : null;
    }));
    return out;
  };

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'flex-start', justifyContent: 'center', zIndex: 60, padding: '32px 20px', overflowY: 'auto' }}>
      <div className="modal-card" style={{ background: 'var(--surface)', border: '1px solid var(--line)', borderRadius: 12, padding: 32, width: 760, maxWidth: '100%' }}>
        <div className="no-print header-row-stack" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
          <Button variant="ghost" onClick={onClose}><X size={15} /> Close</Button>
          <Button onClick={() => window.print()}><Upload size={15} style={{ transform: 'rotate(180deg)' }} /> Print / Save as PDF</Button>
        </div>

        <div id="batch-report-printable">
          <div style={{ borderBottom: '2px solid var(--accent)', paddingBottom: 14, marginBottom: 20 }}>
            <p style={{ margin: 0, fontSize: 11, color: 'var(--text-faint)', textTransform: 'uppercase', letterSpacing: 0.5, fontFamily: 'var(--font-mono)' }}>Batch QA Report</p>
            <h2 style={{ margin: '2px 0 4px', fontFamily: 'var(--font-display)', fontSize: 26 }}>{batch.batch_number} — {sku ? sku.name : 'Unknown SKU'}</h2>
            <p style={{ margin: 0, fontSize: 13, color: 'var(--text-muted)' }}>
              {sku ? `${sku.style} · ${sku.abv}% ABV` : ''} · {batch.format} · Packaged {batch.package_date || 'not yet packaged'}
            </p>
          </div>

          {briteChecks.length > 0 && (
            <div style={{ marginBottom: 20 }}>
              <p style={{ fontSize: 12, fontWeight: 700, textTransform: 'uppercase', color: 'var(--text-muted)', marginBottom: 8 }}>Packaging sign off</p>
              {briteChecks.map(c => (
                <p key={c.id} style={{ margin: '0 0 4px', fontSize: 13 }}>
                  {c.date} — {store.profileName(c.taster_id)}: <strong style={{ color: c.decision === 'green' ? 'var(--good)' : 'var(--bad)' }}>{c.decision === 'green' ? 'Green light' : 'Red light'}</strong>
                  {c.notes ? ` — "${c.notes}"` : ''}
                </p>
              ))}
            </div>
          )}

          {sku && (
            <div className="responsive-grid-2" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20, marginBottom: 20 }}>
              {Object.keys(SECTION_LABELS).map(sec => (
                <div key={sec}>
                  <p style={{ margin: '0 0 4px', fontSize: 11, fontWeight: 700, color: 'var(--text-faint)', textTransform: 'uppercase', textAlign: 'center' }}>{SECTION_LABELS[sec]} (avg vs target)</p>
                  <TraitSpiderChart section={sec} target={target[sec]} actual={avgTtScores(sec)} height={260} />
                </div>
              ))}
            </div>
          )}

          <div style={{ marginBottom: 20 }}>
            <p style={{ fontSize: 12, fontWeight: 700, textTransform: 'uppercase', color: 'var(--text-muted)', marginBottom: 8 }}>Retention schedule</p>
            {checkpoints.length === 0 ? <p style={{ fontSize: 13, color: 'var(--text-muted)' }}>No retention checkpoints.</p> : (
              <div style={{ display: 'flex', gap: 8 }}>
                {checkpoints.map(c => (
                  <span key={c.id} style={{ fontSize: 12, fontFamily: 'var(--font-mono)', padding: '4px 10px', borderRadius: 5, background: c.assessed ? 'rgba(114,149,107,0.16)' : 'var(--surface-2)', color: c.assessed ? 'var(--good)' : 'var(--text-muted)' }}>
                    Day {c.days} — {c.assessed ? 'Assessed' : `due ${c.due_date}`}
                  </span>
                ))}
              </div>
            )}
          </div>

          {qcSamplesForBatch.length > 0 && (
            <div style={{ marginBottom: 20 }}>
              <p style={{ fontSize: 12, fontWeight: 700, textTransform: 'uppercase', color: 'var(--text-muted)', marginBottom: 8 }}>QC / Micro results</p>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {qcSamplesForBatch.map(s => {
                  const tests = store.qcTests.filter(t => t.sample_id === s.id);
                  return (
                    <div key={s.id} style={{ borderBottom: '1px solid var(--line)', paddingBottom: 8 }}>
                      <p style={{ margin: '0 0 4px', fontSize: 13, fontWeight: 600 }}>
                        {s.sample_type === 'in_process' ? 'In-process' : 'Packaged'} sample · pulled {s.pulled_date}
                      </p>
                      <div style={{ display: 'flex', gap: 8 }}>
                        {tests.map(t => (
                          <span key={t.id} style={{ fontSize: 12, fontFamily: 'var(--font-mono)', padding: '4px 10px', borderRadius: 5, background: t.result === 'positive' ? 'rgba(184,71,43,0.16)' : t.result === 'negative' ? 'rgba(114,149,107,0.16)' : 'var(--surface-2)', color: t.result === 'positive' ? 'var(--bad)' : t.result === 'negative' ? 'var(--good)' : 'var(--text-muted)' }}>
                            {QC_TEST_LABELS[t.test_type]} — {t.result === 'pending' ? `due ${t.due_date}` : t.result}
                          </span>
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          <div>
            <p style={{ fontSize: 12, fontWeight: 700, textTransform: 'uppercase', color: 'var(--text-muted)', marginBottom: 8 }}>All tastings ({allSessions.length})</p>
            {allSessions.length === 0 ? <p style={{ fontSize: 13, color: 'var(--text-muted)' }}>No tastings logged yet.</p> : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {allSessions.map(s => (
                  <div key={s.id} style={{ borderBottom: '1px solid var(--line)', paddingBottom: 8 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                      <span style={{ fontSize: 13, fontWeight: 600 }}>{s.date} — {store.profileName(s.taster_id)} ({s.tasting_type === 'retention' ? 'Retention' : 'TTT'})</span>
                      <Pill tone={s.overall === 'pass' ? 'good' : s.overall === 'flag' ? 'warn' : 'bad'}>{s.overall}</Pill>
                    </div>
                    {(s.off_flavors || []).length > 0 && <p style={{ margin: '4px 0 0', fontSize: 12, color: 'var(--bad)' }}>{s.off_flavors.map(f => `${f.flavor} (${f.intensity}/5)`).join(', ')}</p>}
                    {s.notes && <p style={{ margin: '4px 0 0', fontSize: 12, color: 'var(--text-muted)' }}>"{s.notes}"</p>}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function SearchView({ store }) {
  const [query, setQuery] = useState('');
  const [reportBatch, setReportBatch] = useState(null);
  const q = query.trim().toLowerCase();

  const matchingBatches = useMemo(() => {
    if (!q) return [];
    return store.batches
      .filter(b => {
        const sku = store.skus.find(s => s.id === b.sku_id);
        return b.batch_number.toLowerCase().includes(q) || (sku && sku.name.toLowerCase().includes(q));
      })
      .sort((a, b) => Number(b.batch_number) - Number(a.batch_number))
      .slice(0, 30);
  }, [q, store.batches, store.skus]);

  const matchingTastings = useMemo(() => {
    if (!q) return [];
    return store.sessions
      .filter(s => {
        const batch = store.batches.find(b => b.id === s.batch_id);
        const sku = batch ? store.skus.find(x => x.id === batch.sku_id) : null;
        const hay = [
          batch ? batch.batch_number : '',
          sku ? sku.name : '',
          store.profileName(s.taster_id),
          s.notes || '',
          ...(s.off_flavors || []).map(f => f.flavor),
        ].join(' ').toLowerCase();
        return hay.includes(q);
      })
      .sort((a, b) => b.date.localeCompare(a.date))
      .slice(0, 30);
  }, [q, store.sessions, store.batches, store.skus]);

  return (
    <div>
      <h3 style={{ fontFamily: 'var(--font-display)', fontSize: 22, margin: '0 0 4px' }}>Search</h3>
      <p style={{ color: 'var(--text-muted)', fontSize: 13.5, margin: '0 0 20px' }}>Find a batch or tasting by batch number, SKU, taster, notes, or off-flavor.</p>
      <input
        style={{ ...inputStyle, marginBottom: 20, fontSize: 15, padding: '12px 14px' }}
        value={query} onChange={e => setQuery(e.target.value)}
        placeholder="e.g. 385, Kolsch, diacetyl, Sarah…" autoFocus
      />

      {reportBatch && <BatchReportModal batch={reportBatch} store={store} onClose={() => setReportBatch(null)} />}

      {!q ? (
        <p style={{ color: 'var(--text-faint)', fontSize: 13.5 }}>Start typing to search.</p>
      ) : (
        <>
          <Card style={{ marginBottom: 16 }}>
            <p style={{ margin: '0 0 12px', fontSize: 13, fontWeight: 700, textTransform: 'uppercase', color: 'var(--text-muted)' }}>Batches ({matchingBatches.length})</p>
            {matchingBatches.length === 0 ? <p style={{ color: 'var(--text-muted)', fontSize: 13.5 }}>No matching batches.</p> : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {matchingBatches.map(b => {
                  const sku = store.skus.find(s => s.id === b.sku_id);
                  return (
                    <div key={b.id} onClick={() => setReportBatch(b)} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 12px', background: 'var(--surface-2)', borderRadius: 6, cursor: 'pointer' }}>
                      <span style={{ fontSize: 13.5 }}><strong>{b.batch_number}</strong> — {sku ? sku.name : 'Unknown SKU'}</span>
                      <span style={{ fontSize: 11.5, color: 'var(--text-faint)', fontFamily: 'var(--font-mono)' }}>{b.package_date ? `packaged ${b.package_date}` : 'in brite tank'}</span>
                    </div>
                  );
                })}
              </div>
            )}
          </Card>

          <Card>
            <p style={{ margin: '0 0 12px', fontSize: 13, fontWeight: 700, textTransform: 'uppercase', color: 'var(--text-muted)' }}>Tastings ({matchingTastings.length})</p>
            {matchingTastings.length === 0 ? <p style={{ color: 'var(--text-muted)', fontSize: 13.5 }}>No matching tastings.</p> : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {matchingTastings.map(s => {
                  const batch = store.batches.find(b => b.id === s.batch_id);
                  const sku = batch ? store.skus.find(x => x.id === batch.sku_id) : null;
                  return (
                    <div key={s.id} style={{ borderBottom: '1px solid var(--line)', paddingBottom: 8 }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <span style={{ fontSize: 13, fontWeight: 600 }}>{batch ? batch.batch_number : '—'} — {sku ? sku.name : ''} <span style={{ fontWeight: 400, color: 'var(--text-muted)' }}>· {s.date} · {store.profileName(s.taster_id)} · {s.tasting_type === 'retention' ? 'Retention' : 'TTT'}</span></span>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                          <Pill tone={s.overall === 'pass' ? 'good' : s.overall === 'flag' ? 'warn' : 'bad'}>{s.overall}</Pill>
                          {batch && <Button variant="ghost" onClick={() => setReportBatch(batch)} style={{ fontSize: 11, padding: '4px 8px' }}>View batch</Button>}
                        </div>
                      </div>
                      {(s.off_flavors || []).length > 0 && <p style={{ margin: '4px 0 0', fontSize: 12, color: 'var(--bad)' }}>{s.off_flavors.map(f => `${f.flavor} (${f.intensity}/5)`).join(', ')}</p>}
                      {s.notes && <p style={{ margin: '4px 0 0', fontSize: 12, color: 'var(--text-muted)' }}>"{s.notes}"</p>}
                    </div>
                  );
                })}
              </div>
            )}
          </Card>
        </>
      )}
    </div>
  );
}

function BatchesView({ store, isLead }) {
  const [showNew, setShowNew] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [reportBatch, setReportBatch] = useState(null);
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
      <div className="header-row-stack" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
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
      {reportBatch && <BatchReportModal batch={reportBatch} store={store} onClose={() => setReportBatch(null)} />}

      {showNew && (
        <Card style={{ marginBottom: 20 }}>
          <div className="batch-form-grid" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr auto', gap: 12, alignItems: 'end' }}>
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
        {store.batches.filter(b => b.package_date).map(b => {
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
                <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                  <Pill>{sessions.length} tasting{sessions.length !== 1 ? 's' : ''}</Pill>
                  {flagged > 0 && <Pill tone="bad">{flagged} flagged</Pill>}
                  <Button variant="ghost" onClick={() => setReportBatch(b)} style={{ padding: '5px 10px', fontSize: 11.5 }}>Report</Button>
                </div>
              </div>
              <div style={{ display: 'flex', gap: 6, marginTop: 10 }}>
                {checkpoints.map(r => (
                  <span key={r.id} title={`Day ${r.days} — ${r.due_date}`} style={{ fontSize: 11, fontFamily: 'var(--font-mono)', padding: '3px 8px', borderRadius: 4, background: r.assessed ? 'rgba(114,149,107,0.16)' : 'var(--surface-2)', color: r.assessed ? 'var(--good)' : 'var(--text-faint)' }}>D{r.days} {r.assessed ? '✓' : ''}</span>
                ))}
              </div>
            </Card>
          );
        })}
      </div>
    </div>
  );
}

function SkuEditor({ sku, onCancel, onSave, busy }) {
  const [s, setS] = useState({ ...sku, target: normalizeTarget(sku.target) });
  const [activeSection, setActiveSection] = useState('aroma');
  const setTraitTarget = (section, id, v) => setS(x => ({ ...x, target: { ...x.target, [section]: { ...x.target[section], [id]: v } } }));

  return (
    <div className="responsive-grid-2" style={{ display: 'grid', gridTemplateColumns: '1.15fr 0.85fr', gap: 24 }}>
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
              background: activeSection === sec ? 'rgba(243,112,58,0.16)' : 'transparent',
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
      <div className="header-row-stack" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
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
                background: previewSection === sec ? 'rgba(243,112,58,0.16)' : 'transparent',
                color: previewSection === sec ? 'var(--accent)' : 'var(--text-muted)',
              }}>{SECTION_LABELS[sec]}</button>
            ))}
          </div>
        </div>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: 16 }}>
        {store.skus.filter(sku => CORE_BEERS.includes(sku.name)).map(sku => {
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
        Type: s.tasting_type === 'retention' ? 'Retention' : 'TTT',
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

function TrendsView({ store }) {
  const [skuId, setSkuId] = useState('');
  useEffect(() => {
    if (!skuId && store.skus.length > 0) {
      const core = store.skus.find(s => CORE_BEERS.includes(s.name));
      setSkuId((core || store.skus[0]).id);
    }
  }, [store.skus]);

  const sku = store.skus.find(s => s.id === skuId);
  const ttSessions = useMemo(() => store.sessions.filter(s => s.tasting_type === 'ttt'), [store.sessions]);

  const batchSeries = useMemo(() => {
    if (!sku) return [];
    const target = normalizeTarget(sku.target);
    const skuBatches = store.batches
      .filter(b => b.sku_id === sku.id)
      .sort((a, b) => (a.package_date || '').localeCompare(b.package_date || '') || Number(a.batch_number) - Number(b.batch_number));

    const avgDeviationForBatch = (sessions, section) => {
      const ids = TRAIT_TAXONOMY[section].flatMap(g => g.traits.map(t => traitId(g.category, t)));
      let sum = 0, count = 0;
      ids.forEach(id => {
        const targetVal = target[section][id] ?? 1;
        const vals = sessions.map(s => s.scores?.[section]?.[id]).filter(v => v != null);
        if (vals.length === 0) return;
        const avgScore = vals.reduce((a, c) => a + c, 0) / vals.length;
        sum += Math.abs(avgScore - targetVal);
        count++;
      });
      return count > 0 ? sum / count : 0;
    };

    return skuBatches
      .map(b => {
        const sessions = ttSessions.filter(s => s.batch_id === b.id);
        if (sessions.length === 0) return null;
        return {
          batch: b.batch_number,
          'Aroma deviation': Number(avgDeviationForBatch(sessions, 'aroma').toFixed(2)),
          'Flavour & Body deviation': Number(avgDeviationForBatch(sessions, 'flavor').toFixed(2)),
          tastingCount: sessions.length,
        };
      })
      .filter(Boolean);
  }, [sku, store.batches, ttSessions]);

  const topDeviators = useMemo(() => {
    if (!sku) return [];
    const target = normalizeTarget(sku.target);
    const skuBatchIds = new Set(store.batches.filter(b => b.sku_id === sku.id).map(b => b.id));
    const sessions = ttSessions.filter(s => skuBatchIds.has(s.batch_id));

    const acc = {};
    ['aroma', 'flavor'].forEach(section => {
      TRAIT_TAXONOMY[section].forEach(g => g.traits.forEach(t => {
        const id = traitId(g.category, t);
        acc[`${section}:${id}`] = { section, label: `${g.category}: ${t}`, sum: 0, count: 0 };
      }));
    });

    sessions.forEach(s => {
      ['aroma', 'flavor'].forEach(section => {
        const scores = s.scores?.[section] || {};
        Object.entries(scores).forEach(([id, val]) => {
          const key = `${section}:${id}`;
          if (!acc[key]) return;
          const targetVal = target[section][id] ?? 1;
          acc[key].sum += Math.abs(val - targetVal);
          acc[key].count += 1;
        });
      });
    });

    return Object.values(acc)
      .filter(d => d.count > 0)
      .map(d => ({ ...d, avgDeviation: d.sum / d.count }))
      .sort((a, b) => b.avgDeviation - a.avgDeviation)
      .slice(0, 8);
  }, [sku, store.batches, ttSessions]);

  const [compareBatchIds, setCompareBatchIds] = useState([]);
  const [compareSection, setCompareSection] = useState('aroma');

  const skuBatchOptions = useMemo(() =>
    store.batches.filter(b => sku && b.sku_id === sku.id && b.package_date).sort((a, b) => Number(b.batch_number) - Number(a.batch_number)),
    [store.batches, sku]
  );

  useEffect(() => { setCompareBatchIds([]); }, [skuId]);

  const toggleCompare = (batchId) => setCompareBatchIds(prev => {
    if (prev.includes(batchId)) return prev.filter(id => id !== batchId);
    if (prev.length >= 3) return prev;
    return [...prev, batchId];
  });

  const compareSeries = useMemo(() => {
    return compareBatchIds.map(batchId => {
      const batch = store.batches.find(b => b.id === batchId);
      const batchSessions = ttSessions.filter(s => s.batch_id === batchId);
      const scores = {};
      TRAIT_TAXONOMY[compareSection].forEach(g => g.traits.forEach(t => {
        const id = traitId(g.category, t);
        const vals = batchSessions.map(s => s.scores?.[compareSection]?.[id]).filter(v => v != null);
        scores[id] = vals.length > 0 ? vals.reduce((a, c) => a + c, 0) / vals.length : 1;
      }));
      return { label: batch ? batch.batch_number : batchId, scores };
    });
  }, [compareBatchIds, ttSessions, compareSection, store.batches]);

  return (
    <div>
      <div className="header-row-stack" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
        <div>
          <h3 style={{ fontFamily: 'var(--font-display)', fontSize: 22, margin: '0 0 4px' }}>Trends</h3>
          <p style={{ color: 'var(--text-muted)', fontSize: 13.5, margin: 0 }}>How far off target each batch has run, over time. True to Type tastings only — retention tastings are excluded, since aging is expected to change a beer over time.</p>
        </div>
        <select style={{ ...inputStyle, width: 220 }} value={skuId} onChange={e => setSkuId(e.target.value)}>
          {store.skus.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
      </div>

      <Card style={{ marginBottom: 20 }}>
        <p style={{ margin: '0 0 14px', fontSize: 13, fontWeight: 700, textTransform: 'uppercase', color: 'var(--text-muted)' }}>Deviation from target by batch</p>
        {batchSeries.length < 2 ? (
          <p style={{ color: 'var(--text-muted)', fontSize: 13.5 }}>Need at least two tasted batches of this SKU to show a trend.</p>
        ) : (
          <ResponsiveContainer width="100%" height={320}>
            <LineChart data={batchSeries}>
              <CartesianGrid stroke="var(--line)" strokeDasharray="3 3" />
              <XAxis dataKey="batch" tick={{ fill: 'var(--text-muted)', fontSize: 11, fontFamily: 'var(--font-mono)' }} />
              <YAxis domain={[0, 8]} tick={{ fill: 'var(--text-muted)', fontSize: 11, fontFamily: 'var(--font-mono)' }} />
              <Tooltip contentStyle={{ background: 'var(--surface)', border: '1px solid var(--line)', fontSize: 12.5 }} />
              <Legend wrapperStyle={{ fontSize: 12, fontFamily: 'var(--font-body)' }} />
              <Line type="monotone" dataKey="Aroma deviation" stroke="var(--accent)" strokeWidth={2} dot={{ r: 3 }} />
              <Line type="monotone" dataKey="Flavour & Body deviation" stroke="var(--bad)" strokeWidth={2} dot={{ r: 3 }} />
            </LineChart>
          </ResponsiveContainer>
        )}
      </Card>

      <Card style={{ marginBottom: 20 }}>
        <p style={{ margin: '0 0 4px', fontSize: 13, fontWeight: 700, textTransform: 'uppercase', color: 'var(--text-muted)' }}>Biggest deviating traits</p>
        <p style={{ margin: '0 0 16px', fontSize: 12.5, color: 'var(--text-faint)' }}>Averaged across every tasting of {sku ? sku.name : 'this SKU'} — the traits most consistently off target.</p>
        {topDeviators.length === 0 ? (
          <p style={{ color: 'var(--text-muted)', fontSize: 13.5 }}>No tastings logged for this SKU yet.</p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {topDeviators.map(d => (
              <div key={d.label} style={{ display: 'flex', justifyContent: 'space-between', borderBottom: '1px solid var(--line)', paddingBottom: 6 }}>
                <span style={{ fontSize: 13 }}>{d.label} <span style={{ color: 'var(--text-faint)', fontSize: 11 }}>({SECTION_LABELS[d.section]})</span></span>
                <span style={{ fontSize: 12.5, fontFamily: 'var(--font-mono)', color: d.avgDeviation >= 3 ? 'var(--bad)' : 'var(--text-muted)' }}>±{d.avgDeviation.toFixed(1)}</span>
              </div>
            ))}
          </div>
        )}
      </Card>

      <Card>
        <p style={{ margin: '0 0 4px', fontSize: 13, fontWeight: 700, textTransform: 'uppercase', color: 'var(--text-muted)' }}>Compare batches</p>
        <p style={{ margin: '0 0 14px', fontSize: 12.5, color: 'var(--text-faint)' }}>Pick up to 3 batches of {sku ? sku.name : 'this SKU'} to overlay on one spider diagram.</p>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 16 }}>
          {skuBatchOptions.map(b => {
            const selected = compareBatchIds.includes(b.id);
            const disabled = !selected && compareBatchIds.length >= 3;
            return (
              <button key={b.id} type="button" disabled={disabled} onClick={() => toggleCompare(b.id)} style={{
                fontSize: 12, padding: '6px 10px', borderRadius: 20, cursor: disabled ? 'not-allowed' : 'pointer',
                border: `1px solid ${selected ? 'var(--accent)' : 'var(--line)'}`,
                background: selected ? 'rgba(243,112,58,0.16)' : 'transparent',
                color: selected ? 'var(--accent)' : disabled ? 'var(--text-faint)' : 'var(--text-muted)',
                opacity: disabled ? 0.5 : 1,
              }}>{b.batch_number}</button>
            );
          })}
          {skuBatchOptions.length === 0 && <p style={{ color: 'var(--text-muted)', fontSize: 13.5, margin: 0 }}>No packaged batches of this SKU yet.</p>}
        </div>

        {compareBatchIds.length > 0 && (
          <>
            <div style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
              {Object.keys(SECTION_LABELS).map(sec => (
                <button key={sec} type="button" onClick={() => setCompareSection(sec)} style={{
                  flex: 1, padding: '8px 0', borderRadius: 7, fontWeight: 700, fontSize: 12.5, cursor: 'pointer',
                  border: `1px solid ${compareSection === sec ? 'var(--accent)' : 'var(--line)'}`,
                  background: compareSection === sec ? 'rgba(243,112,58,0.16)' : 'transparent',
                  color: compareSection === sec ? 'var(--accent)' : 'var(--text-muted)',
                }}>{SECTION_LABELS[sec]}</button>
              ))}
            </div>
            <MultiBatchSpiderChart section={compareSection} target={sku ? normalizeTarget(sku.target)[compareSection] : null} series={compareSeries} height={400} />
          </>
        )}
      </Card>
    </div>
  );
}

function computeSkuHealth(sku, store) {
  const skuBatchIds = new Set(store.batches.filter(b => b.sku_id === sku.id).map(b => b.id));
  const allSessions = store.sessions.filter(s => skuBatchIds.has(s.batch_id));
  if (allSessions.length === 0) return null;

  const passRate = allSessions.filter(s => s.overall === 'pass').length / allSessions.length;
  const offFlavorRate = allSessions.filter(s => (s.off_flavors || []).length > 0).length / allSessions.length;

  const ttSessions = allSessions.filter(s => s.tasting_type === 'ttt');
  let avgDeviation = null;
  if (ttSessions.length > 0) {
    const target = normalizeTarget(sku.target);
    let sum = 0, count = 0;
    ['aroma', 'flavor'].forEach(section => {
      TRAIT_TAXONOMY[section].forEach(g => g.traits.forEach(t => {
        const id = traitId(g.category, t);
        const targetVal = target[section][id] ?? 1;
        const vals = ttSessions.map(s => s.scores?.[section]?.[id]).filter(v => v != null);
        if (vals.length === 0) return;
        const avgScore = vals.reduce((a, c) => a + c, 0) / vals.length;
        sum += Math.abs(avgScore - targetVal);
        count++;
      }));
    });
    avgDeviation = count > 0 ? sum / count : null;
  }

  const deviationScore = avgDeviation != null ? Math.max(0, 1 - Math.min(avgDeviation, 4) / 4) : null;
  const healthScore = deviationScore != null
    ? (passRate * 0.4 + deviationScore * 0.4 + (1 - offFlavorRate) * 0.2) * 100
    : (passRate * 0.7 + (1 - offFlavorRate) * 0.3) * 100;

  return { passRate, offFlavorRate, avgDeviation, healthScore, tastingCount: allSessions.length };
}

function SkuHealthScoreboard({ store }) {
  const rows = useMemo(() => {
    return store.skus
      .filter(s => CORE_BEERS.includes(s.name))
      .map(s => ({ sku: s, health: computeSkuHealth(s, store) }))
      .filter(r => r.health)
      .sort((a, b) => a.health.healthScore - b.health.healthScore);
  }, [store.skus, store.batches, store.sessions]);

  const scoreColor = (score) => score >= 80 ? 'var(--good)' : score >= 60 ? 'var(--accent)' : 'var(--bad)';

  return (
    <Card style={{ marginBottom: 20 }}>
      <p style={{ margin: '0 0 4px', fontSize: 13, fontWeight: 700, textTransform: 'uppercase', color: 'var(--text-muted)' }}>SKU health scoreboard</p>
      <p style={{ margin: '0 0 16px', fontSize: 12.5, color: 'var(--text-faint)' }}>Pass rate, on-target consistency (True to Type tastings only), and off-flavor frequency — blended into one score, worst first.</p>
      {rows.length === 0 ? (
        <p style={{ color: 'var(--text-muted)', fontSize: 13.5 }}>No tastings logged yet.</p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {rows.map(({ sku, health }) => (
            <div key={sku.id} style={{ display: 'grid', gridTemplateColumns: '1fr auto auto auto auto', gap: 16, alignItems: 'center', borderBottom: '1px solid var(--line)', paddingBottom: 8 }}>
              <span style={{ fontSize: 13.5, fontWeight: 600 }}>{sku.name}</span>
              <span style={{ fontSize: 11.5, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>{Math.round(health.passRate * 100)}% pass</span>
              <span style={{ fontSize: 11.5, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>{health.avgDeviation != null ? `±${health.avgDeviation.toFixed(1)} dev` : '— dev'}</span>
              <span style={{ fontSize: 11.5, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>{Math.round(health.offFlavorRate * 100)}% off-flavor</span>
              <span style={{ fontSize: 15, fontWeight: 700, fontFamily: 'var(--font-mono)', color: scoreColor(health.healthScore) }}>{Math.round(health.healthScore)}</span>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

function computeTasterCalibration(store) {
  const groups = {};
  store.sessions.forEach(s => {
    const key = `${s.batch_id}:${s.tasting_type}`;
    if (!groups[key]) groups[key] = [];
    groups[key].push(s);
  });

  const tasterStats = {};

  Object.values(groups).forEach(group => {
    if (group.length < 2) return;

    ['aroma', 'flavor'].forEach(section => {
      TRAIT_TAXONOMY[section].forEach(g => g.traits.forEach(t => {
        const id = traitId(g.category, t);
        const vals = group.map(s => ({ taster: s.taster_id, val: s.scores?.[section]?.[id] })).filter(v => v.val != null);
        if (vals.length < 2) return;
        const panelAvg = vals.reduce((a, c) => a + c.val, 0) / vals.length;
        vals.forEach(v => {
          if (!tasterStats[v.taster]) tasterStats[v.taster] = { sumSigned: 0, sumAbs: 0, count: 0 };
          const dev = v.val - panelAvg;
          tasterStats[v.taster].sumSigned += dev;
          tasterStats[v.taster].sumAbs += Math.abs(dev);
          tasterStats[v.taster].count++;
        });
      }));
    });
  });

  const MIN_SAMPLE = 20;
  return Object.entries(tasterStats)
    .map(([tasterId, s]) => ({
      tasterId,
      avgBias: s.sumSigned / s.count,
      avgAbsDeviation: s.sumAbs / s.count,
      sampleSize: s.count,
    }))
    .filter(r => r.sampleSize >= MIN_SAMPLE)
    .sort((a, b) => Math.abs(b.avgBias) - Math.abs(a.avgBias));
}

function TasterCalibration({ store }) {
  const rows = useMemo(() => computeTasterCalibration(store), [store.sessions]);

  return (
    <Card style={{ marginBottom: 20 }}>
      <p style={{ margin: '0 0 4px', fontSize: 13, fontWeight: 700, textTransform: 'uppercase', color: 'var(--text-muted)' }}>Taster calibration</p>
      <p style={{ margin: '0 0 16px', fontSize: 12.5, color: 'var(--text-faint)' }}>How each person's scores compare to the panel average, on batches multiple people tasted. Useful for training conversations — not a ranking.</p>
      {rows.length === 0 ? (
        <p style={{ color: 'var(--text-muted)', fontSize: 13.5 }}>Not enough overlapping tastings yet — this needs multiple people tasting the same batch to compare.</p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {rows.map(r => (
            <div key={r.tasterId} style={{ display: 'grid', gridTemplateColumns: '1fr auto auto', gap: 16, alignItems: 'center', borderBottom: '1px solid var(--line)', paddingBottom: 8 }}>
              <span style={{ fontSize: 13.5, fontWeight: 600 }}>{store.profileName(r.tasterId)}</span>
              <span style={{ fontSize: 11.5, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
                {r.avgBias > 0.15 ? `scores ~${r.avgBias.toFixed(1)} higher than panel` : r.avgBias < -0.15 ? `scores ~${Math.abs(r.avgBias).toFixed(1)} lower than panel` : 'close to panel average'}
              </span>
              <span style={{ fontSize: 11, color: 'var(--text-faint)', fontFamily: 'var(--font-mono)' }}>{r.sampleSize} comparable scores</span>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

function Dashboard({ store, onEditSession }) {
  const today = todayISO();
  const overdue = store.retention.filter(r => !r.assessed && r.due_date < today);
  const recent = [...store.sessions].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 8);
  const flaggedRecent = store.sessions.filter(s => s.overall !== 'pass').slice(-5).reverse();
  const [deletingId, setDeletingId] = useState(null);

  const handleDelete = async (s) => {
    if (!window.confirm('Delete this tasting? This cannot be undone.')) return;
    setDeletingId(s.id);
    try {
      await store.deleteSession(s.id);
    } catch (e) {
      alert(e.message || 'Could not delete — try again.');
    } finally {
      setDeletingId(null);
    }
  };

  const stat = (label, value, tone) => (
    <Card style={{ flex: 1 }}>
      <p style={{ margin: '0 0 6px', fontSize: 12, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.4 }}>{label}</p>
      <p style={{ margin: 0, fontSize: 30, fontFamily: 'var(--font-display)', color: tone || 'var(--text)' }}>{value}</p>
    </Card>
  );

  return (
    <div>
      <div className="header-row-stack" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
        <h3 style={{ fontFamily: 'var(--font-display)', fontSize: 22, margin: 0 }}>Dashboard</h3>
        <Button variant="ghost" onClick={() => exportSessionsCSV(store)} disabled={store.sessions.length === 0}>
          <Upload size={15} style={{ transform: 'rotate(180deg)' }} /> Export all tastings (CSV)
        </Button>
      </div>
      <div className="dashboard-stats" style={{ display: 'flex', gap: 16, marginBottom: 24 }}>
        {stat('SKUs tracked', store.skus.length)}
        {stat('Active batches', store.batches.filter(b => b.package_date).length)}
        {stat('Overdue retention', overdue.length, overdue.length > 0 ? 'var(--bad)' : 'var(--good)')}
        {stat('Total tastings logged', store.sessions.length)}
      </div>
      <SkuHealthScoreboard store={store} />
      <TasterCalibration store={store} />
      <div className="responsive-grid-2" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20 }}>
        <Card>
          <p style={{ margin: '0 0 14px', fontSize: 13, fontWeight: 700, textTransform: 'uppercase', color: 'var(--text-muted)' }}>Recent submissions</p>
          {recent.length === 0 && <p style={{ color: 'var(--text-muted)', fontSize: 13.5 }}>Nothing logged yet.</p>}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {recent.map(s => {
              const b = store.batches.find(x => x.id === s.batch_id);
              const bSku = b ? store.skus.find(x => x.id === b.sku_id) : null;
              return (
                <div key={s.id} style={{ display: 'flex', justifyContent: 'space-between', borderBottom: '1px solid var(--line)', paddingBottom: 8 }}>
                  <div>
                    <p style={{ margin: 0, fontSize: 13.5, fontWeight: 600 }}>{b ? `${b.batch_number} - ${bSku ? bSku.name : 'Unknown SKU'}` : '—'}</p>
                    <p style={{ margin: '2px 0 0', fontSize: 12, color: 'var(--text-muted)' }}>{store.profileName(s.taster_id)} · {s.date} · {s.tasting_type === 'retention' ? 'Retention' : 'TTT'}</p>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <Pill tone={s.overall === 'pass' ? 'good' : s.overall === 'flag' ? 'warn' : 'bad'}>{s.overall}</Pill>
                    <Button variant="ghost" onClick={() => onEditSession(s)} style={{ padding: '4px 8px', fontSize: 11 }}>Edit</Button>
                    <Button variant="danger" onClick={() => handleDelete(s)} disabled={deletingId === s.id} style={{ padding: '4px 8px', fontSize: 11 }}>{deletingId === s.id ? '…' : 'Delete'}</Button>
                  </div>
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
              const bSku = b ? store.skus.find(x => x.id === b.sku_id) : null;
              return (
                <div key={s.id} style={{ borderBottom: '1px solid var(--line)', paddingBottom: 8 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                    <p style={{ margin: 0, fontSize: 13.5, fontWeight: 600 }}>{b ? `${b.batch_number} - ${bSku ? bSku.name : 'Unknown SKU'}` : '—'}</p>
                    <div style={{ display: 'flex', gap: 6 }}>
                      <Pill>{s.tasting_type === 'retention' ? 'Retention' : 'TTT'}</Pill>
                      <Pill tone="bad">{s.overall}</Pill>
                    </div>
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

export default function App() {
  const [session, setSession] = useState(undefined);
  const [profile, setProfile] = useState(null);
  const [tab, setTab] = useState('sessions');
  const [presetBatchId, setPresetBatchId] = useState(null);
  const [presetTastingType, setPresetTastingType] = useState(null);
  const [activePanelId, setActivePanelId] = useState(null);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [appMode, setAppMode] = useState('sensory'); // 'sensory' | 'qc'
  const [editingSession, setEditingSession] = useState(null);

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

  const sensoryTabs = [
    { id: 'sessions', label: 'Sessions', icon: Calendar, allowed: true },
    { id: 'panels', label: 'Panels', icon: Users, allowed: true },
    { id: 'submit', label: 'Submit tasting', icon: ClipboardList, allowed: true },
    { id: 'brite', label: 'Packaging sign off', icon: Droplet, allowed: true },
    { id: 'retention', label: 'Retention queue', icon: Archive, allowed: isLead },
    { id: 'batches', label: 'Batches', icon: Beaker, allowed: isLead },
    { id: 'skus', label: 'TTT profiles', icon: Settings, allowed: true },
    { id: 'search', label: 'Search', icon: Search, allowed: true },
    { id: 'trends', label: 'Trends', icon: TrendingUp, allowed: isLead },
    { id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard, allowed: isLead },
    { id: 'team', label: 'Team', icon: UserCog, allowed: isLead },
  ];
  const qcTabs = [
    { id: 'qc', label: 'Log Sample', icon: FlaskConical, allowed: isLead },
    { id: 'incubating', label: 'Incubating', icon: TrendingUp, allowed: isLead },
    { id: 'qcDashboard', label: 'Dashboard', icon: LayoutDashboard, allowed: isLead },
    { id: 'qcLocations', label: 'Locations', icon: MapPin, allowed: isLead },
  ];
  const tabs = (appMode === 'qc' ? qcTabs : sensoryTabs).filter(t => t.allowed);

  useEffect(() => { if (!tabs.find(t => t.id === tab)) setTab(appMode === 'qc' ? 'qc' : 'panels'); }, [isLead, appMode]);

  const themeVars = {
    '--bg': '#F2EDE2', '--surface': '#FFFFFF', '--surface-2': '#ECE3D1', '--line': '#DDD2BA',
    '--text': '#141A24', '--text-muted': '#5F6B5A', '--text-faint': '#93998C',
    '--accent': '#F3703A', '--good': '#72956B', '--bad': '#B8472B',
    '--navy': '#141A24', '--forest': '#2F4534', '--teal': '#00687D', '--teal-dark': '#06282E', '--gold': '#BE9C5D',
    '--font-display': "'Fraunces', serif", '--font-body': "'Inter', sans-serif", '--font-mono': "'IBM Plex Mono', monospace",
  };

  if (session === undefined) {
    return <div style={{ ...themeVars, background: 'var(--bg)', minHeight: '100vh' }} />;
  }
  if (!session) {
    return <div style={themeVars}><AuthScreen /></div>;
  }
  if (!profile || (store.loading && !store.initialLoadDone)) {
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
        .mobile-nav-trigger { display: none; }
        .mobile-dropdown-list { display: contents; }
        input[type=range]::-webkit-slider-runnable-track { height: 4px; background: var(--line); border-radius: 2px; }
        input[type=range]::-webkit-slider-thumb { -webkit-appearance: none; margin-top: -6px; width: 16px; height: 16px; border-radius: 50%; background: currentColor; cursor: pointer; border: 2px solid var(--surface); }
        @media print {
          body * { visibility: hidden; }
          #batch-report-printable, #batch-report-printable * { visibility: visible; }
          #batch-report-printable { position: absolute; top: 0; left: 0; width: 100%; background: white; color: black; }
          .no-print { display: none !important; }
        }
        @media (max-width: 768px) {
          .app-header { padding: 12px 14px !important; }
          .app-shell { flex-direction: column !important; }
          .app-nav {
            width: 100% !important; border-right: none !important; border-bottom: 1px solid var(--line);
            padding: 10px 12px !important; position: relative;
          }
          .mobile-nav-trigger { display: flex !important; }
          .mobile-dropdown-list { display: none; }
          .mobile-dropdown-list.open {
            display: flex !important; flex-direction: column; position: absolute; top: 100%; left: 12px; right: 12px;
            background: var(--surface); border: 1px solid var(--line); border-radius: 8px; z-index: 40; padding: 6px;
            box-shadow: 0 10px 28px rgba(0,0,0,0.25); margin-top: 4px;
          }
          .app-main { padding: 14px !important; max-width: 100% !important; }
          .header-row-stack { flex-direction: column !important; align-items: flex-start !important; gap: 12px !important; }
          .header-row-stack > * { width: 100% !important; }
          .responsive-grid-2 { grid-template-columns: 1fr !important; }
          .modal-card { width: 92vw !important; max-width: 92vw !important; padding: 18px !important; }
          .batch-form-grid { grid-template-columns: 1fr 1fr !important; }
          .dashboard-stats { flex-wrap: wrap !important; }
          .dashboard-stats > * { flex: 1 1 45% !important; min-width: 130px; }
        }
      `}</style>

      <header className="app-header" style={{ background: 'var(--navy)', padding: '16px 28px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
          <img src="/logo-cream.png" alt="Margaret River Beer Co" style={{ height: 28, width: 'auto' }} />
          <div style={{ width: 1, height: 22, background: 'rgba(242,237,226,0.25)' }} />
          {isLead ? (
            <select
              value={appMode}
              onChange={e => {
                const m = e.target.value;
                setAppMode(m);
                setTab(m === 'qc' ? 'qc' : 'sessions');
                setPresetBatchId(null); setPresetTastingType(null); setActivePanelId(null); setEditingSession(null);
              }}
              style={{
                background: 'transparent', border: 'none', color: 'rgba(242,237,226,0.85)',
                fontSize: 11, fontFamily: 'var(--font-mono)', letterSpacing: 0.8, textTransform: 'uppercase',
                cursor: 'pointer', outline: 'none',
              }}
            >
              <option value="sensory" style={{ color: '#141A24' }}>Sensory Log</option>
              <option value="qc" style={{ color: '#141A24' }}>QC Log</option>
            </select>
          ) : (
            <p style={{ margin: 0, fontSize: 11, color: 'rgba(242,237,226,0.6)', fontFamily: 'var(--font-mono)', letterSpacing: 0.8, textTransform: 'uppercase' }}>Sensory Log</p>
          )}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <User size={15} color="rgba(242,237,226,0.6)" />
          <span style={{ fontSize: 13.5, color: 'var(--bg)' }}>{profile.name}</span>
          <Pill tone={isLead ? 'good' : 'neutral'}>{isLead ? 'QA Lead' : 'Staff'}</Pill>
          <Button variant="ghost" onClick={() => supabase.auth.signOut()} style={{ padding: '6px 10px', fontSize: 12, color: 'var(--bg)', borderColor: 'rgba(242,237,226,0.3)' }}><LogOut size={13} /> Sign out</Button>
        </div>
      </header>

      <div className="app-shell" style={{ display: 'flex' }}>
        <nav className="app-nav" style={{ width: 210, borderRight: '1px solid var(--line)', padding: '20px 12px', flexShrink: 0 }}>
          <button className="mobile-nav-trigger" onClick={() => setMobileNavOpen(v => !v)} style={{
            width: '100%', display: 'none', alignItems: 'center', justifyContent: 'space-between', gap: 10, padding: '10px 12px',
            borderRadius: 7, border: '1px solid var(--line)', cursor: 'pointer', fontSize: 13.5, fontWeight: 600,
            background: 'var(--surface)', color: 'var(--accent)',
          }}>
            <span style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              {(() => { const current = tabs.find(t => t.id === tab); const Icon = current ? current.icon : Calendar; return <Icon size={16} />; })()}
              {tabs.find(t => t.id === tab)?.label || 'Menu'}
            </span>
            <ChevronDown size={16} style={{ transform: mobileNavOpen ? 'rotate(180deg)' : 'none', transition: 'transform 0.15s' }} />
          </button>
          <div className={`mobile-dropdown-list${mobileNavOpen ? ' open' : ''}`}>
            {tabs.map(t => (
              <button key={t.id} onClick={() => { setTab(t.id); setPresetBatchId(null); setPresetTastingType(null); setActivePanelId(null); setEditingSession(null); setMobileNavOpen(false); }} style={{
                width: '100%', display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', marginBottom: 4,
                borderRadius: 7, border: 'none', cursor: 'pointer', textAlign: 'left', fontSize: 13.5, fontWeight: 600,
                background: tab === t.id ? 'var(--surface-2)' : 'transparent',
                color: tab === t.id ? 'var(--accent)' : 'var(--text-muted)',
              }}><t.icon size={16} /> {t.label}</button>
            ))}
          </div>
          {store.error && <p style={{ fontSize: 11, color: 'var(--bad)', marginTop: 16, padding: '0 12px' }}>{store.error}</p>}
        </nav>

        <main className="app-main" style={{ flex: 1, padding: '28px 32px', maxWidth: 1180 }}>
          {tab === 'sessions' && <SessionsView store={store} isLead={isLead} currentProfile={profile} onLogTasting={(bid, type, panelId) => { setPresetBatchId(bid); setPresetTastingType(type || null); setActivePanelId(panelId || null); setTab('submit'); }} />}
          {tab === 'panels' && <PanelsView store={store} isLead={isLead} currentProfile={profile} onLogTasting={(bid, type, panelId) => { setPresetBatchId(bid); setPresetTastingType(type || null); setActivePanelId(panelId || null); setTab('submit'); }} />}
          {tab === 'submit' && <TastingForm store={store} currentProfile={profile} onDone={() => { setEditingSession(null); setActivePanelId(null); setTab(editingSession ? 'dashboard' : 'sessions'); }} presetBatchId={presetBatchId} presetTastingType={presetTastingType} activePanelId={editingSession ? null : activePanelId} editSession={editingSession} />}
          {tab === 'brite' && <PackagingSignOffView store={store} currentProfile={profile} />}
          {tab === 'retention' && isLead && <RetentionQueue store={store} onLogTasting={(bid, type) => { setPresetBatchId(bid); setPresetTastingType(type || null); setActivePanelId(null); setTab('submit'); }} />}
          {tab === 'qc' && isLead && <QcView store={store} />}
          {tab === 'incubating' && isLead && <IncubatingView store={store} />}
          {tab === 'qcDashboard' && isLead && <QcDashboard store={store} />}
          {tab === 'qcLocations' && isLead && <QcLocationsTab store={store} />}
          {tab === 'batches' && isLead && <BatchesView store={store} isLead={isLead} />}
          {tab === 'skus' && <SkuProfiles store={store} isLead={isLead} />}
          {tab === 'search' && <SearchView store={store} />}
          {tab === 'trends' && isLead && <TrendsView store={store} />}
          {tab === 'dashboard' && isLead && <Dashboard store={store} onEditSession={(s) => { setEditingSession(s); setTab('submit'); }} />}
          {tab === 'team' && isLead && <TeamManagement store={store} currentProfile={profile} />}
        </main>
      </div>
    </div>
  );
}
