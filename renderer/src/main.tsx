import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import * as XLSX from 'xlsx';
import hljs from 'highlight.js/lib/core';
import javascript from 'highlight.js/lib/languages/javascript';
import typescript from 'highlight.js/lib/languages/typescript';
import json from 'highlight.js/lib/languages/json';
import python from 'highlight.js/lib/languages/python';
import xml from 'highlight.js/lib/languages/xml';
import css from 'highlight.js/lib/languages/css';
import bash from 'highlight.js/lib/languages/bash';
import sql from 'highlight.js/lib/languages/sql';
import type { CompareEvent, CompareTab, Input, Mode, Options, Preferences } from './types';
import './styles.css';
for (const [name, grammar] of Object.entries({ javascript, typescript, json, python, xml, css, bash, sql })) hljs.registerLanguage(name, grammar);
const languageFor = (input: Input | null) => {
  const ext = input?.name.split('.').at(-1)?.toLowerCase();
  return ({ js: 'javascript', jsx: 'javascript', ts: 'typescript', tsx: 'typescript', json: 'json', py: 'python', xml: 'xml', html: 'xml', css: 'css', sh: 'bash', sql: 'sql' } as Record<string, string>)[ext || ''];
};

const modes: { id: Mode; label: string; icon: string; hint: string }[] = [
  { id: 'text', label: 'Text', icon: '¶', hint: 'Words, code and logs' },
  { id: 'images', label: 'Images', icon: '▧', hint: 'Pixels, OCR and metadata' },
  { id: 'documents', label: 'Documents', icon: '▤', hint: 'PDF, Word and presentations' },
  { id: 'excel', label: 'Excel', icon: '▦', hint: 'Cells, sheets and formulas' },
  { id: 'folders', label: 'Folders', icon: '▣', hint: 'Recursive file trees' }
];
const defaults = (): Options => ({
  view: 'split', precision: 'smart', syntaxHighlight: true, ignoreCase: false, ignoreWhitespace: false, ignoreRules: [],
  wrap: true, syncScroll: true, hideUnchanged: false, threshold: 24, minRegionSize: 1, regionGap: 0, autoAlign: false,
  offsetX: 0, offsetY: 0, scale: 100, rotation: 0, perspectiveX: 0, perspectiveY: 0, flipX: false, flipY: false,
  opacity: 50, flickerMs: 500, ocr: false, page: 1, rightPageOrder: [],
  leftSheet: '', rightSheet: '', formulas: false, alignRows: true, alignColumns: true, hideRows: false, hideColumns: false, dateOrder: 'none',
  sortColumn: '', exclusions: ['node_modules', '.git'], compareMetadata: false
});
const newTab = (type: Mode, left: Input | null = null, right: Input | null = null, available: Input[] = []): CompareTab => ({
  id: crypto.randomUUID(), title: modes.find(mode => mode.id === type)?.label || type, type,
  left, right, available, options: defaults(), result: null, busy: false, progress: 0, phase: '', dirty: false
});
function decidedChunks(chunks: any[], decisions: CompareTab['decisions']) {
  if (!decisions) return chunks;
  const output: any[] = [];
  let group = 0;
  for (let index = 0; index < chunks.length;) {
    if (chunks[index].type === 'same') { output.push(chunks[index++]); continue; }
    const changed: any[] = [];
    while (index < chunks.length && chunks[index].type !== 'same') changed.push(chunks[index++]);
    const decision = decisions[group++];
    if (!decision) output.push(...changed);
    else output.push(...changed.filter(chunk => chunk.type === (decision === 'accept' ? 'added' : 'removed')).map(chunk => ({ ...chunk, type: 'same' })));
  }
  return output;
}
function compatible(inputs: Input[], preferred?: Mode): Mode | null {
  if (preferred && inputs.every(input => input.types.includes(preferred))) return preferred;
  const order: Mode[] = ['folders','documents','images','excel','text'];
  if (inputs.length === 2 && inputs.some(input => input.types.includes('images') && !input.types.includes('documents')) && inputs.every(input => input.types.includes('images'))) return 'images';
  return order.find(type => inputs.every(input => input.types.includes(type))) || null;
}
function humanError(error: unknown) { return error instanceof Error ? error.message : String(error); }
function IconButton({ name, title, onClick, className = '' }: { name: string; title: string; onClick: () => void; className?: string }) {
  return <button className={className} title={title} aria-label={title} onClick={onClick}><img src={'./icons/' + name + '.svg'} alt="" /></button>;
}
function Titlebar({ tabs, active, onSelect, onNew, onClose, onReorder, onSettings, onSave, onAppClose }: {
  tabs: CompareTab[]; active: string | null; onSelect: (id: string) => void; onNew: () => void; onClose: (id: string) => void; onReorder: (from: string, to: string) => void;
  onSettings: () => void; onSave: () => void; onAppClose: () => void;
}) {
  const [maximized, setMaximized] = useState(false);
  useEffect(() => {
    window.api.isWindowMaximized().then(setMaximized);
    return window.api.onWindowMaximizedChange(setMaximized);
  }, []);
  return <header className="titlebar">
    <div className="brand">NORWAYS DIFF CHECKER</div>
    <nav className="tabs" aria-label="Comparison tabs">
      {tabs.map(tab => <div key={tab.id} draggable className={'tab ' + (active === tab.id ? 'selected' : '')} onClick={() => onSelect(tab.id)}
        onDragStart={event => { event.dataTransfer.setData('application/x-norways-tab', tab.id); event.dataTransfer.effectAllowed = 'move'; }}
        onDragOver={event => { if (event.dataTransfer.types.includes('application/x-norways-tab')) event.preventDefault(); }}
        onDrop={event => { const from = event.dataTransfer.getData('application/x-norways-tab'); if (from) { event.preventDefault(); event.stopPropagation(); onReorder(from, tab.id); } }}>
        <span className="tab-symbol">{modes.find(mode => mode.id === tab.type)?.icon}</span><span className="tab-name">{tab.title}{tab.dirty ? ' •' : ''}</span>
        <button className="tab-close" title="Close tab" onClick={event => { event.stopPropagation(); onClose(tab.id); }}>×</button>
      </div>)}
      <button className="new-tab" title="New comparison" onClick={onNew}>+</button>
    </nav>
    <div className="title-actions">
      <button onClick={onSave} title="Save comparisons">Save</button>
      <button onClick={onSettings} title="Settings">⚙</button>
    </div>
    <div className="window-controls">
      <IconButton name="minimize" title="Minimize" className="window-control" onClick={() => void window.api.minimizeWindow()} />
      <IconButton name={maximized ? 'filter_none' : 'crop_square'} title={maximized ? 'Restore' : 'Maximize'} className="window-control" onClick={async () => setMaximized(await window.api.toggleMaximizeWindow())} />
      <IconButton name="close" title="Close" className="window-control window-close" onClick={onAppClose} />
    </div>
  </header>;
}
function Welcome({ recent, onCreate, onLoad, onDismiss }: {
  recent: Preferences['recentProjects']; onCreate: (type: Mode) => void; onLoad: (path: string) => void; onDismiss: () => void;
}) {
  return <div className="modal-backdrop"><div className="welcome modal">
    <div className="welcome-head"><div className="small-caps">NORWAYS DIFF CHECKER</div><h1>What would you like to compare?</h1><p>Choose a comparison or drop files and folders anywhere in the window.</p></div>
    <div className="welcome-modes">{modes.map(mode => <button className="mode-card" key={mode.id} onClick={() => onCreate(mode.id)}>
      <span className="mode-icon">{mode.icon}</span><span><strong>{mode.label}</strong><small>{mode.hint}</small></span><b>↗</b>
    </button>)}</div>
    <div className="recent"><div className="section-title">Recent comparisons</div>
      {recent.length ? recent.map(item => <button key={item.id} onClick={() => onLoad(item.path)}>{item.name}<span>Open →</span></button>) : <p>No saved comparisons yet.</p>}
    </div>
    <button className="modal-dismiss" onClick={onDismiss}>Close</button>
  </div></div>;
}
function Pairing({ inputs, type, onChangeType, onCancel, onConfirm }: {
  inputs: Input[]; type: Mode; onChangeType: (type: Mode) => void; onCancel: () => void; onConfirm: (left: Input, right: Input, others: Input[], type: Mode) => void;
}) {
  const [left, setLeft] = useState(inputs[0]?.id);
  const [right, setRight] = useState(inputs[1]?.id);
  const inputLeft = inputs.find(input => input.id === left)!;
  const inputRight = inputs.find(input => input.id === right)!;
  return <div className="modal-backdrop"><div className="pairing modal">
    <div className="small-caps">PAIR INPUTS</div><h2>Choose two to compare</h2><p>Only two inputs are active in a comparison. The rest stay available for later swaps.</p>
    <div className="pair-row">
      <label>Original<select value={left} onChange={event => { if (event.target.value === right) setRight(left); setLeft(event.target.value); }}>{inputs.map(input => <option key={input.id} value={input.id}>{input.name}</option>)}</select></label>
      <button title="Swap sides" onClick={() => { setLeft(right); setRight(left); }}>⇄</button>
      <label>Changed<select value={right} onChange={event => { if (event.target.value === left) setLeft(right); setRight(event.target.value); }}>{inputs.map(input => <option key={input.id} value={input.id}>{input.name}</option>)}</select></label>
    </div>
    <label className="type-select">Compare as<select value={type} onChange={event => onChangeType(event.target.value as Mode)}>{modes.filter(mode => inputs.every(input => input.types.includes(mode.id))).map(mode => <option key={mode.id} value={mode.id}>{mode.label}</option>)}</select></label>
    <div className="pair-list">{inputs.map(input => <div key={input.id}><span>{input.name}</span><small>{input.id === left ? 'Original' : input.id === right ? 'Changed' : 'Available'}</small></div>)}</div>
    <footer><button onClick={onCancel}>Cancel</button><button className="primary" onClick={() => onConfirm(inputLeft, inputRight, inputs.filter(input => input.id !== left && input.id !== right), type)}>Compare</button></footer>
  </div></div>;
}
function InputSlot({ side, input, available, type, onBrowse, onReplace, onDrop }: {
  side: 'left' | 'right'; input: Input | null; available: Input[]; type: Mode;
  onBrowse: () => void; onReplace: (input: Input) => void; onDrop: (event: React.DragEvent) => void;
}) {
  return <div className="input-slot" onDragOver={event => { event.preventDefault(); event.stopPropagation(); }} onDrop={onDrop}>
    <div className="small-caps">{side === 'left' ? 'ORIGINAL' : 'CHANGED'}</div>
    <div className="slot-name">{input ? input.name : 'Drop ' + ({ text: 'text', images: 'an image', documents: 'a document', excel: 'a spreadsheet', folders: 'a folder' }[type]) + ' here'}</div>
    <button onClick={onBrowse}>Browse…</button>
    {!!available.length && <select aria-label={'Replace ' + side + ' input'} value="" onChange={event => { const selected = available.find(item => item.id === event.target.value); if (selected) onReplace(selected); }}>
      <option value="">Replace from list…</option>{available.filter(item => item.types.includes(type)).map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
    </select>}
  </div>;
}
function DiffText({ result, options, language }: { result: any; options: Options; language?: string }) {
  const [page, setPage] = useState(0);
  const splitRefs = useRef<Array<HTMLElement | null>>([null, null]);
  const scrollLock = useRef(false);
  useEffect(() => setPage(0), [result]);
  if (!result?.chunks) return null;
  const chunks = options.hideUnchanged ? result.chunks.filter((item: any) => item.type !== 'same') : result.chunks;
  const pageSize = 300;
  const pageCount = Math.max(1, Math.ceil(chunks.length / pageSize));
  const visible = chunks.slice(Math.min(page, pageCount - 1) * pageSize, (Math.min(page, pageCount - 1) + 1) * pageSize);
  const render = (items: any[]) => <div className={'diff-output ' + (options.wrap ? 'wrap' : '')}>{items.map((part: any, index: number) => <div key={index} className={'diff-chunk ' + part.type}>
    <span className="line-no">{part.type === 'added' ? '+' : part.type === 'removed' ? '−' : ' '}{part.type === 'added' ? part.rightLine : part.leftLine}</span>
    {language && options.syntaxHighlight ? <pre dangerouslySetInnerHTML={{ __html: hljs.highlight(part.text || ' ', { language, ignoreIllegals: true }).value }} /> : <pre>{part.text || ' '}</pre>}
  </div>)}</div>;
  const sync = (from: 0 | 1, event: React.UIEvent<HTMLElement>) => {
    if (!options.syncScroll || scrollLock.current) return;
    const other = splitRefs.current[1 - from];
    if (!other) return;
    scrollLock.current = true;
    other.scrollTop = event.currentTarget.scrollTop;
    other.scrollLeft = event.currentTarget.scrollLeft;
    requestAnimationFrame(() => { scrollLock.current = false; });
  };
  const content = options.view === 'split' ? <div className="diff-split"><section ref={node => { splitRefs.current[0] = node; }} onScroll={event => sync(0, event)}><header>Original</header>{render(visible.filter((part: any) => part.type !== 'added'))}</section><section ref={node => { splitRefs.current[1] = node; }} onScroll={event => sync(1, event)}><header>Changed</header>{render(visible.filter((part: any) => part.type !== 'removed'))}</section></div> : render(visible);
  return <div className="paged-diff">{pageCount > 1 && <div className="diff-pager"><button disabled={page === 0} onClick={() => setPage(value => value - 1)}>Previous section</button><span>{Math.min(page, pageCount - 1) + 1} of {pageCount}</span><button disabled={page >= pageCount - 1} onClick={() => setPage(value => value + 1)}>Next section</button></div>}{content}</div>;
}
function TextView({ tab, onText, onOption }: { tab: CompareTab; onText: (side: 'left' | 'right', text: string) => void; onOption: (patch: Partial<Options>) => void }) {
  const [left, setLeft] = useState(''), [right, setRight] = useState('');
  const editorRefs = useRef<Array<HTMLTextAreaElement | null>>([null, null]);
  const editorScrollLock = useRef(false);
  const [selectedChange, setSelectedChange] = useState(0);
  useEffect(() => { if (tab.left) window.api.readText(tab.left).then(setLeft).catch(() => setLeft('')); else setLeft(''); }, [tab.left?.id]);
  useEffect(() => { if (tab.right) window.api.readText(tab.right).then(setRight).catch(() => setRight('')); else setRight(''); }, [tab.right?.id]);
  const groups: { first: any; last: any; leftText: string; rightText: string }[] = [];
  const chunks = tab.result?.chunks || [];
  for (let index = 0; index < chunks.length;) {
    if (chunks[index].type === 'same') { index++; continue; }
    const first = chunks[index]; let leftText = '', rightText = '';
    while (index < chunks.length && chunks[index].type !== 'same') {
      if (chunks[index].type === 'removed') leftText += chunks[index].text;
      if (chunks[index].type === 'added') rightText += chunks[index].text;
      index++;
    }
    groups.push({ first, last: chunks[index - 1], leftText, rightText });
  }
  const selected = groups[Math.min(selectedChange, groups.length - 1)];
  const canMerge = selected && !tab.options.ignoreCase && !tab.options.ignoreWhitespace && !tab.options.ignoreRules.length && !tab.busy;
  function applyChange(side: 'left' | 'right') {
    if (!canMerge) return;
    const start = side === 'left' ? selected.first.leftOffset : selected.first.rightOffset;
    const end = side === 'left' ? selected.last.leftOffset + (selected.last.type === 'added' ? 0 : selected.last.text.length) : selected.last.rightOffset + (selected.last.type === 'removed' ? 0 : selected.last.text.length);
    const current = side === 'left' ? left : right;
    const replacement = side === 'left' ? selected.rightText : selected.leftText;
    const next = current.slice(0, start) + replacement + current.slice(end);
    if (side === 'left') setLeft(next); else setRight(next);
    onText(side, next);
  }
  function syncEditor(from: 0 | 1, event: React.UIEvent<HTMLTextAreaElement>) {
    if (!tab.options.syncScroll || editorScrollLock.current) return;
    const other = editorRefs.current[1 - from];
    if (!other) return;
    editorScrollLock.current = true;
    other.scrollTop = event.currentTarget.scrollTop;
    other.scrollLeft = event.currentTarget.scrollLeft;
    requestAnimationFrame(() => { editorScrollLock.current = false; });
  }
  return <div className="mode-body">
    <div className="editors">
      <label><span>ORIGINAL TEXT</span><textarea ref={node => { editorRefs.current[0] = node; }} wrap={tab.options.wrap ? 'soft' : 'off'} onScroll={event => syncEditor(0, event)} spellCheck={false} value={left} onChange={event => { setLeft(event.target.value); onText('left', event.target.value); }} placeholder="Paste or type original text…" /></label>
      <label><span>CHANGED TEXT</span><textarea ref={node => { editorRefs.current[1] = node; }} wrap={tab.options.wrap ? 'soft' : 'off'} onScroll={event => syncEditor(1, event)} spellCheck={false} value={right} onChange={event => { setRight(event.target.value); onText('right', event.target.value); }} placeholder="Paste or type changed text…" /></label>
    </div>
    <div className="result-head"><strong>Changes</strong><span>{tab.result ? tab.result.count + ' changed blocks' : 'Add text on both sides to compare'}</span>
      {!!groups.length && <><button onClick={() => setSelectedChange(value => Math.max(0, value - 1))}>Previous</button><span>{Math.min(selectedChange + 1, groups.length)} / {groups.length}</span><button onClick={() => setSelectedChange(value => Math.min(groups.length - 1, value + 1))}>Next</button>
        <button disabled={!canMerge} onClick={() => applyChange('right')}>Accept original →</button><button disabled={!canMerge} onClick={() => applyChange('left')}>← Accept changed</button></>}
      <select value={tab.options.view} onChange={event => onOption({ view: event.target.value })}><option value="split">Side by side</option><option value="unified">Unified</option></select>
    </div>
    {selected && <div className="change-preview"><span>Original: {selected.leftText.slice(0, 160) || '∅'}</span><span>Changed: {selected.rightText.slice(0, 160) || '∅'}</span></div>}
    <DiffText result={tab.result} options={tab.options} language={languageFor(tab.left) || languageFor(tab.right)} />
  </div>;
}
function DocumentView({ tab, onDecision, onOrder }: { tab: CompareTab; onDecision: (group: number, decision: 'accept' | 'reject') => void; onOrder: (order: number[]) => void }) {
  const result = tab.result;
  if (!result) return <div className="empty-result">Choose two PDF, Word, or PowerPoint files to compare.</div>;
  const view = tab.options.view;
  const pageCount = tab.right?.name.toLowerCase().endsWith('.pdf') ? Number(result.rightStructure?.pageCount) || 0 : 0;
  const currentOrder = [...new Set((tab.options.rightPageOrder || []).filter(number => number >= 1 && number <= pageCount))];
  const pageOrder = [...currentOrder, ...Array.from({ length: pageCount }, (_, index) => index + 1).filter(number => !currentOrder.includes(number))];
  const redlineGroups: { index: number; before: string; after: string }[] = [];
  for (let index = 0, group = 0; index < (result.chunks || []).length;) {
    if (result.chunks[index].type === 'same') { index++; continue; }
    let before = '', after = '';
    while (index < result.chunks.length && result.chunks[index].type !== 'same') {
      if (result.chunks[index].type === 'removed') before += result.chunks[index].text;
      if (result.chunks[index].type === 'added') after += result.chunks[index].text;
      index++;
    }
    redlineGroups.push({ index: group++, before, after });
  }
  const rich = (structure: any) => <div className="rich-document">{structure.paragraphs.map((paragraph: any, index: number) => <p key={index}>
    {paragraph.runs.map((run: any, runIndex: number) => <span key={runIndex} style={{ fontWeight: run.bold ? 'bold' : undefined, fontStyle: run.italic ? 'italic' : undefined,
      color: /^[0-9a-fA-F]{6}$/.test(run.color || '') ? '#' + run.color : undefined,
      fontFamily: run.font || undefined, fontSize: run.size ? Math.min(40, Math.max(6, Number(run.size) / 2)) + 'pt' : undefined }}>{run.text}</span>)}
  </p>)}</div>;
  return <div className="mode-body"><div className="result-head"><strong>Document changes</strong><span>{result.count} text blocks · {result.structuralChanges?.length || 0} structural changes</span></div>
    {pageCount > 1 && <div className="document-page-order"><strong>Changed PDF page order</strong><span>Reorder pages for comparison and export:</span>{pageOrder.map((number, index) => <div key={number}><span>Position {index + 1}: page {number}</span>
      <button disabled={index === 0} onClick={() => { const next = [...pageOrder]; [next[index - 1], next[index]] = [next[index], next[index - 1]]; onOrder(next); }}>↑</button>
      <button disabled={index === pageOrder.length - 1} onClick={() => { const next = [...pageOrder]; [next[index + 1], next[index]] = [next[index], next[index + 1]]; onOrder(next); }}>↓</button></div>)}</div>}
    {view === 'image' ? result.pageImages ? <div className="document-pages"><img src={result.pageImages.left} alt="Original PDF page" /><img src={result.pageImages.right} alt="Changed PDF page" /></div>
      : <div className="empty-result">Rendered pages are unavailable for this pair.</div> : null}
    {(view === 'rich' || view === 'redline' || view === 'split') && !!result.structuralChanges?.length && <div className="document-structure"><strong>Structure and formatting</strong>
      {result.structuralChanges.map((change: any, index: number) => <div key={index}><b>{change.kind}</b><span>{change.reference}</span><small>{change.kind === 'moved' ? change.text : change.kind === 'formatting' ? change.left?.text : `${change.left ?? '—'} → ${change.right ?? '—'}`}</small></div>)}
    </div>}
    {view === 'rich' && result.leftStructure?.paragraphs?.length && result.rightStructure?.paragraphs?.length ? <div className="rich-split">{rich(result.leftStructure)}{rich(result.rightStructure)}</div> : null}
    {view === 'redline' && <div className="redline-decisions">{redlineGroups.map(group => <div key={group.index}>
      <span>#{group.index + 1} · {group.before.slice(0, 100) || '∅'} → {group.after.slice(0, 100) || '∅'}</span>
      <button className={tab.decisions?.[group.index] === 'accept' ? 'selected' : ''} onClick={() => onDecision(group.index, 'accept')}>Accept</button>
      <button className={tab.decisions?.[group.index] === 'reject' ? 'selected' : ''} onClick={() => onDecision(group.index, 'reject')}>Reject</button>
    </div>)}</div>}
    <DiffText result={view === 'redline' ? { ...result, chunks: decidedChunks(result.chunks || [], tab.decisions) } : result} options={{ ...tab.options, view: view === 'plain' || view === 'redline' || view === 'ocr' ? 'unified' : 'split' }} />
  </div>;
}
function ImageView({ tab }: { tab: CompareTab }) {
  const result = tab.result;
  const [flicker, setFlicker] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const dragPoint = useRef<{ x: number; y: number } | null>(null);
  useEffect(() => {
    if (tab.options.view !== 'flicker') return;
    const timer = setInterval(() => setFlicker(value => !value), tab.options.flickerMs);
    return () => clearInterval(timer);
  }, [tab.options.view, tab.options.flickerMs]);
  if (!result) return <div className="empty-result">Drop two images to compare pixels and metadata.</div>;
  const view = tab.options.view;
  if (view === 'details') return <div className="details-grid"><pre>{JSON.stringify(result.leftDetails, null, 2)}</pre><pre>{JSON.stringify(result.rightDetails, null, 2)}</pre></div>;
  if (view === 'ocr') return <div className="details-grid"><pre>{result.leftOcr || 'Enable OCR in Options, then compare.'}</pre><pre>{result.rightOcr || 'Enable OCR in Options, then compare.'}</pre></div>;
  if (view === 'rich-ocr') return <div className="positioned-ocr">
    {(['left', 'right'] as const).map(side => <div key={side}><strong>{side === 'left' ? 'Original' : 'Changed'} positioned text</strong>
      <div className="positioned-ocr-scroll"><div className="positioned-ocr-canvas" style={{ width: result.width, height: result.height }}>
        <img src={result[side + 'Data']} alt="" />
        {(result[side + 'OcrWords'] || []).map((word: any, index: number) => <span key={index} title={`${Math.round(word.confidence)}% confidence`} style={{ left: word.x0, top: word.y0, width: Math.max(1, word.x1 - word.x0), height: Math.max(1, word.y1 - word.y0) }}>{word.text}</span>)}
      </div></div>{!result[side + 'OcrWords']?.length && <small>Enable OCR in Options, then compare.</small>}</div>)}
  </div>;
  const transform = { transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})` };
  const interaction = {
    onWheel: (event: React.WheelEvent) => { event.preventDefault(); setZoom(value => Math.min(8, Math.max(0.25, value * (event.deltaY < 0 ? 1.12 : 0.89)))); },
    onPointerDown: (event: React.PointerEvent<HTMLDivElement>) => { if (event.button === 0) { dragPoint.current = { x: event.clientX, y: event.clientY }; event.currentTarget.setPointerCapture(event.pointerId); } },
    onPointerMove: (event: React.PointerEvent<HTMLDivElement>) => { if (dragPoint.current) { const dx = event.clientX - dragPoint.current.x, dy = event.clientY - dragPoint.current.y; dragPoint.current = { x: event.clientX, y: event.clientY }; setPan(value => ({ x: value.x + dx, y: value.y + dy })); } },
    onPointerUp: () => { dragPoint.current = null; }
  };
  return <div className="image-workspace"><div className="image-toolbar"><button onClick={() => setZoom(value => Math.max(.25, value / 1.25))}>−</button><span>{Math.round(zoom * 100)}%</span><button onClick={() => setZoom(value => Math.min(8, value * 1.25))}>+</button><button onClick={() => { setZoom(1); setPan({ x: 0, y: 0 }); }}>Reset view</button>
    <span>Drag to pan · wheel to zoom</span>{tab.options.autoAlign && <span>Auto offset: {result.alignment?.automatic.x}, {result.alignment?.automatic.y}</span>}</div>
    {view === 'split' ? <div className="image-split" {...interaction}><div><img src={result.leftData} style={transform} /></div><div><img src={result.rightData} style={transform} /></div></div> : <div className="image-stage" {...interaction}>
      <img className="image-base" src={view === 'flicker' && flicker ? result.rightData : result.leftData} style={transform} />
      {view === 'slider' && <img className="image-overlay" src={result.rightData} style={{ ...transform, clipPath: 'inset(0 ' + (100 - tab.options.opacity) + '% 0 0)' }} />}
      {view === 'fade' && <img className="image-overlay" src={result.rightData} style={{ ...transform, opacity: tab.options.opacity / 100 }} />}
      {view === 'subtract' && <img className="image-overlay" src={result.subtractData} style={transform} />}
      {view === 'highlight' && <img className="image-overlay" src={result.diffData} style={transform} />}
    </div>}<div className="image-regions"><strong>{result.regions?.length || 0} changed regions · {result.changed} pixels</strong>
    {(result.regions || []).slice(0, 200).map((region: any, index: number) => <span key={index} className="image-region-item">{region.previewLeft && <img src={region.previewLeft} alt="Original region" />}{region.previewRight && <img src={region.previewRight} alt="Changed region" />}<span>#{index + 1} · ({region.x}, {region.y}) · {region.width} × {region.height} · {region.pixels} pixels</span></span>)}
  </div>{!!tab.scans?.length && <div className="scan-history"><strong>Scans in this tab</strong>{tab.scans.slice(-8).map((scan, index) => <span key={index}>{new Date(scan.at).toLocaleTimeString()} · {scan.count} regions · {scan.changed} pixels</span>)}</div>}</div>;
}
function ExcelView({ tab, onOption }: { tab: CompareTab; onOption: (patch: Partial<Options>) => void }) {
  const result = tab.result;
  const [page, setPage] = useState(0);
  const [changePage, setChangePage] = useState(0);
  useEffect(() => setPage(0), [result, tab.options.hideRows]);
  useEffect(() => setChangePage(0), [result]);
  if (!result) return <div className="empty-result">Choose two spreadsheets to compare sheets and cells.</div>;
  const changed = new Set<string>(result.changed.map((item: any) => item.row + ':' + item.col));
  const rowCount = Math.max(result.leftRows.length, result.rightRows.length);
  const colCount = Math.max(result.leftRows.reduce((maximum: number, row: any[]) => Math.max(maximum, row.length), 0), result.rightRows.reduce((maximum: number, row: any[]) => Math.max(maximum, row.length), 0));
  const rows = Array.from({ length: rowCount }, (_, i) => i).filter(row => !tab.options.hideRows || [...changed].some(value => value.startsWith(row + ':')));
  const cols = Array.from({ length: colCount }, (_, i) => i).filter(col => !tab.options.hideColumns || [...changed].some(value => value.endsWith(':' + col)));
  const pageCount = Math.max(1, Math.ceil(rows.length / 250));
  const visibleRows = rows.slice(Math.min(page, pageCount - 1) * 250, (Math.min(page, pageCount - 1) + 1) * 250);
  const grid = (which: 'left' | 'right') => <div className="sheet-grid"><table><tbody>
    <tr><th></th>{cols.map(col => <th key={col}>{result.columnPositions?.[col]?.[which] == null ? '—' : XLSX.utils.encode_col(result.columnPositions[col][which])}</th>)}</tr>
    {visibleRows.map(row => <tr key={row}><th>{result.rowPositions?.length ? result.rowPositions[row]?.[which] ?? '—' : row + 1}</th>{cols.map(col => <td key={col} className={changed.has(row + ':' + col) ? which === 'left' ? 'removed' : 'added' : ''}>{result[which + 'Rows'][row]?.[col]?.display ?? ''}</td>)}</tr>)}
  </tbody></table></div>;
  const changePageCount = Math.max(1, Math.ceil(result.changed.length / 500));
  const changes = <><div className="excel-change-list"><table><thead><tr><th>Cell</th><th>Original</th><th>Changed</th><th>Formula</th></tr></thead><tbody>{result.changed.slice(changePage * 500, (changePage + 1) * 500).map((item: any, index: number) => <tr key={index}>
    <th>{item.leftRow && item.leftColumn != null ? XLSX.utils.encode_cell({ r: item.leftRow - 1, c: item.leftColumn }) : '—'} → {item.rightRow && item.rightColumn != null ? XLSX.utils.encode_cell({ r: item.rightRow - 1, c: item.rightColumn }) : '—'}</th><td className="removed">{item.left}</td><td className="added">{item.right}</td><td>{item.leftFormula || item.rightFormula ? `${item.leftFormula || '—'} → ${item.rightFormula || '—'}` : ''}</td>
  </tr>)}</tbody></table></div>{changePageCount > 1 && <div className="diff-pager"><button disabled={changePage === 0} onClick={() => setChangePage(value => value - 1)}>Previous changes</button><span>{changePage + 1} of {changePageCount}</span><button disabled={changePage >= changePageCount - 1} onClick={() => setChangePage(value => value + 1)}>Next changes</button></div>}</>;
  return <div className="excel-view">
    <div className="sheet-selectors"><label>Original sheet <select value={result.leftName} onChange={event => onOption({ leftSheet: event.target.value })}>{result.leftSheets.map((name: string) => <option key={name}>{name}</option>)}</select></label>
      <label>Changed sheet <select value={result.rightName} onChange={event => onOption({ rightSheet: event.target.value })}>{result.rightSheets.map((name: string) => <option key={name}>{name}</option>)}</select></label>
      <label>Sort by <select value={tab.options.sortColumn} onChange={event => onOption({ sortColumn: event.target.value })}><option value="">Original order</option>{Array.from({ length: Math.min(colCount, 26) }, (_, col) => <option key={col} value={XLSX.utils.encode_col(col)}>{XLSX.utils.encode_col(col)}</option>)}</select></label><span>{result.count} changed cells</span></div>
    {pageCount > 1 && <div className="diff-pager"><button disabled={page === 0} onClick={() => setPage(value => value - 1)}>Previous rows</button><span>{page + 1} of {pageCount}</span><button disabled={page >= pageCount - 1} onClick={() => setPage(value => value + 1)}>Next rows</button></div>}
    {tab.options.view === 'details' ? <div className="details-grid"><pre>{JSON.stringify({ file: tab.left?.name, sheets: result.leftSheets, rows: result.leftRows.length, size: tab.left?.size }, null, 2)}</pre><pre>{JSON.stringify({ file: tab.right?.name, sheets: result.rightSheets, rows: result.rightRows.length, size: tab.right?.size }, null, 2)}</pre></div>
      : tab.options.view === 'redline' ? changes : <><div className="sheet-panes">{grid('left')}{grid('right')}</div>{tab.options.view === 'four' && changes}</>}
  </div>;
}
function FolderView({ tab, onOpenPair }: { tab: CompareTab; onOpenPair: (left: string, right: string) => void }) {
  const [filter, setFilter] = useState('all'), [search, setSearch] = useState('');
  const [collapseUnchanged, setCollapseUnchanged] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [page, setPage] = useState(0);
  useEffect(() => setPage(0), [filter, search, collapseUnchanged, tab.result]);
  const entries = (tab.result?.entries || []).filter((entry: any) => (filter === 'all' || entry.status === filter) && (!collapseUnchanged || entry.status !== 'same') && entry.relative.toLowerCase().includes(search.toLowerCase()));
  const pairs = (tab.result?.entries || []).filter((entry: any) => selected.has(entry.relative) && entry.left?.path && entry.right?.path && !entry.directory);
  const pageCount = Math.max(1, Math.ceil(entries.length / 500));
  const visibleEntries = entries.slice(Math.min(page, pageCount - 1) * 500, (Math.min(page, pageCount - 1) + 1) * 500);
  const saved = new Map((tab.scanManifest || []).map(entry => [entry.relative, entry]));
  const changedSinceSave = tab.scanManifest && tab.result ? (tab.result.entries as any[]).filter(entry => {
    const previous = saved.get(entry.relative);
    return !previous || previous.status !== entry.status || previous.leftHash !== entry.left?.hash || previous.rightHash !== entry.right?.hash;
  }).length + tab.scanManifest.filter(entry => !(tab.result.entries as any[]).some(current => current.relative === entry.relative)).length : null;
  return <div className="folder-view"><div className="folder-toolbar"><input value={search} onChange={event => setSearch(event.target.value)} placeholder="Search paths…" />
    <select value={filter} onChange={event => setFilter(event.target.value)}>{['all','added','removed','modified','same'].map(status => <option key={status}>{status}</option>)}</select>
    <label className="check"><input type="checkbox" checked={collapseUnchanged} onChange={event => setCollapseUnchanged(event.target.checked)} />Collapse unchanged</label>
    <button disabled={!pairs.length} onClick={() => pairs.forEach((entry: any) => onOpenPair(entry.left.path, entry.right.path))}>Compare selected ({pairs.length})</button>
    <span>{tab.result?.count ?? 0} differences{changedSinceSave !== null ? ` · ${changedSinceSave} changed since save` : ''}</span></div>
    {pageCount > 1 && <div className="diff-pager"><button disabled={page === 0} onClick={() => setPage(value => value - 1)}>Previous paths</button><span>{Math.min(page, pageCount - 1) + 1} of {pageCount}</span><button disabled={page >= pageCount - 1} onClick={() => setPage(value => value + 1)}>Next paths</button></div>}
    <div className="folder-list">{visibleEntries.map((entry: any) => <div key={entry.relative} className={'folder-entry ' + entry.status}>
      <input type="checkbox" aria-label={'Select ' + entry.relative} disabled={!entry.left?.path || !entry.right?.path || entry.directory} checked={selected.has(entry.relative)} onChange={event => setSelected(previous => { const next = new Set(previous); if (event.target.checked) next.add(entry.relative); else next.delete(entry.relative); return next; })} />
      <button onClick={() => { if (entry.left?.path && entry.right?.path && !entry.directory) onOpenPair(entry.left.path, entry.right.path); }}>
        <span style={{ paddingLeft: Math.min(6, entry.relative.split(/[\\/]/).length - 1) * 12 }}>{entry.directory ? '▣' : '▤'} {entry.relative}</span><small>{entry.status}{entry.metadataChanged ? ' · metadata' : ''}</small></button>
    </div>)}</div>
  </div>;
}
function OptionsPanel({ tab, change, onNotes, onImagePreset }: { tab: CompareTab; change: (patch: Partial<Options>) => void; onNotes: (notes: string) => void; onImagePreset: (name: string) => void }) {
  const o = tab.options;
  const toggle = (name: keyof Options) => <label className="check"><input type="checkbox" checked={Boolean(o[name])} onChange={event => change({ [name]: event.target.checked })} />{String(name).replace(/([A-Z])/g, ' $1')}</label>;
  return <aside className="options"><div className="section-title">OPTIONS</div>
    {['text','documents'].includes(tab.type) && <>
      <label>Precision<select value={o.precision} onChange={event => change({ precision: event.target.value as Options['precision'] })}><option>smart</option><option>word</option><option>character</option></select></label>
      {toggle('ignoreCase')}{toggle('ignoreWhitespace')}{toggle('hideUnchanged')}{toggle('wrap')}{toggle('syncScroll')}
      <label>Ignore rules<textarea value={o.ignoreRules.map(rule => (rule.regex ? 're:' : '') + rule.value).join('\n')} onChange={event => change({ ignoreRules: event.target.value.split('\n').filter(Boolean).map(value => ({ value: value.startsWith('re:') ? value.slice(3) : value, regex: value.startsWith('re:') })) })} placeholder="One rule per line; prefix regex with re:" /></label>
    </>}
    {tab.type === 'text' && toggle('syntaxHighlight')}
    {tab.type === 'images' && <>
      <label>View<select value={o.view} onChange={event => change({ view: event.target.value })}>{['split','slider','fade','flicker','subtract','highlight','ocr','rich-ocr','details'].map(view => <option key={view} value={view}>{view}</option>)}</select></label>
      <label>Reveal / opacity<input type="range" min="0" max="100" value={o.opacity} onChange={event => change({ opacity: Number(event.target.value) })} /></label>
      <label>Pixel threshold<input type="number" min="0" max="255" value={o.threshold} onChange={event => change({ threshold: Number(event.target.value) })} /></label>
      <label>Minimum region size<input type="number" min="1" value={o.minRegionSize} onChange={event => change({ minRegionSize: Number(event.target.value) })} /></label>
      <label>Group regions within pixels<input type="number" min="0" max="100" value={o.regionGap} onChange={event => change({ regionGap: Number(event.target.value) })} /></label>
      {toggle('autoAlign')}
      <label>Horizontal offset<input type="number" value={o.offsetX} onChange={event => change({ offsetX: Number(event.target.value) })} /></label>
      <label>Vertical offset<input type="number" value={o.offsetY} onChange={event => change({ offsetY: Number(event.target.value) })} /></label>
      <label>Scale %<input type="number" min="10" max="400" value={o.scale} onChange={event => change({ scale: Number(event.target.value) })} /></label>
      <label>Rotation °<input type="number" min="-180" max="180" value={o.rotation} onChange={event => change({ rotation: Number(event.target.value) })} /></label>
      <label>Perspective horizontal %<input type="number" min="-45" max="45" value={o.perspectiveX} onChange={event => change({ perspectiveX: Number(event.target.value) })} /></label>
      <label>Perspective vertical %<input type="number" min="-45" max="45" value={o.perspectiveY} onChange={event => change({ perspectiveY: Number(event.target.value) })} /></label>
      {toggle('flipX')}{toggle('flipY')}
      <label>Scan preset<select value="" onChange={event => { const preset = tab.imagePresets?.find(item => item.name === event.target.value); if (preset) change(preset.options); }}><option value="">Choose preset…</option>{tab.imagePresets?.map(preset => <option key={preset.name}>{preset.name}</option>)}</select></label>
      <button onClick={() => { const name = window.prompt('Name this image scan preset'); if (name) onImagePreset(name); }}>Save current preset</button>
      {toggle('ocr')}
      {(tab.left?.name.toLowerCase().endsWith('.pdf') || tab.right?.name.toLowerCase().endsWith('.pdf')) && <><label>PDF page<input type="number" min="1" value={o.page} onChange={event => change({ page: Number(event.target.value) })} /></label><label>PDF password<input type="password" value={o.password || ''} onChange={event => change({ password: event.target.value })} /></label></>}
    </>}
    {tab.type === 'excel' && <><label>View<select value={o.view} onChange={event => change({ view: event.target.value })}><option value="split">Side by side</option><option value="redline">Redline grid</option><option value="four">Four panes</option><option value="details">File details</option></select></label>
      {toggle('formulas')}{toggle('alignRows')}{toggle('alignColumns')}{toggle('ignoreCase')}{toggle('ignoreWhitespace')}{toggle('hideRows')}{toggle('hideColumns')}
      <label>Date order<select value={o.dateOrder} onChange={event => change({ dateOrder: event.target.value as Options['dateOrder'] })}><option value="none">None</option><option>US</option><option>EU</option></select></label>
    </>}
    {tab.type === 'folders' && <>{toggle('compareMetadata')}<label>Exclude paths<textarea value={o.exclusions.join('\n')} onChange={event => change({ exclusions: event.target.value.split('\n').filter(Boolean) })} /></label></>}
    {tab.type === 'documents' && <><label>View<select value={o.view} onChange={event => change({ view: event.target.value })}>{['split','rich','plain','image','ocr','redline'].map(view => <option key={view}>{view}</option>)}</select></label>{toggle('ocr')}
      {(tab.left?.name.toLowerCase().endsWith('.pdf') || tab.right?.name.toLowerCase().endsWith('.pdf')) && <><label>PDF page<input type="number" min="1" value={o.page} onChange={event => change({ page: Number(event.target.value) })} /></label><label>PDF password<input type="password" value={o.password || ''} onChange={event => change({ password: event.target.value })} /></label></>}</>}
    <label>Notes<textarea value={tab.notes || ''} onChange={event => onNotes(event.target.value)} placeholder="Notes for this comparison" /></label>
  </aside>;
}
function App() {
  const [tabs, setTabs] = useState<CompareTab[]>([]);
  const tabsRef = useRef<CompareTab[]>([]);
  const compareTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const projectId = useRef<string | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const activeIdRef = useRef<string | null>(null);
  const [welcome, setWelcome] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [prefs, setPrefs] = useState<Preferences>({ restoreTabs: false, skippedCommit: null, recentProjects: [] });
  const [pairing, setPairing] = useState<{ inputs: Input[]; type: Mode } | null>(null);
  const [notice, setNotice] = useState('');
  const [update, setUpdate] = useState<{ sha: string; installed: string | null } | null>(null);
  const active = tabs.find(tab => tab.id === activeId) || null;
  useEffect(() => { activeIdRef.current = activeId; }, [activeId]);
  function invalidDrop(message: string) {
    setNotice(message);
    document.body.classList.add('invalid-drop');
    setTimeout(() => document.body.classList.remove('invalid-drop'), 1800);
  }
  const commitTabs = (next: CompareTab[]) => { tabsRef.current = next; setTabs(next); };
  const patchTab = (id: string, patch: Partial<CompareTab>) => commitTabs(tabsRef.current.map(tab => tab.id === id ? { ...tab, ...patch } : tab));
  useEffect(() => {
    window.api.getSettings().then(async value => {
      setPrefs(value);
      if (value.restoreTabs && value.tabs?.length) {
        const restored = value.tabs.map(tab => ({ ...tab, result: null, busy: false, progress: 0, options: { ...defaults(), ...tab.options } }));
        commitTabs(restored); setActiveId(restored[0].id);
        restored.filter(tab => tab.left && tab.right).forEach(tab => void run(tab));
      }
      const paths = await window.api.takeStartupPaths();
      if (paths.length) {
        try { routeInputs(await window.api.describeInputs(paths)); }
        catch (error) { setNotice(humanError(error)); }
      } else if (!value.restoreTabs || !value.tabs?.length) setWelcome(true);
    });
    const stopCompare = window.api.onCompareEvent((event: CompareEvent) => {
      const tab = tabsRef.current.find(item => item.jobId === event.id);
      if (!tab) return;
      if (event.kind === 'progress') patchTab(tab.id, { progress: event.value || 0, phase: event.phase || '' });
      if (event.kind === 'result') {
        const scan = tab.type === 'images' ? { at: new Date().toISOString(), count: event.result.count, changed: event.result.changed, options: tab.options } : null;
        patchTab(tab.id, { result: event.result, busy: false, progress: 100, phase: 'Complete', error: undefined,
          ...(scan ? { scans: [...(tab.scans || []), scan].slice(-50) } : {}) });
      }
      if (event.kind === 'error') patchTab(tab.id, { busy: false, error: event.error || 'Comparison failed.' });
    });
    const stopOpen = window.api.onOpenPaths(paths => {
      window.api.describeInputs(paths).then(inputs => routeInputs(inputs)).catch(error => setNotice(humanError(error)));
    });
    return () => { stopCompare(); stopOpen(); };
  }, []);
  useEffect(() => {
    const timer = setTimeout(() => {
      if (tabs.length || prefs.restoreTabs) window.api.setSettings({ tabs: tabs.map(tab => ({ ...tab, result: null, busy: false, jobId: undefined })) });
    }, 600);
    return () => clearTimeout(timer);
  }, [tabs, prefs.restoreTabs]);
  useEffect(() => {
    const timer = setTimeout(() => window.api.checkUpdate().then(value => { if (value && value.sha !== prefs.skippedCommit) setUpdate(value); }).catch(() => {}), 2000);
    return () => clearTimeout(timer);
  }, [prefs.skippedCommit]);
  async function run(tab: CompareTab) {
    if (!tab.left || !tab.right) return;
    if (tab.jobId) await window.api.cancelCompare(tab.jobId);
    patchTab(tab.id, { busy: true, progress: 0, phase: 'Preparing', error: undefined });
    try {
      const jobId = await window.api.startCompare({ type: tab.type, left: tab.left, right: tab.right, options: tab.options });
      patchTab(tab.id, { jobId });
    } catch (error) { patchTab(tab.id, { busy: false, error: humanError(error) }); }
  }
  function schedule(tab: CompareTab) {
    const pending = compareTimers.current.get(tab.id);
    if (pending) clearTimeout(pending);
    compareTimers.current.set(tab.id, setTimeout(() => {
      compareTimers.current.delete(tab.id);
      void run(tab);
    }, 300));
  }
  function setInput(tab: CompareTab, side: 'left' | 'right', input: Input) {
    if (!input.types.includes(tab.type)) { invalidDrop('Unable to compare ' + input.name + ' as ' + tab.type + '.'); return; }
    const old = tab[side];
    const next = { ...tab, [side]: input, available: [...tab.available.filter(item => item.id !== input.id), ...(old && old.id !== input.id ? [old] : [])], result: null, decisions: undefined, dirty: true };
    patchTab(tab.id, next);
    if (tab.type === 'text') schedule(next); else void run(next);
  }
  function changeOptions(tab: CompareTab, patch: Partial<Options>) {
    const next = { ...tab, options: { ...tab.options, ...patch }, dirty: true };
    patchTab(tab.id, next);
    if (tab.left && tab.right && (Object.keys(patch).some(key => !['view','opacity','wrap','syncScroll','hideUnchanged','hideRows','hideColumns','syntaxHighlight'].includes(key)) || (tab.type === 'documents' && patch.view === 'image'))) schedule(next);
  }
  function addTab(type: Mode, left: Input | null = null, right: Input | null = null, available: Input[] = []) {
    const tab = newTab(type, left, right, available); commitTabs([...tabsRef.current, tab]); setActiveId(tab.id); setWelcome(false);
    if (left && right) void run(tab);
  }
  function routeInputs(inputs: Input[], preferred?: Mode, side?: 'left' | 'right') {
    if (!inputs.length) return;
    const current = tabsRef.current.find(tab => tab.id === activeIdRef.current) || null;
    if (inputs.length === 1) {
      const item = inputs[0];
      if (side && current) { setInput(current, side, item); return; }
      if (current && (!current.left || !current.right) && item.types.includes(current.type)) { setInput(current, current.left ? 'right' : 'left', item); setWelcome(false); return; }
      addTab(preferred && item.types.includes(preferred) ? preferred : item.types[0], item);
      return;
    }
    const type = compatible(inputs, preferred);
    if (!type) { invalidDrop('Unable to compare these inputs together: ' + inputs.map(item => item.name).join(', ')); return; }
    if (inputs.length === 2) addTab(type, inputs[0], inputs[1]);
    else { setPairing({ inputs, type }); setWelcome(false); }
  }
  async function fromDrop(event: React.DragEvent, side?: 'left' | 'right') {
    event.preventDefault(); event.stopPropagation();
    document.body.classList.remove('dragging');
    try { const paths = window.api.pathsForFiles(event.dataTransfer.files); routeInputs(await window.api.describeInputs(paths), active?.type, side); }
    catch (error) { invalidDrop(humanError(error)); }
  }
  async function browse(tab: CompareTab, side: 'left' | 'right') {
    try { const inputs = await window.api.browseInputs(tab.type); if (inputs.length === 1) setInput(tab, side, inputs[0]); else routeInputs(inputs, tab.type); }
    catch (error) { setNotice(humanError(error)); }
  }
  function closeTab(id: string) {
    const tab = tabsRef.current.find(item => item.id === id);
    if (tab?.dirty && !window.confirm('Close this comparison without saving it?')) return;
    const pending = compareTimers.current.get(id);
    if (pending) clearTimeout(pending);
    compareTimers.current.delete(id);
    const next = tabsRef.current.filter(item => item.id !== id); commitTabs(next);
    if (activeId === id) setActiveId(next.at(-1)?.id || null);
    if (!next.length) setWelcome(true);
  }
  async function save(): Promise<boolean> {
    try {
      const project = await window.api.saveProject({ id: projectId.current || undefined, name: active?.title || 'Comparisons', tabs: tabsRef.current });
      projectId.current = project.id;
      commitTabs(tabsRef.current.map(tab => ({ ...tab, dirty: false })));
      const next = await window.api.getSettings(); setPrefs(next); setNotice('Saved to ' + project.path);
      return true;
    } catch (error) { setNotice(humanError(error)); return false; }
  }
  async function load(file: string) {
    try { const project = await window.api.loadProject(file); projectId.current = project.id; const loaded = project.tabs.map(tab => ({ ...tab, result: null, busy: false, options: { ...defaults(), ...tab.options } })); commitTabs(loaded); setActiveId(loaded[0]?.id || null); setWelcome(false); loaded.filter(tab => tab.left && tab.right).forEach(tab => void run(tab)); }
    catch (error) { setNotice(humanError(error)); }
  }
  async function exportResult(tab: CompareTab, format: string) {
    if (!tab.result) return;
    try {
      const chunks = tab.type === 'documents' ? decidedChunks(tab.result.chunks || [], tab.decisions) : tab.result.chunks || [];
      if (format === 'png') await window.api.saveExport({ name: tab.title + '.png', content: tab.result.diffData.split(',')[1], base64: true, filters: [{ name: 'PNG', extensions: ['png'] }] });
      else if (format === 'text') await window.api.saveExport({ name: tab.title + '.txt', content: tab.result.rightText || '', filters: [{ name: 'Text', extensions: ['txt'] }] });
      else if (format === 'docx' || format === 'tracked') await window.api.exportDocx({ title: tab.title, chunks, tracked: format === 'tracked' });
      else if (format === 'pdfside') await window.api.exportPdf({ title: tab.title, layout: 'side', leftText: tab.result.leftText, rightText: tab.result.rightText });
      else if (format === 'pdfredline') await window.api.exportPdf({ title: tab.title, layout: 'redline', chunks });
      else if (format === 'xlsx') {
        const address = (row: number | null, col: number | null) => row && col != null ? XLSX.utils.encode_cell({ r: row - 1, c: col }) : '';
        const rows = tab.result.changed.map((item: any) => ({ OriginalCell: address(item.leftRow, item.leftColumn), ChangedCell: address(item.rightRow, item.rightColumn), Original: item.left, Changed: item.right, OriginalFormula: item.leftFormula, ChangedFormula: item.rightFormula }));
        const book = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(book, XLSX.utils.json_to_sheet(rows), 'Changes');
        const buffer = XLSX.write(book, { type: 'base64', bookType: 'xlsx' });
        await window.api.saveExport({ name: tab.title + '.xlsx', content: buffer, base64: true, filters: [{ name: 'Excel workbook', extensions: ['xlsx'] }] });
      } else {
        const lines = tab.type === 'folders' ? tab.result.entries.map((entry: any) => entry.status + ' ' + entry.relative)
          : tab.type === 'excel' ? tab.result.changed.map((item: any) => `${tab.result.leftName} ${item.leftRow && item.leftColumn != null ? XLSX.utils.encode_cell({ r: item.leftRow - 1, c: item.leftColumn }) : '—'} / ${tab.result.rightName} ${item.rightRow && item.rightColumn != null ? XLSX.utils.encode_cell({ r: item.rightRow - 1, c: item.rightColumn }) : '—'}: ${item.left} → ${item.right}${item.leftFormula || item.rightFormula ? ` [${item.leftFormula} → ${item.rightFormula}]` : ''}`)
          : tab.type === 'images' ? tab.result.regions.map((item: any, index: number) => `Region ${index + 1}: (${item.x}, ${item.y}) ${item.width} × ${item.height}, ${item.pixels} changed pixels`)
          : tab.result.chunks?.map((chunk: any) => chunk.type.toUpperCase() + ' ' + chunk.text) || [];
        await window.api.exportPdf({ title: tab.title, lines });
      }
    } catch (error) { setNotice(humanError(error)); }
  }
  async function openFolderPair(left: string, right: string) {
    try { routeInputs(await window.api.describeInputs([left, right])); }
    catch (error) { setNotice(humanError(error)); }
  }
  function appClose() {
    if (tabsRef.current.some(tab => tab.dirty) && !window.confirm('Close Norways Diff Checker with unsaved comparisons?')) return;
    void window.api.closeWindow();
  }
  return <div className="app" onDragOver={event => { if (event.dataTransfer.types.includes('Files')) { event.preventDefault(); document.body.classList.add('dragging'); } }} onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node)) document.body.classList.remove('dragging'); }} onDrop={event => { if (event.dataTransfer.types.includes('Files')) void fromDrop(event); }}>
    <Titlebar tabs={tabs} active={activeId} onSelect={setActiveId} onNew={() => setWelcome(true)} onClose={closeTab}
      onReorder={(from, to) => { const next = [...tabsRef.current]; const fromIndex = next.findIndex(tab => tab.id === from), toIndex = next.findIndex(tab => tab.id === to); if (fromIndex >= 0 && toIndex >= 0 && fromIndex !== toIndex) { next.splice(toIndex, 0, next.splice(fromIndex, 1)[0]); commitTabs(next); } }}
      onSettings={() => setSettingsOpen(true)} onSave={() => void save()} onAppClose={appClose} />
    {active ? <main className="workspace">
      <div className="workspace-top"><div><span className="small-caps">{active.type.toUpperCase()} COMPARISON</span><input className="tab-title-edit" value={active.title} onChange={event => patchTab(active.id, { title: event.target.value, dirty: true })} /></div>
        <div className="workspace-actions"><span className="change-count">{active.result?.count ?? 0} changes</span>
          {active.busy ? <button onClick={() => { if (active.jobId) void window.api.cancelCompare(active.jobId); patchTab(active.id, { busy: false }); }}>Cancel · {active.progress}%</button> : <button onClick={() => void run(active)}>Compare</button>}
          <select aria-label="Export comparison" value="" disabled={!active.result} onChange={event => { if (event.target.value) void exportResult(active, event.target.value); }}>
            <option value="">Export…</option>
            {active.type === 'images' && <option value="png">PNG difference</option>}
            {active.type === 'text' && <option value="text">Changed text</option>}
            {active.type === 'documents' && <><option value="docx">Word redline</option><option value="tracked">Word tracked changes</option></>}
            {active.type === 'excel' && <option value="xlsx">Excel change list</option>}
            {active.type === 'documents' && <><option value="pdfside">Side-by-side PDF</option><option value="pdfredline">Redline PDF</option></>}
            <option value="pdf">PDF report</option>
          </select></div></div>
      <div className="input-row"><InputSlot side="left" input={active.left} available={active.available} type={active.type} onBrowse={() => void browse(active, 'left')} onReplace={input => setInput(active, 'left', input)} onDrop={event => void fromDrop(event, 'left')} />
        <button className="swap" title="Swap sides" onClick={() => { const next = { ...active, left: active.right, right: active.left, decisions: undefined, dirty: true }; patchTab(active.id, next); void run(next); }}>⇄</button>
        <InputSlot side="right" input={active.right} available={active.available} type={active.type} onBrowse={() => void browse(active, 'right')} onReplace={input => setInput(active, 'right', input)} onDrop={event => void fromDrop(event, 'right')} /></div>
      {active.error && <div className="error-banner">{active.error}</div>}
      {active.busy && <div className="progress"><div style={{ width: active.progress + '%' }} /></div>}
      <div className="content-layout"><div className="content-main">
        {active.type === 'text' && <TextView tab={active} onText={(side, text) => { const input = { ...(active[side] || { id: crypto.randomUUID(), name: side === 'left' ? 'Original text' : 'Changed text', types: ['text' as Mode] }), text }; setInput(active, side, input); }} onOption={patch => changeOptions(active, patch)} />}
        {active.type === 'documents' && <DocumentView tab={active} onDecision={(group, decision) => patchTab(active.id, { decisions: { ...active.decisions, [group]: decision }, dirty: true })} onOrder={rightPageOrder => changeOptions(active, { rightPageOrder })} />}
        {active.type === 'images' && <ImageView tab={active} />}
        {active.type === 'excel' && <ExcelView tab={active} onOption={patch => changeOptions(active, patch)} />}
        {active.type === 'folders' && <FolderView tab={active} onOpenPair={(left, right) => void openFolderPair(left, right)} />}
      </div><OptionsPanel tab={active} change={patch => changeOptions(active, patch)} onNotes={notes => patchTab(active.id, { notes, dirty: true })}
        onImagePreset={name => {
          const keys: (keyof Options)[] = ['threshold','minRegionSize','regionGap','autoAlign','offsetX','offsetY','scale','rotation','perspectiveX','perspectiveY','flipX','flipY','page','ocr'];
          const options = Object.fromEntries(keys.map(key => [key, active.options[key]])) as Partial<Options>;
          patchTab(active.id, { imagePresets: [...(active.imagePresets || []).filter(item => item.name !== name), { name, options }], dirty: true });
        }} /></div>
    </main> : <main className="empty-workspace"><div className="empty-symbol">≠</div><h2>Ready to compare</h2><p>Drop files or folders here, or start a new comparison.</p><button className="primary" onClick={() => setWelcome(true)}>New comparison</button></main>}
    {welcome && <Welcome recent={prefs.recentProjects || []} onCreate={type => addTab(type)} onLoad={file => void load(file)} onDismiss={() => setWelcome(false)} />}
    {pairing && <Pairing inputs={pairing.inputs} type={pairing.type} onChangeType={type => setPairing({ ...pairing, type })} onCancel={() => setPairing(null)} onConfirm={(left, right, others, type) => { addTab(type, left, right, others); setPairing(null); }} />}
    {settingsOpen && <div className="modal-backdrop"><div className="settings-modal modal"><div className="small-caps">PREFERENCES</div><h2>Settings</h2>
      <label className="check"><input type="checkbox" checked={prefs.restoreTabs} onChange={async event => setPrefs(await window.api.setSettings({ restoreTabs: event.target.checked }))} />Restore previous tabs on startup</label>
      <p>Comparisons and settings are saved locally on this computer.</p><footer><button className="primary" onClick={() => setSettingsOpen(false)}>Done</button></footer>
    </div></div>}
    {update && <div className="update-banner"><strong>Update available</strong><span>Commit {update.sha.slice(0, 8)}</span><button onClick={async () => { if (await save() && !await window.api.updateNow()) setNotice('Installer is not installed yet.'); }}>Update now</button>
      <button onClick={async () => { await window.api.updateAfterClose(); setUpdate(null); setNotice('Update will run after the app closes.'); }}>After I close</button>
      <button onClick={() => setUpdate(null)}>Ignore</button><button onClick={async () => { setPrefs(await window.api.setSettings({ skippedCommit: update.sha })); setUpdate(null); }}>Ignore &amp; Skip</button></div>}
    {notice && <div className="toast" role="alert">{notice}<button onClick={() => setNotice('')}>×</button></div>}
  </div>;
}
createRoot(document.getElementById('root')!).render(<App />);
