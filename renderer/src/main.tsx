import React, { Fragment, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import hljs from 'highlight.js/lib/core';
import javascript from 'highlight.js/lib/languages/javascript';
import typescript from 'highlight.js/lib/languages/typescript';
import json from 'highlight.js/lib/languages/json';
import python from 'highlight.js/lib/languages/python';
import xml from 'highlight.js/lib/languages/xml';
import css from 'highlight.js/lib/languages/css';
import bash from 'highlight.js/lib/languages/bash';
import sql from 'highlight.js/lib/languages/sql';
import type { CompareEvent, CompareTab, DependencyProgress, Input, LibreOfficeStatus, Mode, OptionalDependency, Options, Preferences } from './types';
import './bridge';
import './styles.css';
declare const __APP_COMMIT__: string;
const spreadsheetColumn = (index: number): string => {
  let value = index + 1;
  let label = '';
  while (value > 0) { value--; label = String.fromCharCode(65 + value % 26) + label; value = Math.floor(value / 26); }
  return label;
};
const spreadsheetAddress = (row: number, column: number): string => spreadsheetColumn(column) + (row + 1);
for (const [name, grammar] of Object.entries({ javascript, typescript, json, python, xml, css, bash, sql })) hljs.registerLanguage(name, grammar);
const languageFor = (input: Input | null) => {
  const ext = input?.name.split('.').at(-1)?.toLowerCase();
  return ({ js: 'javascript', jsx: 'javascript', ts: 'typescript', tsx: 'typescript', json: 'json', py: 'python', xml: 'xml', html: 'xml', css: 'css', sh: 'bash', sql: 'sql' } as Record<string, string>)[ext || ''];
};

const modes: { id: Mode; label: string; icon: string; hint: string }[] = [
  { id: 'text', label: 'Text', icon: 'text_fields', hint: 'Words, code and logs' },
  { id: 'images', label: 'Images', icon: 'image', hint: 'Pixels, OCR and metadata' },
  { id: 'documents', label: 'Documents', icon: 'description', hint: 'PDF, Word and presentations' },
  { id: 'excel', label: 'Excel', icon: 'table_view', hint: 'Cells, sheets and formulas' },
  { id: 'folders', label: 'Folders', icon: 'folder', hint: 'Recursive file trees' }
];
const imageViews = ['split','slider','fade','flicker','subtract','highlight','ocr','rich-ocr','details'] as const;
type ImageViewMode = typeof imageViews[number];
const imageViewOrDefault = (value: unknown): ImageViewMode => typeof value === 'string' && imageViews.includes(value as ImageViewMode) ? value as ImageViewMode : 'split';
const revealInternalMaximum = 101;
const percentageMaximum = 100;
const revealToPercentage = (value: number) => value / revealInternalMaximum * percentageMaximum;
const percentageToReveal = (value: number) => value / percentageMaximum * revealInternalMaximum;
const defaults = (): Options => ({
  view: 'split', splitOrientation: 'vertical', precision: 'smart', syntaxHighlight: true, ignoreCase: false, ignoreWhitespace: false, ignoreRules: [],
  wrap: true, syncScroll: true, syncLineHeights: false, hideUnchanged: false, threshold: 24, minRegionSize: 1, regionGap: 0, autoAlign: false,
  offsetX: 0, offsetY: 0, scale: 100, rotation: 0, perspectiveX: 0, perspectiveY: 0, flipX: false, flipY: false,
  opacity: 50, sliderNoOverlap: false, flickerMs: 500, transitionMs: 500, ocr: false, page: 1, rightPageOrder: [],
  leftSheet: '', rightSheet: '', formulas: false, alignRows: true, alignColumns: true, hideRows: false, hideColumns: false, dateOrder: 'none',
  sortColumn: '', exclusions: ['node_modules', '.git'], compareMetadata: false
});
const newTab = (type: Mode, left: Input | null = null, right: Input | null = null, available: Input[] = [], imageView: ImageViewMode = 'split'): CompareTab => ({
  id: crypto.randomUUID(), title: modes.find(mode => mode.id === type)?.label || type, type,
  left, right, available, options: { ...defaults(), ...(type === 'images' ? { view: imageView, ...(imageView === 'slider' ? { opacity: percentageToReveal(50) } : {}) } : {}) }, result: null, busy: false, progress: 0, phase: ''
});
const persistentInput = (input: Input | null) => input?.path ? { ...input, text: undefined } : null;
const persistentOptions = (options: Options): Options => ({ ...options, password: undefined });
const persistentTab = (tab: CompareTab): CompareTab => ({
  ...tab,
  left: persistentInput(tab.left),
  right: persistentInput(tab.right),
  available: tab.available.filter(input => input.path).map(input => ({ ...input, text: undefined })),
  options: persistentOptions(tab.options),
  scans: tab.scans?.map(scan => ({ ...scan, options: persistentOptions({ ...defaults(), ...scan.options }) })),
  result: null,
  busy: false,
  progress: 0,
  phase: '',
  jobId: undefined,
  needsCompare: undefined
});
const transferableTab = (tab: CompareTab): CompareTab => ({
  ...tab,
  options: persistentOptions(tab.options),
  scans: tab.scans?.map(scan => ({ ...scan, options: persistentOptions({ ...defaults(), ...scan.options }) })),
  result: null,
  busy: false,
  progress: 0,
  phase: '',
  jobId: undefined,
  needsCompare: Boolean(tab.left && tab.right)
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
function externalTypes(input: Input): Mode[] {
  const specific = input.types.filter(type => type !== 'text');
  return specific.length ? specific : ['text'];
}
function humanError(error: unknown) { return error instanceof Error ? error.message : String(error); }
function formatBytes(value: number) {
  const units = ['B', 'KB', 'MB', 'GB'];
  let amount = Math.max(0, value), unit = 0;
  while (amount >= 1024 && unit < units.length - 1) { amount /= 1024; unit++; }
  return `${amount >= 100 || unit === 0 ? amount.toFixed(0) : amount.toFixed(1)} ${units[unit]}`;
}
function MaterialIcon({ name, className = '' }: { name: string; className?: string }) {
  return <span className={'material-symbols-outlined ' + className} aria-hidden="true">{name}</span>;
}
function IconButton({ name, title, onClick, className = '' }: { name: string; title: string; onClick: () => void; className?: string }) {
  return <button className={className} title={title} aria-label={title} onClick={onClick}><MaterialIcon name={name} /></button>;
}
function DraggableDialog({ title, eyebrow, icon, className = '', onClose, children }: {
  title: string; eyebrow: string; icon: string; className?: string; onClose: () => void; children: React.ReactNode;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  const dragRef = useRef<{ pointerId: number; offsetX: number; offsetY: number } | null>(null);
  const [position, setPosition] = useState<{ x: number; y: number } | null>(null);
  const clampPosition = (x: number, y: number) => {
    const dialog = dialogRef.current;
    const backdrop = dialog?.parentElement;
    if (!dialog || !backdrop) return { x, y };
    return {
      x: Math.max(10, Math.min(x, backdrop.clientWidth - dialog.offsetWidth - 10)),
      y: Math.max(10, Math.min(y, backdrop.clientHeight - dialog.offsetHeight - 10))
    };
  };
  useEffect(() => {
    const handleResize = () => setPosition(current => current ? clampPosition(current.x, current.y) : null);
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);
  useEffect(() => {
    closeRef.current = onClose;
  }, [onClose]);
  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = dialogRef.current;
    const focusable = () => Array.from(dialog?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])') || []);
    focusable()[0]?.focus();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { closeRef.current(); return; }
      if (event.key !== 'Tab') return;
      const items = focusable();
      if (!items.length) return;
      const first = items[0], last = items.at(-1)!;
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => { window.removeEventListener('keydown', handleKeyDown); previousFocus?.focus(); };
  }, []);
  return <div className="modal-backdrop"><div
    ref={dialogRef}
    className={'modal dialog-window ' + className}
    role="dialog"
    aria-modal="true"
    aria-label={title}
    style={position ? { left: position.x, top: position.y } : undefined}
  >
    <header className="dialog-titlebar" onDoubleClick={() => setPosition(null)} onPointerDown={event => {
      if (event.button !== 0 || (event.target as HTMLElement).closest('button')) return;
      const bounds = dialogRef.current?.getBoundingClientRect();
      if (!bounds) return;
      dragRef.current = { pointerId: event.pointerId, offsetX: event.clientX - bounds.left, offsetY: event.clientY - bounds.top };
      event.currentTarget.setPointerCapture(event.pointerId);
      setPosition({ x: bounds.left, y: bounds.top - 36 });
    }} onPointerMove={event => {
      const drag = dragRef.current;
      if (!drag || drag.pointerId !== event.pointerId) return;
      setPosition(clampPosition(event.clientX - drag.offsetX, event.clientY - drag.offsetY - 36));
    }} onPointerUp={event => {
      if (dragRef.current?.pointerId !== event.pointerId) return;
      dragRef.current = null;
      event.currentTarget.releasePointerCapture(event.pointerId);
    }} onPointerCancel={() => { dragRef.current = null; }}>
      <span className="dialog-app-icon"><MaterialIcon name={icon} /></span>
      <span className="dialog-title"><strong>{title}</strong><small>{eyebrow}</small></span>
      <IconButton name="close" title={'Close ' + title} className="dialog-close" onClick={onClose} />
    </header>
    <div className="dialog-body">{children}</div>
  </div></div>;
}
function ScrubbableNumber({ value, min, max, step = 1, onChange }: {
  value: number; min: number; max: number; step?: number; onChange: (value: number) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(String(Math.round(value * 1000) / 1000));
  const elementRef = useRef<HTMLInputElement>(null);
  const dragging = useRef<{ pointerId: number; left: number; width: number } | null>(null);
  const stepPrecision = Math.max(0, String(step).split('.')[1]?.length || 0);
  const displayValue = Number(value.toFixed(stepPrecision));
  const progress = Math.max(0, Math.min(100, (value - min) / Math.max(1, max - min) * 100));
  useEffect(() => { if (!editing) setDraft(String(displayValue)); }, [displayValue, editing]);
  useEffect(() => {
    if (!editing) return;
    elementRef.current?.focus();
    elementRef.current?.select();
  }, [editing]);
  const clamp = (next: number) => Math.max(min, Math.min(max, next));
  const scrub = (clientX: number) => {
    const drag = dragging.current;
    if (!drag) return;
    const ratio = Math.max(0, Math.min(1, (clientX - drag.left) / Math.max(1, drag.width)));
    const next = min + Math.round((ratio * (max - min)) / step) * step;
    onChange(clamp(Number(next.toFixed(10))));
  };
  const commit = () => {
    const next = Number(draft);
    if (Number.isFinite(next)) onChange(clamp(next));
    else setDraft(String(displayValue));
    window.getSelection()?.removeAllRanges();
    setEditing(false);
  };
  const cancel = () => {
    setDraft(String(displayValue));
    window.getSelection()?.removeAllRanges();
    setEditing(false);
  };
  return <span
    className={'scrubbable-number' + (editing ? ' editing' : '')}
    style={{ '--scrub-progress': `${progress}%` } as React.CSSProperties}
    title={editing ? 'Type a value' : 'Drag to adjust; double-click to type'}
    onDoubleClick={() => setEditing(true)}
    onPointerDown={event => {
      if (editing || event.detail > 1) return;
      event.preventDefault();
      const bounds = event.currentTarget.getBoundingClientRect();
      dragging.current = { pointerId: event.pointerId, left: bounds.left, width: bounds.width };
      event.currentTarget.setPointerCapture(event.pointerId);
      scrub(event.clientX);
    }}
    onPointerMove={event => { if (dragging.current?.pointerId === event.pointerId) scrub(event.clientX); }}
    onPointerUp={event => {
      if (dragging.current?.pointerId !== event.pointerId) return;
      dragging.current = null;
      event.currentTarget.releasePointerCapture(event.pointerId);
    }}
    onPointerCancel={() => { dragging.current = null; }}
  ><input
      ref={elementRef}
      type="number"
      className="scrubbable-number-input"
      min={min}
      max={max}
      step={step}
      value={editing ? draft : displayValue}
      readOnly={!editing}
      style={{ '--edit-width': `${Math.max(3, String(editing ? draft : displayValue).length + 1)}ch` } as React.CSSProperties}
      onChange={event => setDraft(event.target.value)}
      onBlur={() => { if (editing) commit(); }}
      onKeyDown={event => {
        if (!editing && (event.key === 'Enter' || event.key === 'F2')) { event.preventDefault(); setEditing(true); }
        else if (editing && event.key === 'Enter') { event.preventDefault(); commit(); }
        else if (editing && event.key === 'Escape') { event.preventDefault(); cancel(); }
      }}
    /></span>;
}
const tabDragType = 'application/x-norways-tab';
const tabTokenType = 'application/x-norways-tab-token';
function Titlebar({ tabs, active, onSelect, onNew, onClose, onReorder, onReceive, onSettings, onAppClose }: {
  tabs: CompareTab[]; active: string | null; onSelect: (id: string) => void; onNew: () => void; onClose: (id: string) => void; onReorder: (from: string, to: string, after: boolean) => void;
  onReceive: (tab: CompareTab, to: string | null, after: boolean) => void;
  onSettings: () => void; onAppClose: () => void;
}) {
  const [maximized, setMaximized] = useState(false);
  const [dragPreview, setDragPreview] = useState<Pick<CompareTab, 'id' | 'title' | 'type'> | null>(null);
  const [ghostIndex, setGhostIndex] = useState<number | null>(null);
  const dragToken = useRef('');
  const localDragId = useRef('');
  const dragPosition = useRef({ clientX: 0, clientY: 0, screenX: 0, screenY: 0 });
  const tabsElement = useRef<HTMLElement>(null);
  useEffect(() => {
    window.api.isWindowMaximized().then(setMaximized);
    const stopMaximized = window.api.onWindowMaximizedChange(setMaximized);
    const stopDragState = window.api.onTabDragState(preview => {
      setDragPreview(preview);
      if (!preview) setGhostIndex(null);
    });
    return () => { stopMaximized(); stopDragState(); };
  }, []);
  const updateGhost = (clientX: number) => {
    if (localDragId.current || !dragPreview || tabs.some(tab => tab.id === dragPreview.id)) { setGhostIndex(null); return; }
    const tabElements = Array.from(tabsElement.current?.querySelectorAll<HTMLElement>('.tab:not(.tab-ghost)') || []);
    const index = tabElements.findIndex(element => clientX < element.getBoundingClientRect().left + element.clientWidth / 2);
    setGhostIndex(index < 0 ? tabs.length : index);
  };
  const ghostTab = dragPreview && ghostIndex !== null ? <div className="tab tab-ghost" aria-hidden="true">
    <MaterialIcon name={modes.find(mode => mode.id === dragPreview.type)?.icon || 'draft'} className="tab-symbol" /><span className="tab-name">{dragPreview.title}</span>
  </div> : null;
  return <header className="titlebar" data-tauri-drag-region>
    <div className="brand" data-tauri-drag-region>NORWAYS DIFF CHECKER</div>
    <nav ref={tabsElement} className="tabs" data-tauri-drag-region role="tablist" aria-label="Comparison tabs"
      onDragOver={event => { if (event.dataTransfer.types.includes(tabTokenType)) { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; document.body.classList.remove('detaching-tab'); updateGhost(event.clientX); } }}
      onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setGhostIndex(null); }}
      onDrop={async event => {
        const token = event.dataTransfer.getData(tabTokenType);
        if (!token) return;
        event.preventDefault();
        document.body.classList.remove('detaching-tab');
        setGhostIndex(null);
        const tab = await window.api.acceptTabDrag(token);
        if (tab) {
          const index = ghostIndex ?? tabs.length;
          onReceive(tab, index < tabs.length ? tabs[index].id : null, false);
        }
      }}>
      {tabs.map((tab, index) => <Fragment key={tab.id}>{ghostIndex === index && ghostTab}<div draggable className={'tab ' + (active === tab.id ? 'selected' : '')} role="tab" aria-selected={active === tab.id} tabIndex={active === tab.id ? 0 : -1} onClick={() => onSelect(tab.id)}
        onKeyDown={event => {
          if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSelect(tab.id); return; }
          if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
          event.preventDefault();
          const nextIndex = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
          onSelect(tabs[nextIndex].id);
          requestAnimationFrame(() => tabsElement.current?.querySelectorAll<HTMLElement>('[role="tab"]')[nextIndex]?.focus());
        }}
        onDragStart={event => {
          localDragId.current = tab.id;
          dragToken.current = window.api.beginTabDrag(crypto.randomUUID(), transferableTab(tab), tabs.length);
          event.dataTransfer.setData(tabDragType, tab.id);
          event.dataTransfer.setData(tabTokenType, dragToken.current);
          event.dataTransfer.effectAllowed = 'linkMove';
        }}
        onDragOver={event => {
          if (!event.dataTransfer.types.includes(tabTokenType)) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = 'move';
          const from = localDragId.current;
          if (from) onReorder(from, tab.id, event.clientX >= event.currentTarget.getBoundingClientRect().left + event.currentTarget.clientWidth / 2);
        }}
        onDrop={async event => {
          const token = event.dataTransfer.getData(tabTokenType);
          if (!token) return;
          event.preventDefault(); event.stopPropagation();
          const from = event.dataTransfer.getData(tabDragType);
          if (from && tabs.some(item => item.id === from)) { await window.api.endTabDrag(token); return; }
          const received = await window.api.acceptTabDrag(token);
          setGhostIndex(null);
          if (received) onReceive(received, tab.id, event.clientX >= event.currentTarget.getBoundingClientRect().left + event.currentTarget.clientWidth / 2);
        }}
        onDrag={event => {
          if (event.clientX || event.clientY || event.screenX || event.screenY) dragPosition.current = { clientX: event.clientX, clientY: event.clientY, screenX: event.screenX, screenY: event.screenY };
        }}
        onDragEnd={event => {
          const token = dragToken.current;
          dragToken.current = '';
          localDragId.current = '';
          if (!token) return;
          const position = event.clientX || event.clientY || event.screenX || event.screenY
            ? { clientX: event.clientX, clientY: event.clientY, screenX: event.screenX, screenY: event.screenY }
            : dragPosition.current;
          const bounds = tabsElement.current?.getBoundingClientRect();
          const insideTabs = !!bounds && position.clientX >= bounds.left && position.clientX <= bounds.right && position.clientY >= bounds.top && position.clientY <= bounds.bottom;
          document.body.classList.remove('detaching-tab');
          if (event.dataTransfer.dropEffect === 'move' || insideTabs) void window.api.endTabDrag(token);
          else void window.api.detachTab(token, { x: position.screenX, y: position.screenY });
        }}>
        <MaterialIcon name={modes.find(mode => mode.id === tab.type)?.icon || 'draft'} className="tab-symbol" /><span className="tab-name">{tab.title}</span>
        <button className="tab-close" title={'Close ' + tab.title} aria-label={'Close ' + tab.title} onClick={event => { event.stopPropagation(); onClose(tab.id); }}><MaterialIcon name="close" /></button>
      </div></Fragment>)}
      {ghostIndex === tabs.length && ghostTab}
      <button className="new-tab" title="New comparison" aria-label="New comparison" onClick={onNew}><MaterialIcon name="add" /></button>
    </nav>
    <div className="title-actions">
      <button onClick={onSettings} title="Settings" aria-label="Settings"><MaterialIcon name="settings" /></button>
    </div>
    <div className="window-controls">
      <IconButton name="minimize" title="Minimize" className="window-control" onClick={() => void window.api.minimizeWindow()} />
      <IconButton name={maximized ? 'filter_none' : 'crop_square'} title={maximized ? 'Restore' : 'Maximize'} className="window-control" onClick={async () => setMaximized(await window.api.toggleMaximizeWindow())} />
      <IconButton name="close" title="Close" className="window-control window-close" onClick={onAppClose} />
    </div>
  </header>;
}
function Welcome({ recent, recentEnabled, onCreate, onOpenRecent, onRemoveRecent, onNotice, onDismiss }: {
  recent: Preferences['recentCompares']; recentEnabled: boolean; onCreate: (type: Mode) => void; onOpenRecent: (item: Preferences['recentCompares'][number]) => void;
  onRemoveRecent: (item: Preferences['recentCompares'][number]) => void;
  onNotice: (message: string, tone?: 'error' | 'success') => void; onDismiss: () => void;
}) {
  const [openingMaintenance, setOpeningMaintenance] = useState(false);
  const openMaintenanceTool = async () => {
    setOpeningMaintenance(true);
    try {
      await window.api.openMaintenanceTool();
      onNotice('Installation manager was opened.', 'success');
    } catch (error) { onNotice('Unable to open the installation manager: ' + humanError(error)); }
    finally { setOpeningMaintenance(false); }
  };
  return <DraggableDialog title="Welcome" eyebrow="NORWAYS DIFF CHECKER" icon="difference" className="welcome" onClose={onDismiss}>
    <div className="welcome-head"><div><h1>What would you like to compare?</h1><p>Choose a comparison or drop files and folders anywhere in the window.</p></div>
      <div className="welcome-actions">
        <button type="button" disabled={openingMaintenance} title="Manage installation" onClick={() => void openMaintenanceTool()}><MaterialIcon name={openingMaintenance ? 'progress_activity' : 'build'} /><span><small>VERSION</small>{openingMaintenance ? 'Opening…' : __APP_COMMIT__}</span></button>
        <button type="button" title="Open Norway174 on GitHub" onClick={() => void window.api.openExternalUrl('https://github.com/Norway174')}><MaterialIcon name="open_in_new" /><span><small>PROJECT</small>Open GitHub</span></button>
      </div>
    </div>
    <div className={'welcome-columns' + (recentEnabled ? '' : ' recent-disabled')}>{recentEnabled && <div className="recent"><div className="section-title">Recent comparisons</div>
      {recent.length ? <div className="recent-list">{recent.map(item => <div className="recent-item" key={`${item.type}:${item.left}:${item.right}`}>
        <button className="recent-open" onClick={() => onOpenRecent(item)} title={`${item.left}\n${item.right}`}>
          <span className="recent-filenames"><span>{item.left.split(/[\\/]/).at(-1)}</span><span>{item.right.split(/[\\/]/).at(-1)}</span></span><MaterialIcon name="arrow_forward" className="recent-arrow" />
        </button>
        <button className="recent-remove" type="button" title="Remove from recent comparisons" aria-label="Remove from recent comparisons" onClick={() => onRemoveRecent(item)}><MaterialIcon name="close" /></button>
      </div>)}</div> : <p>No recent comparisons yet.</p>}
    </div>}<div className="welcome-types"><div className="section-title">Compare types</div><div className="welcome-modes">{modes.map(mode => <button className="mode-card" key={mode.id} onClick={() => onCreate(mode.id)}>
      <MaterialIcon name={mode.icon} className="mode-icon" /><span><strong>{mode.label}</strong><small>{mode.hint}</small></span><MaterialIcon name="arrow_outward" className="mode-action" />
    </button>)}</div></div>
    </div>
  </DraggableDialog>;
}
type SettingsCategory = 'all' | 'general' | 'history' | 'system' | 'third-party';
const settingsCategories: { id: SettingsCategory; label: string; icon: string; hint: string; keywords: string }[] = [
  { id: 'all', label: 'All', icon: 'apps', hint: 'Every setting', keywords: 'all general history system third party startup workspace recent comparisons storage explorer context menu dependencies' },
  { id: 'general', label: 'General', icon: 'tune', hint: 'Startup and workspace', keywords: 'restore previous tabs startup workspace' },
  { id: 'history', label: 'History', icon: 'history', hint: 'Recent comparisons', keywords: 'recent comparisons history limit' },
  { id: 'system', label: 'System', icon: 'computer', hint: 'Storage and Explorer', keywords: 'app data folder windows explorer context menu install uninstall' },
  { id: 'third-party', label: 'Third Party', icon: 'extension', hint: 'Optional dependencies', keywords: 'third party optional libreoffice pdfium ocr models image pdf document dependency download delete word presentation render' }
];
function Settings({ prefs, appDataPath, contextMenuInstalled, contextMenuBusy, initialQuery, onPrefs, onContextMenuBusy, onContextMenuInstalled, onNotice, onClose }: {
  prefs: Preferences; appDataPath: string; contextMenuInstalled: boolean | null; contextMenuBusy: boolean;
  initialQuery: string;
  onPrefs: (value: Preferences) => void; onContextMenuBusy: (value: boolean) => void; onContextMenuInstalled: (value: boolean) => void;
  onNotice: (message: string, tone?: 'error' | 'success') => void; onClose: () => void;
}) {
  const [category, setCategory] = useState<SettingsCategory>('all');
  const [query, setQuery] = useState(initialQuery);
  const [libreOffice, setLibreOffice] = useState<LibreOfficeStatus | null>(null);
  const [dependencyProgress, setDependencyProgress] = useState<DependencyProgress | null>(null);
  const [dependencyBusy, setDependencyBusy] = useState(false);
  const [optional, setOptional] = useState<Partial<Record<OptionalDependency, LibreOfficeStatus>>>({});
  const [optionalProgress, setOptionalProgress] = useState<Partial<Record<OptionalDependency, DependencyProgress>>>({});
  const [optionalBusy, setOptionalBusy] = useState<OptionalDependency | null>(null);
  const normalizedQuery = query.trim().toLowerCase();
  const visibleCategories = settingsCategories.filter(item => !normalizedQuery || (item.id !== 'all' && `${item.label} ${item.hint} ${item.keywords}`.toLowerCase().includes(normalizedQuery)));
  const selectedCategory = visibleCategories.some(item => item.id === category) ? category : visibleCategories[0]?.id;
  const savePreferences = async (patch: Partial<Preferences>) => {
    try {
      const value = await window.api.setSettings(patch);
      onPrefs(value);
    } catch (error) { onNotice('Unable to save settings: ' + humanError(error)); }
  };
  useEffect(() => {
    void window.api.getLibreOfficeStatus().then(setLibreOffice).catch(error => onNotice('Unable to check LibreOffice: ' + humanError(error)));
    for (const kind of ['pdfium', 'ocr'] as const) {
      void window.api.getOptionalDependencyStatus(kind).then(status => setOptional(current => ({ ...current, [kind]: status }))).catch(error => onNotice(`Unable to check ${kind}: ` + humanError(error)));
    }
    const stopLibreOffice = window.api.onLibreOfficeProgress(setDependencyProgress);
    const stopOptional = window.api.onOptionalDependencyProgress(progress => setOptionalProgress(current => ({ ...current, [progress.kind]: progress })));
    return () => { stopLibreOffice(); stopOptional(); };
  }, []);
  const changeLibreOffice = async () => {
    setDependencyBusy(true);
    try {
      const deleting = Boolean(libreOffice?.installed);
      const next = deleting ? await window.api.deleteLibreOffice() : await window.api.installLibreOffice();
      setLibreOffice(next);
      setDependencyProgress(null);
      onNotice(deleting ? 'LibreOffice was deleted.' : 'LibreOffice is ready to use.', 'success');
    } catch (error) { onNotice('Unable to update LibreOffice: ' + humanError(error)); }
    finally { setDependencyBusy(false); }
  };
  const changeOptional = async (kind: OptionalDependency) => {
    setOptionalBusy(kind);
    try {
      const deleting = Boolean(optional[kind]?.installed);
      const status = deleting ? await window.api.deleteOptionalDependency(kind) : await window.api.installOptionalDependency(kind);
      setOptional(current => ({ ...current, [kind]: status }));
      setOptionalProgress(current => ({ ...current, [kind]: undefined }));
      onNotice(`${kind === 'pdfium' ? 'PDFium' : 'OCR models'} ${deleting ? 'deleted' : 'ready to use'}.`, 'success');
    } catch (error) { onNotice(`Unable to update ${kind === 'pdfium' ? 'PDFium' : 'OCR models'}: ` + humanError(error)); }
    finally { setOptionalBusy(null); }
  };
  return <DraggableDialog title="Settings" eyebrow="NORWAYS DIFF CHECKER" icon="settings" className="settings-modal" onClose={onClose}>
    <div className="settings-search"><MaterialIcon name="search" /><input value={query} onChange={event => setQuery(event.target.value)} placeholder="Search settings" aria-label="Search settings" />{query && <button type="button" title="Clear search" aria-label="Clear search" onClick={() => setQuery('')}><MaterialIcon name="close" /></button>}</div>
    <div className="settings-layout">
      <nav className="settings-nav" aria-label="Settings categories">{visibleCategories.map(item => <button type="button" key={item.id} className={selectedCategory === item.id ? 'selected' : ''} onClick={() => setCategory(item.id)}>
        <MaterialIcon name={item.icon} /><span><strong>{item.label}</strong><small>{item.hint}</small></span>
      </button>)}</nav>
      <section className="settings-main">
        {!selectedCategory && <div className="settings-empty"><MaterialIcon name="search_off" /><strong>No settings found</strong><span>Try a different search.</span></div>}
        {(selectedCategory === 'all' || selectedCategory === 'general') && <><div className="settings-section-head"><span className="settings-section-icon"><MaterialIcon name="tune" /></span><div><h2>General</h2><p>Control how your workspace starts.</p></div></div>
          <div className="settings-group"><div className="settings-group-title">Startup</div><button className="settings-toggle" type="button" role="switch" aria-checked={prefs.restoreTabs} onClick={() => void savePreferences({ restoreTabs: !prefs.restoreTabs })}>
            <span><strong>Restore previous tabs</strong><small>Reopen your comparison workspace when the app starts.</small></span><span className="toggle-track" aria-hidden="true"><span /></span>
          </button></div>
        </>}
        {(selectedCategory === 'all' || selectedCategory === 'history') && <><div className="settings-section-head"><span className="settings-section-icon"><MaterialIcon name="history" /></span><div><h2>History</h2><p>Choose how many comparisons appear on Welcome.</p></div></div>
          <div className="settings-group"><div className="settings-group-title">Recent comparisons</div><label className="settings-number"><span><strong>Items to remember</strong><small>Set to 0 to disable recent comparisons.</small></span><ScrubbableNumber min={0} max={50} value={prefs.recentCompareLimit} onChange={recentCompareLimit => {
            const next = { ...prefs, recentCompareLimit, recentCompares: prefs.recentCompares.slice(0, recentCompareLimit) };
            onPrefs(next);
            void savePreferences({ recentCompareLimit });
          }} /></label></div>
        </>}
        {(selectedCategory === 'all' || selectedCategory === 'system') && <><div className="settings-section-head"><span className="settings-section-icon"><MaterialIcon name="computer" /></span><div><h2>System</h2><p>Manage local storage and Windows integration.</p></div></div>
          <div className="settings-group"><div className="settings-group-title">Storage</div><div className="settings-path"><label htmlFor="app-data-path"><strong>App data folder</strong><small>Preferences, projects, and cache are stored here.</small></label><div><input id="app-data-path" readOnly value={appDataPath} /><button type="button" title="Open app data folder" aria-label="Open app data folder" onClick={() => void window.api.openAppDataFolder().catch(error => onNotice('Unable to open the app data folder: ' + humanError(error)))}><MaterialIcon name="folder_open" /></button></div></div></div>
          <div className="settings-group"><div className="settings-group-title">Windows Explorer</div><div className="settings-action-row"><span><strong>Explorer context menu</strong><small>Add “Compare this file” and “Compare this folder” to Windows Explorer.</small></span><button className={contextMenuInstalled ? 'danger' : 'primary'} type="button" disabled={contextMenuBusy || contextMenuInstalled === null} onClick={async () => {
            onContextMenuBusy(true);
            try { onContextMenuInstalled(await window.api.setShellContextMenuInstalled(!contextMenuInstalled)); }
            catch (error) { onNotice('Unable to update the Windows context menu: ' + humanError(error)); }
            finally { onContextMenuBusy(false); }
          }}>{contextMenuInstalled === null ? 'Checking…' : contextMenuBusy ? 'Updating…' : contextMenuInstalled ? 'Uninstall' : 'Install'}</button></div></div>
        </>}
        {(selectedCategory === 'all' || selectedCategory === 'third-party') && <><div className="settings-section-head"><span className="settings-section-icon"><MaterialIcon name="extension" /></span><div><h2>Third Party</h2><p>Manage optional software used by comparison features.</p></div></div>
          <div className="settings-group"><div className="settings-group-title">Optional downloads</div><div className="settings-dependency"><div className="settings-action-row"><span><strong>LibreOffice {libreOffice?.version || ''}</strong><small>{libreOffice?.installed ? `${formatBytes(libreOffice.installedBytes)} installed. Used only to render Word and presentation pages.` : libreOffice ? `${formatBytes(libreOffice.downloadBytes)} download, about ${formatBytes(libreOffice.installedBytesEstimate)} installed. Optional for rendered Office document pages.` : 'Checking local installation...'}</small></span><button className={libreOffice?.installed ? 'danger' : 'primary'} type="button" disabled={dependencyBusy || !libreOffice} onClick={() => void changeLibreOffice()}>{dependencyBusy ? dependencyProgress?.phase || 'Working…' : libreOffice?.installed ? 'Delete' : 'Download'}</button></div>
            {dependencyBusy && <div className="dependency-progress" role="progressbar" aria-label="LibreOffice installation progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={dependencyProgress?.percent || 0}><div style={{ width: `${dependencyProgress?.percent || 0}%` }} /><span>{dependencyProgress?.phase || 'Preparing'}{dependencyProgress && ['Downloading', 'Installing'].includes(dependencyProgress.phase) ? ` · ${formatBytes(dependencyProgress.receivedBytes)} of ${formatBytes(dependencyProgress.totalBytes)}` : ''}</span></div>}
            {(['pdfium', 'ocr'] as const).map(kind => { const status = optional[kind]; const progress = optionalProgress[kind]; const busy = optionalBusy === kind; const label = kind === 'pdfium' ? 'PDFium' : 'OCR models'; return <Fragment key={kind}><div className="settings-action-row"><span><strong>{label} {status?.version || ''}</strong><small>{status?.installed ? `${formatBytes(status.installedBytes)} installed. ${kind === 'pdfium' ? 'Used for PDF rendering and text extraction.' : 'Used to read text in images and scanned pages.'}` : status ? `${formatBytes(status.downloadBytes)} download. ${kind === 'pdfium' ? 'Required for PDF features.' : 'Required for image and scanned-page text recognition.'}` : 'Checking local installation...'}</small></span><button className={status?.installed ? 'danger' : 'primary'} type="button" disabled={!status || optionalBusy !== null} onClick={() => void changeOptional(kind)}>{busy ? progress?.phase || 'Working…' : status?.installed ? 'Delete' : 'Download'}</button></div>{busy && progress && <div className="dependency-progress" role="progressbar" aria-label={`${label} installation progress`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress.percent}><div style={{ width: `${progress.percent}%` }} /><span>{progress.phase} · {formatBytes(progress.receivedBytes)} of {formatBytes(progress.totalBytes)}</span></div>}</Fragment>; })}
          </div></div>
        </>}
      </section>
    </div>
    <footer className="settings-footer"><span>Changes are saved automatically.</span><button className="primary" onClick={onClose}>Done</button></footer>
  </DraggableDialog>;
}
function Pairing({ inputs, type, onChangeType, onCancel, onConfirm }: {
  inputs: Input[]; type: Mode; onChangeType: (type: Mode) => void; onCancel: () => void; onConfirm: (left: Input, right: Input, others: Input[], type: Mode) => void;
}) {
  const [left, setLeft] = useState(inputs[0]?.id);
  const [right, setRight] = useState(inputs[1]?.id);
  const inputLeft = inputs.find(input => input.id === left)!;
  const inputRight = inputs.find(input => input.id === right)!;
  return <DraggableDialog title="Pair inputs" eyebrow="NORWAYS DIFF CHECKER" icon="compare_arrows" className="pairing" onClose={onCancel}>
    <div className="small-caps">PAIR INPUTS</div><h2>Choose two to compare</h2><p>Only two inputs are active in a comparison. The rest stay available for later swaps.</p>
    <div className="pair-row">
      <label>Original<select value={left} onChange={event => { if (event.target.value === right) setRight(left); setLeft(event.target.value); }}>{inputs.map(input => <option key={input.id} value={input.id}>{input.name}</option>)}</select></label>
      <button title="Swap sides" aria-label="Swap sides" onClick={() => { setLeft(right); setRight(left); }}><MaterialIcon name="swap_horiz" /></button>
      <label>Changed<select value={right} onChange={event => { if (event.target.value === left) setLeft(right); setRight(event.target.value); }}>{inputs.map(input => <option key={input.id} value={input.id}>{input.name}</option>)}</select></label>
    </div>
    <label className="type-select">Compare as<select value={type} onChange={event => onChangeType(event.target.value as Mode)}>{modes.filter(mode => inputs.every(input => input.types.includes(mode.id))).map(mode => <option key={mode.id} value={mode.id}>{mode.label}</option>)}</select></label>
    <div className="pair-list">{inputs.map(input => <div key={input.id}><span>{input.name}</span><small>{input.id === left ? 'Original' : input.id === right ? 'Changed' : 'Available'}</small></div>)}</div>
    <footer><button onClick={onCancel}>Cancel</button><button className="primary" onClick={() => onConfirm(inputLeft, inputRight, inputs.filter(input => input.id !== left && input.id !== right), type)}>Compare</button></footer>
  </DraggableDialog>;
}
function InputSlot({ side, input, available, type, onBrowse, onReplace, onDrop }: {
  side: 'left' | 'right'; input: Input | null; available: Input[]; type: Mode;
  onBrowse: () => void; onReplace: (input: Input) => void; onDrop: (event: React.DragEvent) => void;
}) {
  return <div className="input-slot" onDragOver={event => { if (event.dataTransfer.types.includes('Files')) { event.preventDefault(); event.stopPropagation(); } }} onDrop={event => { if (event.dataTransfer.types.includes('Files')) onDrop(event); }}>
    <div className="small-caps">{side === 'left' ? 'ORIGINAL' : 'CHANGED'}</div>
    <div className="slot-name">{input ? input.name : 'Drop ' + ({ text: 'text', images: 'an image', documents: 'a document', excel: 'a spreadsheet', folders: 'a folder' }[type]) + ' here'}</div>
    <button onClick={onBrowse}>Browse…</button>
    {!!available.length && <select aria-label={'Replace ' + side + ' input'} value="" onChange={event => { const selected = available.find(item => item.id === event.target.value); if (selected) onReplace(selected); }}>
      <option value="">Replace from list…</option>{available.filter(item => item.types.includes(type)).map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
    </select>}
  </div>;
}
function DiffText({ result, options, language, selectedGroup, changeGroups, onSelectGroup }: { result: any; options: Options; language?: string; selectedGroup?: number; changeGroups?: Map<any, number>; onSelectGroup?: (group: number) => void }) {
  const [page, setPage] = useState(0);
  const [rowHeights, setRowHeights] = useState<number[]>([]);
  const splitRefs = useRef<Array<HTMLElement | null>>([null, null]);
  const rowRefs = useRef<Array<Array<HTMLDivElement | null>>>([[], []]);
  const scrollLock = useRef(false);
  useEffect(() => setPage(0), [result]);
  const hasChunks = !!result?.chunks;
  const chunks = !hasChunks ? [] : result.chunks;
  const groups: any[][] = [];
  for (let index = 0; index < chunks.length;) {
    if (chunks[index].type === 'same') {
      groups.push([chunks[index++]]);
      continue;
    }
    const group: any[] = [];
    while (index < chunks.length && chunks[index].type !== 'same') group.push(chunks[index++]);
    groups.push(group);
  }
  const displayedGroups = options.hideUnchanged ? groups.filter(group => group[0]?.type !== 'same') : groups;
  const pageSize = 300;
  const pages: any[][][] = [[]];
  let pageLength = 0;
  for (const group of displayedGroups) {
    if (pageLength > 0 && pageLength + group.length > pageSize) {
      pages.push([]);
      pageLength = 0;
    }
    pages.at(-1)!.push(group);
    pageLength += group.length;
  }
  const pageCount = pages.length;
  const visibleGroups = pages[Math.min(page, pageCount - 1)] || [];
  const visible = visibleGroups.flat();
  const splitRows: Array<{ left?: any; right?: any }> = [];
  for (const group of visibleGroups) {
    if (group[0]?.type === 'same') {
      for (const part of group) splitRows.push({ left: part, right: part });
      continue;
    }
    const removed = group.filter(part => part.type === 'removed');
    const added = group.filter(part => part.type === 'added');
    for (let index = 0; index < Math.max(removed.length, added.length); index++) splitRows.push({ left: removed[index], right: added[index] });
  }
  useEffect(() => {
    if (!options.syncLineHeights || options.view !== 'split') { setRowHeights([]); return; }
    const measure = () => {
      const next = splitRows.map((_, index) => Math.max(...([0, 1] as const).map(side => {
        const row = rowRefs.current[side][index];
        return row ? Array.from(row.children).reduce((height, child) => height + (child as HTMLElement).offsetHeight, 0) : 0;
      })));
      setRowHeights(current => current.length === next.length && current.every((height, index) => height === next[index]) ? current : next);
    };
    measure();
    const observer = new ResizeObserver(measure);
    rowRefs.current.flat().forEach(row => { if (row) observer.observe(row); });
    return () => observer.disconnect();
  }, [result, page, options.hideUnchanged, options.syncLineHeights, options.view, options.wrap, language]);
  if (!hasChunks) return null;
  const text = (part: any) => part.characterChanges
    ? <pre>{part.characterChanges.map((segment: any, index: number) => <span key={index} className={segment.changed ? 'character-change' : undefined}>{segment.text}</span>)}</pre>
    : language && options.syntaxHighlight
      ? <pre dangerouslySetInnerHTML={{ __html: hljs.highlight(part.text || ' ', { language, ignoreIllegals: true }).value }} />
      : <pre>{part.text || ' '}</pre>;
  const renderPart = (part: any, index: number) => {
    const group = changeGroups?.get(part);
    const selectable = group !== undefined && !!onSelectGroup;
    return <div key={index} className={'diff-chunk ' + part.type + (group === selectedGroup ? ' selected-change' : '') + (selectable ? ' selectable-change' : '')}
      role={selectable ? 'button' : undefined} tabIndex={selectable ? 0 : undefined} aria-pressed={selectable ? group === selectedGroup : undefined}
      onClick={selectable ? () => onSelectGroup(group) : undefined}
      onKeyDown={selectable ? event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSelectGroup(group); } } : undefined}>
      <span className="line-no">{part.type === 'added' ? '+' : part.type === 'removed' ? '−' : ' '}{part.type === 'added' ? part.rightLine : part.leftLine}</span>
      {text(part)}
    </div>;
  };
  const render = (items: any[]) => <div className={'diff-output ' + (options.wrap ? 'wrap' : '')}>{items.map(renderPart)}</div>;
  const renderSplit = (side: 0 | 1) => <div className={'diff-output ' + (options.wrap ? 'wrap' : '')}>{splitRows.map((row, index) => {
    const part = side === 0 ? row.left : row.right;
    return <div key={index} ref={node => { rowRefs.current[side][index] = node; }} className="diff-row"
      style={options.syncLineHeights && rowHeights[index] ? { minHeight: rowHeights[index] } : undefined}>
      {part && renderPart(part, index)}
    </div>;
  })}</div>;
  const sync = (from: 0 | 1, event: React.UIEvent<HTMLElement>) => {
    if (!options.syncScroll || scrollLock.current) return;
    const other = splitRefs.current[1 - from];
    if (!other) return;
    scrollLock.current = true;
    other.scrollTop = event.currentTarget.scrollTop;
    other.scrollLeft = event.currentTarget.scrollLeft;
    requestAnimationFrame(() => { scrollLock.current = false; });
  };
  const content = options.view === 'split' ? <div className="diff-split"><section ref={node => { splitRefs.current[0] = node; }} onScroll={event => sync(0, event)}><header>Original</header>{renderSplit(0)}</section><section ref={node => { splitRefs.current[1] = node; }} onScroll={event => sync(1, event)}><header>Changed</header>{renderSplit(1)}</section></div> : render(visible);
  return <div className="paged-diff">{pageCount > 1 && <div className="diff-pager"><button disabled={page === 0} onClick={() => setPage(value => value - 1)}>Previous section</button><span>{Math.min(page, pageCount - 1) + 1} of {pageCount}</span><button disabled={page >= pageCount - 1} onClick={() => setPage(value => value + 1)}>Next section</button></div>}{content}</div>;
}
function TextView({ tab, onText, onOption }: { tab: CompareTab; onText: (side: 'left' | 'right', text: string) => void; onOption: (patch: Partial<Options>) => void }) {
  const [left, setLeft] = useState(''), [right, setRight] = useState('');
  const [editorHeight, setEditorHeight] = useState<number | null>(null);
  const layoutRef = useRef<HTMLDivElement | null>(null);
  const dividerPointer = useRef<number | null>(null);
  const editorRefs = useRef<Array<HTMLTextAreaElement | null>>([null, null]);
  const editorScrollLock = useRef(false);
  const [selectedChange, setSelectedChange] = useState(0);
  useEffect(() => {
    let current = true;
    if (tab.left) window.api.readText(tab.left).then(value => { if (current) setLeft(value); }).catch(error => { if (current) setLeft('Unable to read file: ' + humanError(error)); });
    else setLeft('');
    return () => { current = false; };
  }, [tab.left?.id]);
  useEffect(() => {
    let current = true;
    if (tab.right) window.api.readText(tab.right).then(value => { if (current) setRight(value); }).catch(error => { if (current) setRight('Unable to read file: ' + humanError(error)); });
    else setRight('');
    return () => { current = false; };
  }, [tab.right?.id]);
  useEffect(() => {
    if (typeof tab.result?.leftText === 'string' && (tab.left?.text === undefined || tab.left.text === tab.result.leftText)) setLeft(tab.result.leftText);
    if (typeof tab.result?.rightText === 'string' && (tab.right?.text === undefined || tab.right.text === tab.result.rightText)) setRight(tab.result.rightText);
  }, [tab.result, tab.left?.text, tab.right?.text]);
  useEffect(() => setSelectedChange(0), [tab.result]);
  const groups: { first: any; last: any; leftText: string; rightText: string }[] = [];
  const changeGroups = new Map<any, number>();
  const chunks = tab.result?.chunks || [];
  for (let index = 0; index < chunks.length;) {
    if (chunks[index].type === 'same') { index++; continue; }
    const group = groups.length;
    const first = chunks[index]; let leftText = '', rightText = '';
    while (index < chunks.length && chunks[index].type !== 'same') {
      changeGroups.set(chunks[index], group);
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
  function resizeEditors(clientY: number) {
    const layout = layoutRef.current;
    if (!layout) return;
    const bounds = layout.getBoundingClientRect();
    const minimumPaneHeight = 100;
    const resultHeaderHeight = layout.querySelector<HTMLElement>('.result-head')?.offsetHeight || 43;
    const maximumEditorHeight = Math.max(minimumPaneHeight, bounds.height - resultHeaderHeight - minimumPaneHeight - 6);
    setEditorHeight(Math.max(minimumPaneHeight, Math.min(maximumEditorHeight, clientY - bounds.top)));
  }
  function nudgeEditors(amount: number) {
    const currentHeight = editorHeight ?? layoutRef.current?.querySelector<HTMLElement>('.editors')?.offsetHeight ?? 170;
    resizeEditors((layoutRef.current?.getBoundingClientRect().top || 0) + currentHeight + amount);
  }
  return <div ref={layoutRef} className="mode-body text-mode-body" style={editorHeight === null ? undefined : { '--text-editor-height': `${editorHeight}px` } as React.CSSProperties}>
    <div className="editors">
      <label><span>ORIGINAL TEXT</span><textarea ref={node => { editorRefs.current[0] = node; }} wrap={tab.options.wrap ? 'soft' : 'off'} onScroll={event => syncEditor(0, event)} spellCheck={false} value={left} onChange={event => { setLeft(event.target.value); onText('left', event.target.value); }} placeholder="Paste or type original text…" /></label>
      <label><span>CHANGED TEXT</span><textarea ref={node => { editorRefs.current[1] = node; }} wrap={tab.options.wrap ? 'soft' : 'off'} onScroll={event => syncEditor(1, event)} spellCheck={false} value={right} onChange={event => { setRight(event.target.value); onText('right', event.target.value); }} placeholder="Paste or type changed text…" /></label>
    </div>
    <div className="text-pane-divider" role="separator" aria-label="Resize text editors and changes" aria-orientation="horizontal" tabIndex={0}
      onPointerDown={event => { dividerPointer.current = event.pointerId; event.currentTarget.setPointerCapture(event.pointerId); resizeEditors(event.clientY); }}
      onPointerMove={event => { if (dividerPointer.current === event.pointerId) resizeEditors(event.clientY); }}
      onPointerUp={event => { if (dividerPointer.current === event.pointerId) { dividerPointer.current = null; event.currentTarget.releasePointerCapture(event.pointerId); } }}
      onPointerCancel={() => { dividerPointer.current = null; }}
      onKeyDown={event => { if (event.key === 'ArrowUp' || event.key === 'ArrowDown') { event.preventDefault(); nudgeEditors(event.key === 'ArrowUp' ? -16 : 16); } }} />
    <div className="result-head"><strong>Changes</strong><span>{tab.result ? tab.result.count + ' changed blocks' : 'Add text on both sides to compare'}</span>
      {!!groups.length && <><button onClick={() => setSelectedChange(value => (value - 1 + groups.length) % groups.length)}>Previous</button><span>{Math.min(selectedChange + 1, groups.length)} / {groups.length}</span><button onClick={() => setSelectedChange(value => (value + 1) % groups.length)}>Next</button>
        <button className="icon-label" disabled={!canMerge} onClick={() => applyChange('right')}>Accept original<MaterialIcon name="arrow_forward" /></button><button className="icon-label" disabled={!canMerge} onClick={() => applyChange('left')}><MaterialIcon name="arrow_back" />Accept changed</button></>}
      <select value={tab.options.view} onChange={event => onOption({ view: event.target.value })}><option value="split">Side by side</option><option value="unified">Unified</option></select>
    </div>
    <DiffText result={tab.result} options={tab.options} language={languageFor(tab.left) || languageFor(tab.right)} selectedGroup={selectedChange} changeGroups={changeGroups} onSelectGroup={setSelectedChange} />
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
      <button aria-label={`Move page ${number} up`} title="Move up" disabled={index === 0} onClick={() => { const next = [...pageOrder]; [next[index - 1], next[index]] = [next[index], next[index - 1]]; onOrder(next); }}><MaterialIcon name="arrow_upward" /></button>
      <button aria-label={`Move page ${number} down`} title="Move down" disabled={index === pageOrder.length - 1} onClick={() => { const next = [...pageOrder]; [next[index + 1], next[index]] = [next[index], next[index + 1]]; onOrder(next); }}><MaterialIcon name="arrow_downward" /></button></div>)}</div>}
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
function ImageView({ tab, onOption, onFlickerChange, flickerProgressRef, flickerPaused, manualFlickToken, transitionRunning }: { tab: CompareTab; onOption: (patch: Partial<Options>) => void; onFlickerChange: (right: boolean) => void; flickerProgressRef: React.RefObject<HTMLDivElement | null>; flickerPaused: boolean; manualFlickToken: number; transitionRunning: boolean }) {
  const result = tab.result;
  const [flicker, setFlicker] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [deviceScaleFactor, setDeviceScaleFactor] = useState(() => window.devicePixelRatio || 1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [fitToView, setFitToView] = useState(true);
  const [sliderHandleHover, setSliderHandleHover] = useState(false);
  const [regionsOpen, setRegionsOpen] = useState(false);
  const [regionsHeight, setRegionsHeight] = useState(220);
  const [animatedOpacity, setAnimatedOpacity] = useState(tab.options.opacity);
  const dragPoint = useRef<{ x: number; y: number } | null>(null);
  const sliderDragging = useRef(false);
  const regionsDrag = useRef<{ y: number; height: number; moved: boolean } | null>(null);
  const workspaceRef = useRef<HTMLDivElement>(null);
  const imageSurfaceRef = useRef<HTMLDivElement>(null);
  const baseImageRef = useRef<HTMLImageElement>(null);
  useEffect(() => { onFlickerChange(flicker); }, [flicker, onFlickerChange]);
  useEffect(() => {
    const updateDeviceScaleFactor = () => setDeviceScaleFactor(window.devicePixelRatio || 1);
    window.addEventListener('resize', updateDeviceScaleFactor);
    return () => window.removeEventListener('resize', updateDeviceScaleFactor);
  }, []);
  useEffect(() => {
    if (tab.options.view !== 'flicker') return;
    const restartProgress = () => flickerProgressRef.current?.getAnimations().forEach(animation => { animation.cancel(); animation.play(); });
    if (flickerPaused) {
      flickerProgressRef.current?.getAnimations().forEach(animation => animation.pause());
      return;
    }
    restartProgress();
    const timer = setInterval(() => {
      setFlicker(value => !value);
      restartProgress();
    }, Math.max(1, tab.options.flickerMs));
    return () => clearInterval(timer);
  }, [tab.id, tab.options.view, tab.options.flickerMs, flickerPaused, manualFlickToken]);
  useEffect(() => {
    if (manualFlickToken && tab.options.view === 'flicker') setFlicker(value => !value);
  }, [manualFlickToken]);
  useEffect(() => {
    if (!transitionRunning) setAnimatedOpacity(tab.options.opacity);
  }, [tab.options.opacity, transitionRunning]);
  useEffect(() => {
    if (!transitionRunning || (tab.options.view !== 'slider' && tab.options.view !== 'fade')) return;
    const maximum = tab.options.view === 'slider' ? revealInternalMaximum : percentageMaximum;
    const duration = Math.max(1, tab.options.transitionMs ?? 500);
    let position = Math.max(0, Math.min(maximum, tab.options.opacity));
    let direction = position >= maximum ? -1 : 1;
    let previous = performance.now();
    let frame = 0;
    const animate = (now: number) => {
      const elapsed = Math.min(now - previous, duration * 2);
      previous = now;
      position += direction * maximum * elapsed / duration;
      while (position > maximum || position < 0) {
        if (position > maximum) { position = maximum - (position - maximum); direction = -1; }
        if (position < 0) { position = -position; direction = 1; }
      }
      setAnimatedOpacity(position);
      frame = requestAnimationFrame(animate);
    };
    frame = requestAnimationFrame(animate);
    return () => { cancelAnimationFrame(frame); onOption({ opacity: position }); };
  }, [tab.id, tab.options.view, tab.options.transitionMs, transitionRunning]);
  useEffect(() => {
    const surface = imageSurfaceRef.current;
    if (!surface || !result || !fitToView) return;
    const fitImage = () => {
      const splitHorizontal = tab.options.view === 'split' && tab.options.splitOrientation === 'horizontal';
      const availableWidth = tab.options.view === 'split' && !splitHorizontal ? Math.max(1, (surface.clientWidth - 1) / 2) : surface.clientWidth;
      const availableHeight = splitHorizontal ? Math.max(1, (surface.clientHeight - 1) / 2) : surface.clientHeight;
      const imageWidth = tab.options.view === 'split' ? Math.max(result.splitLeftWidth || result.width, result.splitRightWidth || result.width) : result.width;
      const imageHeight = tab.options.view === 'split' ? Math.max(result.splitLeftHeight || result.height, result.splitRightHeight || result.height) : result.height;
      const next = Math.min(1, availableWidth * deviceScaleFactor / imageWidth, availableHeight * deviceScaleFactor / imageHeight);
      setZoom(Math.max(0.01, next));
      setPan({ x: 0, y: 0 });
    };
    fitImage();
    const observer = new ResizeObserver(fitImage);
    observer.observe(surface);
    return () => observer.disconnect();
  }, [fitToView, result, tab.options.view, tab.options.splitOrientation, deviceScaleFactor]);
  useEffect(() => {
    const surface = imageSurfaceRef.current;
    if (!surface) return;
    const zoomImage = (event: WheelEvent) => {
      event.preventDefault();
      event.stopPropagation();
      setFitToView(false);
      const images = Array.from(surface.querySelectorAll('img'));
      const image = images.find(item => {
        const bounds = item.getBoundingClientRect();
        return event.clientX >= bounds.left && event.clientX <= bounds.right && event.clientY >= bounds.top && event.clientY <= bounds.bottom;
      }) || images[0];
      const bounds = image?.getBoundingClientRect();
      setZoom(value => {
        const next = Math.min(8, Math.max(0.01, value * (event.deltaY < 0 ? 1.12 : 0.89)));
        if (bounds && next !== value) {
          const ratio = next / value;
          const imageCenterX = bounds.left + bounds.width / 2;
          const imageCenterY = bounds.top + bounds.height / 2;
          setPan(current => ({
            x: current.x + (event.clientX - imageCenterX) * (1 - ratio),
            y: current.y + (event.clientY - imageCenterY) * (1 - ratio)
          }));
        }
        return next;
      });
    };
    surface.addEventListener('wheel', zoomImage, { passive: false });
    return () => surface.removeEventListener('wheel', zoomImage);
  }, [result, tab.options.view]);
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
  const imageStyle = (width: number, height: number) => {
    const displayWidth = width * zoom / deviceScaleFactor;
    const displayHeight = height * zoom / deviceScaleFactor;
    return {
      width: displayWidth,
      height: displayHeight,
      marginLeft: pan.x - displayWidth / 2,
      marginTop: pan.y - displayHeight / 2
    };
  };
  const canvasStyle = imageStyle(result.width, result.height);
  const leftDisplayData = result.displayLeftData || result.leftData;
  const rightDisplayData = result.displayRightData || result.rightData;
  const sliderHit = (clientX: number, clientY: number) => {
    if (view !== 'slider' || !baseImageRef.current) return false;
    const bounds = baseImageRef.current.getBoundingClientRect();
    const edge = bounds.left + bounds.width * revealToPercentage(tab.options.opacity) / percentageMaximum;
    return clientY >= bounds.top && clientY <= bounds.bottom && Math.abs(clientX - edge) <= 10;
  };
  const moveSlider = (clientX: number) => {
    const bounds = baseImageRef.current?.getBoundingClientRect();
    if (!bounds?.width) return;
    const percentage = Math.max(0, Math.min(percentageMaximum, (clientX - bounds.left) / bounds.width * percentageMaximum));
    onOption({ opacity: percentageToReveal(percentage) });
  };
  const interaction = {
    onPointerDown: (event: React.PointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return;
      sliderDragging.current = sliderHit(event.clientX, event.clientY);
      if (sliderDragging.current) moveSlider(event.clientX);
      else dragPoint.current = { x: event.clientX, y: event.clientY };
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    onPointerMove: (event: React.PointerEvent<HTMLDivElement>) => {
      if (sliderDragging.current) { moveSlider(event.clientX); setSliderHandleHover(true); return; }
      if (dragPoint.current) {
        const dx = event.clientX - dragPoint.current.x, dy = event.clientY - dragPoint.current.y;
        dragPoint.current = { x: event.clientX, y: event.clientY };
        setFitToView(false);
        setPan(value => ({ x: value.x + dx, y: value.y + dy }));
        return;
      }
      setSliderHandleHover(sliderHit(event.clientX, event.clientY));
    },
    onPointerUp: (event: React.PointerEvent<HTMLDivElement>) => {
      sliderDragging.current = false;
      dragPoint.current = null;
      setSliderHandleHover(sliderHit(event.clientX, event.clientY));
    },
    onPointerCancel: () => { sliderDragging.current = false; dragPoint.current = null; setSliderHandleHover(false); },
    onPointerLeave: () => { if (!sliderDragging.current && !dragPoint.current) setSliderHandleHover(false); }
  };
  const startRegionsDrag = (event: React.PointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return;
    regionsDrag.current = { y: event.clientY, height: regionsOpen ? regionsHeight : 34, moved: false };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const moveRegionsDrag = (event: React.PointerEvent<HTMLButtonElement>) => {
    if (!regionsDrag.current) return;
    const delta = regionsDrag.current.y - event.clientY;
    if (Math.abs(delta) > 3) regionsDrag.current.moved = true;
    if (!regionsDrag.current.moved) return;
    const maximum = Math.max(120, (workspaceRef.current?.clientHeight || 500) - 180);
    const nextHeight = Math.min(maximum, Math.max(34, regionsDrag.current.height + delta));
    setRegionsOpen(nextHeight > 50);
    setRegionsHeight(Math.max(90, nextHeight));
  };
  const finishRegionsDrag = (event: React.PointerEvent<HTMLButtonElement>) => {
    if (!regionsDrag.current) return;
    const moved = regionsDrag.current.moved;
    regionsDrag.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (!moved) setRegionsOpen(value => !value);
  };
  const displayOpacity = transitionRunning ? animatedOpacity : tab.options.opacity;
  return <div ref={workspaceRef} className="image-workspace" onDragStart={event => event.preventDefault()}>
    {view === 'split' ? <div ref={imageSurfaceRef} className={'image-split ' + (tab.options.splitOrientation || 'vertical')} {...interaction}><div><img alt="Original image" src={result.splitLeftData || result.leftData} style={imageStyle(result.splitLeftWidth || result.width, result.splitLeftHeight || result.height)} /></div><div><img alt="Changed image" src={result.splitRightData || result.rightData} style={imageStyle(result.splitRightWidth || result.width, result.splitRightHeight || result.height)} /></div></div> : <div ref={imageSurfaceRef} className={'image-stage' + (view === 'slider' && sliderHandleHover ? ' slider-control-hover' : '')} {...interaction}>
      <img alt={view === 'flicker' && flicker ? 'Changed image' : 'Original image'} ref={baseImageRef} className="image-base" src={view === 'flicker' && flicker ? rightDisplayData : leftDisplayData} style={{ ...canvasStyle, ...(view === 'slider' && tab.options.sliderNoOverlap ? { clipPath: 'inset(0 0 0 calc(' + displayOpacity + '% - ' + (0.5 / zoom) + 'px))' } : {}) }} />
      {view === 'slider' && <img alt="Changed image overlay" className="image-overlay" src={rightDisplayData} style={{ ...canvasStyle, clipPath: 'inset(0 ' + (100 - displayOpacity) + '% 0 0)' }} />}
      {view === 'fade' && <img alt="Changed image overlay" className="image-overlay" src={rightDisplayData} style={{ ...canvasStyle, opacity: displayOpacity / 100 }} />}
      {view === 'subtract' && <img alt="Image subtraction result" className="image-overlay" src={result.subtractData} style={canvasStyle} />}
      {view === 'highlight' && <img alt="Highlighted image differences" className="image-overlay" src={result.diffData} style={canvasStyle} />}
    </div>}<section className={'image-regions-panel' + (regionsOpen ? ' open' : '')} style={regionsOpen ? { height: regionsHeight } : undefined}>
      <div className="image-regions-header">
        <button className="image-regions-summary" aria-expanded={regionsOpen} onPointerDown={startRegionsDrag} onPointerMove={moveRegionsDrag} onPointerUp={finishRegionsDrag} onPointerCancel={() => { regionsDrag.current = null; }}>
          <MaterialIcon name="drag_handle" className="image-regions-grip" /><strong>{result.regions?.length || 0} changed regions · {result.changed} pixels</strong>
        </button>
        <div className="image-zoom-controls">
          <button aria-label={fitToView ? 'Show image at actual size' : 'Fit image to window'} title={fitToView ? 'Show image at actual size' : 'Fit image to window'} onClick={() => {
            if (fitToView) {
              setFitToView(false);
              setZoom(1);
              setPan({ x: 0, y: 0 });
            } else setFitToView(true);
          }}><MaterialIcon name={fitToView ? 'photo_size_select_actual' : 'fit_screen'} /></button>
          <span className="image-zoom-value">{Math.round(zoom * 100)}%</span>
          <button aria-label="Zoom out" title="Zoom out" onClick={() => { setFitToView(false); setZoom(value => Math.max(.01, value / 1.25)); }}><MaterialIcon name="zoom_out" /></button>
          <button aria-label="Zoom in" title="Zoom in" onClick={() => { setFitToView(false); setZoom(value => Math.min(8, value * 1.25)); }}><MaterialIcon name="zoom_in" /></button>
        </div>
      </div>
      {regionsOpen && <div className="image-regions-content"><div className="image-regions">
        {(result.regions || []).slice(0, 200).map((region: any, index: number) => <span key={index} className="image-region-item">{region.previewLeft && <img src={region.previewLeft} alt="Original region" />}{region.previewRight && <img src={region.previewRight} alt="Changed region" />}<span>#{index + 1} · ({region.x}, {region.y}) · {region.width} × {region.height} · {region.pixels} pixels</span></span>)}
      </div>{!!tab.scans?.length && <div className="scan-history"><strong>Scans in this tab</strong>{tab.scans.slice(-8).map((scan, index) => <span key={index}>{new Date(scan.at).toLocaleTimeString()} · {scan.count} regions · {scan.changed} pixels</span>)}</div>}</div>}
    </section></div>;
}
function ExcelView({ tab, onOption }: { tab: CompareTab; onOption: (patch: Partial<Options>) => void }) {
  const result = tab.result;
  const [page, setPage] = useState(0);
  const [changePage, setChangePage] = useState(0);
  useEffect(() => setPage(0), [result, tab.options.hideRows]);
  useEffect(() => setChangePage(0), [result]);
  if (!result) return <div className="empty-result">Choose two spreadsheets to compare sheets and cells.</div>;
  const changed = new Set<string>(result.changed.map((item: any) => item.row + ':' + item.col));
  const changedRows = new Set<number>(result.changed.map((item: any) => item.row));
  const changedColumns = new Set<number>(result.changed.map((item: any) => item.col));
  const rowCount = Math.max(result.leftRows.length, result.rightRows.length);
  const colCount = Math.max(result.leftRows.reduce((maximum: number, row: any[]) => Math.max(maximum, row.length), 0), result.rightRows.reduce((maximum: number, row: any[]) => Math.max(maximum, row.length), 0));
  const rows = Array.from({ length: rowCount }, (_, i) => i).filter(row => !tab.options.hideRows || changedRows.has(row));
  const cols = Array.from({ length: colCount }, (_, i) => i).filter(col => !tab.options.hideColumns || changedColumns.has(col));
  const pageCount = Math.max(1, Math.ceil(rows.length / 250));
  const visibleRows = rows.slice(Math.min(page, pageCount - 1) * 250, (Math.min(page, pageCount - 1) + 1) * 250);
  const grid = (which: 'left' | 'right') => <div className="sheet-grid"><table><tbody>
    <tr><th></th>{cols.map(col => <th key={col}>{result.columnPositions?.[col]?.[which] == null ? '—' : spreadsheetColumn(result.columnPositions[col][which])}</th>)}</tr>
    {visibleRows.map(row => <tr key={row}><th>{result.rowPositions?.length ? result.rowPositions[row]?.[which] ?? '—' : row + 1}</th>{cols.map(col => <td key={col} className={changed.has(row + ':' + col) ? which === 'left' ? 'removed' : 'added' : ''}>{result[which + 'Rows'][row]?.[col]?.display ?? ''}</td>)}</tr>)}
  </tbody></table></div>;
  const changePageCount = Math.max(1, Math.ceil(result.changed.length / 500));
  const changes = <><div className="excel-change-list"><table><thead><tr><th>Cell</th><th>Original</th><th>Changed</th><th>Formula</th></tr></thead><tbody>{result.changed.slice(changePage * 500, (changePage + 1) * 500).map((item: any, index: number) => <tr key={index}>
    <th>{item.leftRow && item.leftColumn != null ? spreadsheetAddress(item.leftRow - 1, item.leftColumn) : '—'} → {item.rightRow && item.rightColumn != null ? spreadsheetAddress(item.rightRow - 1, item.rightColumn) : '—'}</th><td className="removed">{item.left}</td><td className="added">{item.right}</td><td>{item.leftFormula || item.rightFormula ? `${item.leftFormula || '—'} → ${item.rightFormula || '—'}` : ''}</td>
  </tr>)}</tbody></table></div>{changePageCount > 1 && <div className="diff-pager"><button disabled={changePage === 0} onClick={() => setChangePage(value => value - 1)}>Previous changes</button><span>{changePage + 1} of {changePageCount}</span><button disabled={changePage >= changePageCount - 1} onClick={() => setChangePage(value => value + 1)}>Next changes</button></div>}</>;
  return <div className="excel-view">
    <div className="sheet-selectors"><label>Original sheet <select value={result.leftName} onChange={event => onOption({ leftSheet: event.target.value })}>{result.leftSheets.map((name: string) => <option key={name}>{name}</option>)}</select></label>
      <label>Changed sheet <select value={result.rightName} onChange={event => onOption({ rightSheet: event.target.value })}>{result.rightSheets.map((name: string) => <option key={name}>{name}</option>)}</select></label>
      <label>Sort by <select value={tab.options.sortColumn} onChange={event => onOption({ sortColumn: event.target.value })}><option value="">Original order</option>{Array.from({ length: Math.min(colCount, 26) }, (_, col) => <option key={col} value={spreadsheetColumn(col)}>{spreadsheetColumn(col)}</option>)}</select></label><span>{result.count} changed cells</span></div>
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
  return <div className="folder-view"><div className="folder-toolbar"><input aria-label="Search folder paths" value={search} onChange={event => setSearch(event.target.value)} placeholder="Search paths…" />
    <select value={filter} onChange={event => setFilter(event.target.value)}>{['all','added','removed','modified','same'].map(status => <option key={status}>{status}</option>)}</select>
    <label className="check"><input type="checkbox" checked={collapseUnchanged} onChange={event => setCollapseUnchanged(event.target.checked)} />Collapse unchanged</label>
    <button disabled={!pairs.length} onClick={() => pairs.forEach((entry: any) => onOpenPair(entry.left.path, entry.right.path))}>Compare selected ({pairs.length})</button>
    <span>{tab.result?.count ?? 0} differences</span></div>
    {pageCount > 1 && <div className="diff-pager"><button disabled={page === 0} onClick={() => setPage(value => value - 1)}>Previous paths</button><span>{Math.min(page, pageCount - 1) + 1} of {pageCount}</span><button disabled={page >= pageCount - 1} onClick={() => setPage(value => value + 1)}>Next paths</button></div>}
    <div className="folder-list">{visibleEntries.map((entry: any) => <div key={entry.relative} className={'folder-entry ' + entry.status}>
      <input type="checkbox" aria-label={'Select ' + entry.relative} disabled={!entry.left?.path || !entry.right?.path || entry.directory} checked={selected.has(entry.relative)} onChange={event => setSelected(previous => { const next = new Set(previous); if (event.target.checked) next.add(entry.relative); else next.delete(entry.relative); return next; })} />
      <button onClick={() => { if (entry.left?.path && entry.right?.path && !entry.directory) onOpenPair(entry.left.path, entry.right.path); }}>
        <span className="folder-path" style={{ paddingLeft: Math.min(6, entry.relative.split(/[\\/]/).length - 1) * 12 }}><MaterialIcon name={entry.directory ? 'folder' : 'draft'} />{entry.relative}</span><small>{entry.status}{entry.metadataChanged ? ' · metadata' : ''}</small></button>
    </div>)}</div>
  </div>;
}
function OptionsPanel({ tab, change, flickerProgressRef, flickerPaused, onToggleFlickerPaused, onManualFlick, transitionRunning, onToggleTransition }: { tab: CompareTab; change: (patch: Partial<Options>) => void; flickerProgressRef: React.RefObject<HTMLDivElement | null>; flickerPaused: boolean; onToggleFlickerPaused: () => void; onManualFlick: () => void; transitionRunning: boolean; onToggleTransition: () => void }) {
  const o = tab.options;
  const toggle = (name: keyof Options, label = String(name).replace(/([A-Z])/g, ' $1')) => <label className="check"><input type="checkbox" checked={Boolean(o[name])} onChange={event => change({ [name]: event.target.checked })} />{label}</label>;
  const imageView = imageViewOrDefault(o.view);
  const isVisualImageView = ['split','slider','fade','flicker','subtract','highlight'].includes(imageView);
  const usesImageTransform = isVisualImageView || imageView === 'ocr' || imageView === 'rich-ocr';
  const isOcrView = imageView === 'ocr' || imageView === 'rich-ocr';
  const usesPdfInput = tab.left?.name.toLowerCase().endsWith('.pdf') || tab.right?.name.toLowerCase().endsWith('.pdf');
  return <aside className="options"><div className="section-title">OPTIONS</div>
    {['text','documents'].includes(tab.type) && <>
      <label>Precision<select value={o.precision} onChange={event => change({ precision: event.target.value as Options['precision'] })}><option>smart</option><option>word</option><option>character</option></select></label>
      {toggle('ignoreCase')}{toggle('ignoreWhitespace')}{toggle('hideUnchanged')}{toggle('wrap')}{toggle('syncScroll')}{tab.type === 'text' && toggle('syncLineHeights', 'Sync Line-Heights')}
      <label>Ignore rules<textarea value={o.ignoreRules.map(rule => (rule.regex ? 're:' : '') + rule.value).join('\n')} onChange={event => change({ ignoreRules: event.target.value.split('\n').filter(Boolean).map(value => ({ value: value.startsWith('re:') ? value.slice(3) : value, regex: value.startsWith('re:') })) })} placeholder="One rule per line; prefix regex with re:" /></label>
    </>}
    {tab.type === 'text' && toggle('syntaxHighlight')}
    {tab.type === 'images' && <>
      <label>View mode<select value={imageView} onChange={event => {
        const nextView = imageViewOrDefault(event.target.value);
        const opacity = imageView === 'slider' && nextView !== 'slider' ? revealToPercentage(o.opacity)
          : imageView !== 'slider' && nextView === 'slider' ? percentageToReveal(o.opacity) : o.opacity;
        change({ view: nextView, opacity });
      }}>{imageViews.map(view => <option key={view} value={view}>{view}</option>)}</select></label>
      {imageView === 'split' && <button type="button" className="split-orientation-toggle" aria-pressed={o.splitOrientation === 'horizontal'} title={`Switch to ${o.splitOrientation === 'horizontal' ? 'vertical' : 'horizontal'} split`} onClick={() => change({ splitOrientation: o.splitOrientation === 'horizontal' ? 'vertical' : 'horizontal' })}>
        <MaterialIcon name={o.splitOrientation === 'horizontal' ? 'horizontal_split' : 'vertical_split'} />
        {o.splitOrientation === 'horizontal' ? 'Horizontal split' : 'Vertical split'}
      </button>}
      {(imageView === 'slider' || imageView === 'fade') && <label>{imageView === 'slider' ? 'Reveal position' : 'Overlay opacity'}<ScrubbableNumber min={0} max={percentageMaximum} value={imageView === 'slider' ? revealToPercentage(o.opacity) : o.opacity} onChange={value => change({ opacity: imageView === 'slider' ? percentageToReveal(value) : value })} /></label>}
      {imageView === 'slider' && <label className="check"><input type="checkbox" checked={o.sliderNoOverlap} onChange={event => change({ sliderNoOverlap: event.target.checked })} />No overlap</label>}
      {(imageView === 'slider' || imageView === 'fade') && <details className="advanced-options transition-options"><summary>Automatic transition</summary><div><label className="transition-duration" style={{ '--transition-progress': Math.max(0, Math.min(1, o.opacity / (imageView === 'slider' ? revealInternalMaximum : percentageMaximum))) } as React.CSSProperties}>Sweep duration (ms)<span className="scrubbable-with-progress"><ScrubbableNumber min={1} max={1000} value={o.transitionMs ?? 500} onChange={transitionMs => change({ transitionMs })} /><span className="option-progress"><span className="transition-progress-fill" /></span></span></label><button type="button" onClick={onToggleTransition}>{transitionRunning ? 'Pause' : 'Start'}</button></div></details>}
      {imageView === 'flicker' && <><label className="flicker-interval" style={{ '--flicker-duration': `${Math.max(1, o.flickerMs)}ms` } as React.CSSProperties}>Flicker interval (ms)<span className="scrubbable-with-progress"><ScrubbableNumber min={1} max={1000} value={o.flickerMs} onChange={flickerMs => change({ flickerMs })} /><span className="option-progress"><span ref={flickerProgressRef} className="flicker-progress-fill" /></span></span></label><div className="flicker-actions"><button type="button" onClick={onToggleFlickerPaused}>{flickerPaused ? 'Start' : 'Pause'}</button><button type="button" onClick={onManualFlick}>Manual flick</button></div></>}
      {isOcrView && toggle('ocr')}
      {(isVisualImageView || usesImageTransform || usesPdfInput) && <details className="advanced-options"><summary>Advanced</summary><div>
        {isVisualImageView && <>
          <label>Pixel threshold<input type="number" min="0" max="255" value={o.threshold} onChange={event => change({ threshold: Number(event.target.value) })} /></label>
          <label>Minimum region size<input type="number" min="1" value={o.minRegionSize} onChange={event => change({ minRegionSize: Number(event.target.value) })} /></label>
          <label>Group regions within pixels<input type="number" min="0" max="100" value={o.regionGap} onChange={event => change({ regionGap: Number(event.target.value) })} /></label>
        </>}
        {usesImageTransform && <>
          {toggle('autoAlign')}
          <label>Horizontal offset<input type="number" value={o.offsetX} onChange={event => change({ offsetX: Number(event.target.value) })} /></label>
          <label>Vertical offset<input type="number" value={o.offsetY} onChange={event => change({ offsetY: Number(event.target.value) })} /></label>
          <label>Scale %<input type="number" min="10" max="400" value={o.scale} onChange={event => change({ scale: Number(event.target.value) })} /></label>
          <label>Rotation °<input type="number" min="-180" max="180" value={o.rotation} onChange={event => change({ rotation: Number(event.target.value) })} /></label>
          <label>Perspective horizontal %<input type="number" min="-45" max="45" value={o.perspectiveX} onChange={event => change({ perspectiveX: Number(event.target.value) })} /></label>
          <label>Perspective vertical %<input type="number" min="-45" max="45" value={o.perspectiveY} onChange={event => change({ perspectiveY: Number(event.target.value) })} /></label>
          {toggle('flipX')}{toggle('flipY')}
        </>}
        {usesPdfInput && <><label>PDF page<input type="number" min="1" value={o.page} onChange={event => change({ page: Number(event.target.value) })} /></label><label>PDF password<input type="password" value={o.password || ''} onChange={event => change({ password: event.target.value })} /></label></>}
      </div></details>}
    </>}
    {tab.type === 'excel' && <><label>View<select value={o.view} onChange={event => change({ view: event.target.value })}><option value="split">Side by side</option><option value="redline">Redline grid</option><option value="four">Four panes</option><option value="details">File details</option></select></label>
      {toggle('formulas')}{toggle('alignRows')}{toggle('alignColumns')}{toggle('ignoreCase')}{toggle('ignoreWhitespace')}{toggle('hideRows')}{toggle('hideColumns')}
      <label>Date order<select value={o.dateOrder} onChange={event => change({ dateOrder: event.target.value as Options['dateOrder'] })}><option value="none">None</option><option>US</option><option>EU</option></select></label>
    </>}
    {tab.type === 'folders' && <>{toggle('compareMetadata')}<label>Exclude paths<textarea value={o.exclusions.join('\n')} onChange={event => change({ exclusions: event.target.value.split('\n').filter(Boolean) })} /></label></>}
    {tab.type === 'documents' && <><label>View<select value={o.view} onChange={event => change({ view: event.target.value })}>{['split','rich','plain','image','ocr','redline'].map(view => <option key={view}>{view}</option>)}</select></label>{toggle('ocr')}
      {(tab.left?.name.toLowerCase().endsWith('.pdf') || tab.right?.name.toLowerCase().endsWith('.pdf')) && <><label>PDF page<input type="number" min="1" value={o.page} onChange={event => change({ page: Number(event.target.value) })} /></label><label>PDF password<input type="password" value={o.password || ''} onChange={event => change({ password: event.target.value })} /></label></>}</>}
  </aside>;
}
function App() {
  const [tabs, setTabs] = useState<CompareTab[]>([]);
  const tabsRef = useRef<CompareTab[]>([]);
  const compareTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const flickerFrames = useRef(new Map<string, boolean>());
  const flickerProgressRef = useRef<HTMLDivElement>(null);
  const [pausedFlickerTabs, setPausedFlickerTabs] = useState<Set<string>>(new Set());
  const [manualFlickToken, setManualFlickToken] = useState(0);
  const [runningTransitionTabs, setRunningTransitionTabs] = useState<Set<string>>(new Set());
  const [activeId, setActiveId] = useState<string | null>(null);
  const activeIdRef = useRef<string | null>(null);
  const [welcome, setWelcome] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsQuery, setSettingsQuery] = useState('');
  const [prefs, setPrefs] = useState<Preferences>({ restoreTabs: true, recentCompareLimit: 10, recentCompares: [] });
  const prefsRef = useRef<Preferences>({ restoreTabs: true, recentCompareLimit: 10, recentCompares: [] });
  const [contextMenuInstalled, setContextMenuInstalled] = useState<boolean | null>(null);
  const [contextMenuBusy, setContextMenuBusy] = useState(false);
  const [appDataPath, setAppDataPath] = useState('');
  const [pairing, setPairing] = useState<{ inputs: Input[]; type: Mode } | null>(null);
  const [notice, setNotice] = useState('');
  const [noticeTone, setNoticeTone] = useState<'error' | 'success'>('error');
  const [noticeSequence, setNoticeSequence] = useState(0);
  const [dropTarget, setDropTarget] = useState<'left' | 'right' | 'multiple' | null>(null);
  useEffect(() => {
    const onNativeDrop = (event: Event) => {
      const paths = (event as CustomEvent<string[]>).detail;
      if (paths?.length) void window.api.describeInputs(paths).then(inputs => routeInputs(inputs, active?.type)).catch(error => showNotice(humanError(error)));
    };
    window.addEventListener('tauri-file-drop', onNativeDrop);
    return () => window.removeEventListener('tauri-file-drop', onNativeDrop);
  });
  const primaryWindow = useRef(false);
  const active = tabs.find(tab => tab.id === activeId) || null;
  useEffect(() => { activeIdRef.current = activeId; }, [activeId]);
  useEffect(() => {
    window.api.reportActiveTab(active ? { type: active.type, left: Boolean(active.left), right: Boolean(active.right) } : null);
  }, [active?.id, active?.type, Boolean(active?.left), Boolean(active?.right)]);
  useEffect(() => {
    if (!settingsOpen) return;
    setContextMenuInstalled(null);
    void Promise.all([window.api.getShellContextMenuInstalled(), window.api.getAppDataPath()]).then(([installed, dataPath]) => {
      setContextMenuInstalled(installed);
      setAppDataPath(dataPath);
    }).catch(error => showNotice('Unable to load system settings: ' + humanError(error)));
  }, [settingsOpen]);
  function showNotice(message: string, tone: 'error' | 'success' = 'error') {
    setNoticeTone(tone);
    setNotice(message);
    setNoticeSequence(value => value + 1);
  }
  useEffect(() => {
    if (!notice || noticeTone === 'error') return;
    const timer = setTimeout(() => setNotice(''), 4000);
    return () => clearTimeout(timer);
  }, [notice, noticeTone, noticeSequence]);
  function invalidDrop(message: string) {
    showNotice(message);
    document.body.classList.add('invalid-drop');
    setTimeout(() => document.body.classList.remove('invalid-drop'), 1800);
  }
  const commitTabs = (next: CompareTab[]) => { tabsRef.current = next; setTabs(next); };
  const patchTab = (id: string, patch: Partial<CompareTab>) => commitTabs(tabsRef.current.map(tab => tab.id === id ? { ...tab, ...patch } : tab));
  useEffect(() => {
    window.api.takeWindowBootstrap().then(async bootstrap => {
      primaryWindow.current = bootstrap.primary;
      const value = await window.api.getSettings();
      prefsRef.current = value;
      setPrefs(value);
      if (bootstrap.initialTab) {
        commitTabs([bootstrap.initialTab]); setActiveId(bootstrap.initialTab.id); setWelcome(false);
        if (bootstrap.initialTab.left && bootstrap.initialTab.right && !bootstrap.initialTab.result) void run(bootstrap.initialTab);
      } else if (bootstrap.primary && value.restoreTabs && value.tabs?.length) {
        const restored = value.tabs.map(tab => ({ ...tab, result: null, busy: false, progress: 0, needsCompare: Boolean(tab.left && tab.right), options: { ...defaults(), ...tab.options, password: undefined, ...(tab.type === 'images' ? { view: imageViewOrDefault(tab.options?.view || value.lastImageView) } : {}) } }));
        const restoredActiveId = restored.some(tab => tab.id === value.activeTabId) ? value.activeTabId! : restored[0].id;
        commitTabs(restored); setActiveId(restoredActiveId);
        const restoredActive = restored.find(tab => tab.id === restoredActiveId);
        if (restoredActive?.left && restoredActive.right) void run(restoredActive);
      }
      const requests = bootstrap.primary ? await window.api.takeStartupOpenRequests() : [];
      if (requests.length) {
        for (const request of requests) {
          try { routeInputs(await window.api.describeInputs(request.paths), undefined, undefined, request.reuseExisting ? 'reuse' : 'new'); }
          catch (error) { showNotice(humanError(error)); }
        }
      } else if (!bootstrap.initialTab && (!bootstrap.primary || !value.restoreTabs || !value.tabs?.length)) setWelcome(true);
    });
    const stopCompare = window.api.onCompareEvent((event: CompareEvent) => {
      const tab = tabsRef.current.find(item => item.jobId === event.id);
      if (!tab) return;
      if (event.kind === 'progress') patchTab(tab.id, { progress: event.value || 0, phase: event.phase || '' });
      if (event.kind === 'result') {
        const scan = tab.type === 'images' ? { at: new Date().toISOString(), count: event.result.count, changed: event.result.changed, options: tab.options } : null;
        patchTab(tab.id, { result: event.result, busy: false, progress: 100, phase: 'Complete', error: undefined, jobId: undefined,
          ...(scan ? { scans: [...(tab.scans || []), scan].slice(-50) } : {}) });
        if (tab.left?.path && tab.right?.path) void window.api.getSettings().then(value => { prefsRef.current = value; setPrefs(value); });
      }
      if (event.kind === 'error') patchTab(tab.id, { busy: false, error: event.error || 'Comparison failed.', jobId: undefined, dependencyError: event.code === 'LIBREOFFICE_REQUIRED' ? 'libreoffice' : event.code === 'PDFIUM_REQUIRED' ? 'pdfium' : event.code === 'OCR_REQUIRED' ? 'ocr' : undefined });
      if (event.kind === 'cancelled') patchTab(tab.id, { busy: false, progress: 0, phase: '', jobId: undefined });
    });
    const stopOpen = window.api.onOpenPaths((paths, mode) => {
      window.api.describeInputs(paths).then(inputs => routeInputs(inputs, undefined, undefined, mode)).catch(error => showNotice(humanError(error)));
    });
    const stopTransferred = window.api.onRemoveTransferredTab((id, closeWindow) => {
      removeTransferredTab(id);
      if (closeWindow) void window.api.closeWindow();
    });
    const stopPrimary = window.api.onPrimaryWindowChange(value => {
      primaryWindow.current = value;
      if (value) void window.api.setSettings({ tabs: tabsRef.current.map(persistentTab), activeTabId: activeIdRef.current || undefined });
    });
    return () => { stopCompare(); stopOpen(); stopTransferred(); stopPrimary(); };
  }, []);
  useEffect(() => {
    const timer = setTimeout(() => {
      if (primaryWindow.current && (tabs.length || prefs.restoreTabs)) void window.api.setSettings({ tabs: tabs.map(persistentTab), activeTabId: activeId || undefined })
        .catch(error => showNotice('Unable to save the workspace: ' + humanError(error)));
    }, 600);
    return () => clearTimeout(timer);
  }, [tabs, activeId, prefs.restoreTabs]);
  useEffect(() => {
    let updating = false;
    const check = async () => {
      if (!primaryWindow.current || updating || tabsRef.current.some(tab => tab.busy)) return;
      try {
        const update = await window.api.checkForUpdates();
        if (!update.available) return;
        updating = true;
        await window.api.setSettings({ tabs: tabsRef.current.map(persistentTab), activeTabId: activeIdRef.current || undefined });
        showNotice(`Installing update ${update.publishedCommit?.slice(0, 8) || ''}…`, 'success');
        await window.api.startUpdate();
      } catch (error) {
        if (updating) showNotice('Unable to install update: ' + humanError(error));
        updating = false;
      }
    };
    const first = setTimeout(() => void check(), 10_000);
    const interval = setInterval(() => void check(), 10 * 60_000);
    return () => { clearTimeout(first); clearInterval(interval); };
  }, []);
  async function run(tab: CompareTab) {
    if (!tab.left || !tab.right) return;
    if (tab.jobId) await window.api.cancelCompare(tab.jobId);
    if (tab.result?.assetId) await window.api.releaseCompareAssets(tab.result.assetId);
    const jobId = crypto.randomUUID();
    patchTab(tab.id, { busy: true, progress: 0, phase: 'Preparing', error: undefined, dependencyError: undefined, result: null, decisions: undefined, jobId, needsCompare: false });
    try {
      await window.api.startCompare({ id: jobId, type: tab.type, left: tab.left, right: tab.right, options: tab.options });
    } catch (error) {
      const current = tabsRef.current.find(item => item.id === tab.id);
      if (current?.jobId === jobId) patchTab(tab.id, { busy: false, error: humanError(error), jobId: undefined });
    }
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
    if (tab.result?.assetId) void window.api.releaseCompareAssets(tab.result.assetId);
    const old = tab[side];
    const next = { ...tab, [side]: input, available: [...tab.available.filter(item => item.id !== input.id), ...(old && old.id !== input.id ? [old] : [])], result: null, decisions: undefined };
    patchTab(tab.id, next);
    if (tab.type === 'text') schedule(next); else void run(next);
  }
  function changeOptions(tab: CompareTab, patch: Partial<Options>) {
    const current = tabsRef.current.find(item => item.id === tab.id) || tab;
    const recompute = Object.keys(patch).some(key => !['view','opacity','sliderNoOverlap','flickerMs','transitionMs','wrap','syncScroll','syncLineHeights','hideUnchanged','hideRows','hideColumns','syntaxHighlight'].includes(key)) || (current.type === 'documents' && patch.view === 'image');
    if (recompute && current.result?.assetId) void window.api.releaseCompareAssets(current.result.assetId);
    const next = { ...current, options: { ...current.options, ...patch }, ...(recompute ? { result: null, decisions: undefined } : {}) };
    patchTab(tab.id, next);
    if (tab.type === 'images' && patch.view !== undefined) {
      const lastImageView = imageViewOrDefault(patch.view);
      prefsRef.current = { ...prefsRef.current, lastImageView };
      void window.api.setSettings({ lastImageView }).then(value => { prefsRef.current = value; setPrefs(value); });
    }
    if (current.left && current.right && recompute) schedule(next);
  }
  function addTab(type: Mode, left: Input | null = null, right: Input | null = null, available: Input[] = []) {
    const tab = newTab(type, left, right, available, imageViewOrDefault(prefsRef.current.lastImageView)); commitTabs([...tabsRef.current, tab]); setActiveId(tab.id); setWelcome(false);
    if (left && right) void run(tab);
  }
  function routeInputs(inputs: Input[], preferred?: Mode, side?: 'left' | 'right', external: false | 'new' | 'reuse' = false) {
    if (!inputs.length) return;
    const current = tabsRef.current.find(tab => tab.id === activeIdRef.current) || null;
    if (inputs.length === 1) {
      const item = inputs[0];
      if (side && current) { setInput(current, side, item); setWelcome(false); return; }
      const acceptedTypes = external ? externalTypes(item) : item.types;
      if (external === 'reuse' && current && Boolean(current.left) !== Boolean(current.right) && acceptedTypes.includes(current.type)) { setInput(current, current.left ? 'right' : 'left', item); setWelcome(false); return; }
      addTab(preferred && acceptedTypes.includes(preferred) ? preferred : acceptedTypes[0], side === 'right' ? null : item, side === 'right' ? item : null);
      return;
    }
    const type = compatible(inputs, preferred);
    if (!type) { invalidDrop('Unable to compare these inputs together: ' + inputs.map(item => item.name).join(', ')); return; }
    if (inputs.length === 2) addTab(type, inputs[0], inputs[1]);
    else { setPairing({ inputs, type }); setWelcome(false); }
  }
  async function fromDrop(event: React.DragEvent) {
    event.preventDefault(); event.stopPropagation();
    document.body.classList.remove('dragging');
    setDropTarget(null);
    try {
      const paths = window.api.takeDroppedPaths();
      if (!paths.length) { invalidDrop('No local files or folders were found in that drop.'); return; }
      const side = paths.length === 1 ? (event.clientX < window.innerWidth / 2 ? 'left' : 'right') : undefined;
      routeInputs(await window.api.describeInputs(paths), active?.type, side);
    }
    catch (error) { invalidDrop(humanError(error)); }
  }
  async function browse(tab: CompareTab, side: 'left' | 'right') {
    try { const inputs = await window.api.browseInputs(tab.type); if (inputs.length === 1) setInput(tab, side, inputs[0]); else routeInputs(inputs, tab.type); }
    catch (error) { showNotice(humanError(error)); }
  }
  function closeTab(id: string) {
    const tab = tabsRef.current.find(item => item.id === id);
    if (tab?.jobId) void window.api.cancelCompare(tab.jobId);
    if (tab?.result?.assetId) void window.api.releaseCompareAssets(tab.result.assetId);
    const pending = compareTimers.current.get(id);
    if (pending) clearTimeout(pending);
    compareTimers.current.delete(id);
    flickerFrames.current.delete(id);
    setPausedFlickerTabs(current => { const next = new Set(current); next.delete(id); return next; });
    setRunningTransitionTabs(current => { const next = new Set(current); next.delete(id); return next; });
    const next = tabsRef.current.filter(item => item.id !== id); commitTabs(next);
    if (activeId === id) setActiveId(next.at(-1)?.id || null);
    if (!next.length) setWelcome(true);
  }
  function removeTransferredTab(id: string) {
    const tab = tabsRef.current.find(item => item.id === id);
    if (tab?.jobId) void window.api.cancelCompare(tab.jobId);
    if (tab?.result?.assetId) void window.api.releaseCompareAssets(tab.result.assetId);
    const pending = compareTimers.current.get(id);
    if (pending) clearTimeout(pending);
    compareTimers.current.delete(id);
    const next = tabsRef.current.filter(item => item.id !== id);
    commitTabs(next);
    if (activeIdRef.current === id) setActiveId(next.at(-1)?.id || null);
  }
  function receiveTab(tab: CompareTab, to: string | null, after: boolean) {
    const next = [...tabsRef.current];
    const target = to ? next.findIndex(item => item.id === to) : next.length;
    next.splice(target < 0 ? next.length : target + (after ? 1 : 0), 0, tab);
    commitTabs(next); setActiveId(tab.id); setWelcome(false);
    if (tab.left && tab.right && !tab.result) void run(tab);
  }
  function activateTab(id: string) {
    setActiveId(id);
    const tab = tabsRef.current.find(item => item.id === id);
    if (tab?.needsCompare && tab.left && tab.right && !tab.busy && !tab.result) void run(tab);
  }
  async function openRecent(item: Preferences['recentCompares'][number]) {
    try {
      const [left, right] = await window.api.describeInputs([item.left, item.right]);
      if (!left.types.includes(item.type) || !right.types.includes(item.type)) throw new Error('These files can no longer be compared as ' + item.type + '.');
      addTab(item.type, left, right);
    } catch (error) { showNotice(humanError(error)); }
  }
  async function removeRecent(item: Preferences['recentCompares'][number]) {
    const recentCompares = prefsRef.current.recentCompares.filter(recent => recent.type !== item.type || recent.left !== item.left || recent.right !== item.right);
    const next = { ...prefsRef.current, recentCompares };
    prefsRef.current = next;
    setPrefs(next);
    try {
      const value = await window.api.setSettings({ recentCompares });
      prefsRef.current = value;
      setPrefs(value);
    } catch (error) { showNotice('Unable to remove the recent comparison: ' + humanError(error)); }
  }
  async function exportResult(tab: CompareTab, format: string) {
    if (!tab.result) return;
    try {
      const chunks = tab.type === 'documents' ? decidedChunks(tab.result.chunks || [], tab.decisions) : tab.result.chunks || [];
      if (format === 'image-view' || format === 'image-view-clipboard') {
        const toClipboard = format === 'image-view-clipboard';
        await window.api.exportImageView({ title: tab.title, result: tab.result, options: tab.options, toClipboard, flickerRight: flickerFrames.current.get(tab.id) });
        if (toClipboard) showNotice('Image view copied to the clipboard.', 'success');
      }
      else if (format.startsWith('text-')) {
        const [, destination, kind, style] = format.split('-');
        const toClipboard = destination === 'clipboard';
        const textKind = kind as 'original' | 'changed' | 'unified';
        await window.api.exportText({
          title: tab.title,
          leftText: String(tab.result.leftText || ''),
          rightText: String(tab.result.rightText || ''),
          leftName: tab.left?.name || 'Original',
          rightName: tab.right?.name || 'Changed',
          kind: textKind,
          fenced: style === 'fenced',
          toClipboard
        });
        if (toClipboard) showNotice(`${textKind === 'unified' ? style === 'fenced' ? 'Diff-formatted unified diff' : 'Unified diff' : textKind === 'original' ? 'Original text' : 'Changed text'} copied to the clipboard.`, 'success');
      }
      else if (format === 'docx' || format === 'tracked') await window.api.exportDocx({ title: tab.title, chunks, tracked: format === 'tracked' });
      else if (format === 'pdfside') await window.api.exportPdf({ title: tab.title, layout: 'side', leftText: tab.result.leftText, rightText: tab.result.rightText });
      else if (format === 'pdfredline') await window.api.exportPdf({ title: tab.title, layout: 'redline', chunks });
      else if (format === 'xlsx') {
        const address = (row: number | null, col: number | null) => row && col != null ? spreadsheetAddress(row - 1, col) : '';
        const rows = tab.result.changed.map((item: any) => ({ OriginalCell: address(item.leftRow, item.leftColumn), ChangedCell: address(item.rightRow, item.rightColumn), Original: item.left, Changed: item.right, OriginalFormula: item.leftFormula, ChangedFormula: item.rightFormula }));
        await window.api.exportXlsx({ title: tab.title, rows });
      } else {
        const lines = tab.type === 'folders' ? tab.result.entries.map((entry: any) => entry.status + ' ' + entry.relative)
          : tab.type === 'excel' ? tab.result.changed.map((item: any) => `${tab.result.leftName} ${item.leftRow && item.leftColumn != null ? spreadsheetAddress(item.leftRow - 1, item.leftColumn) : '—'} / ${tab.result.rightName} ${item.rightRow && item.rightColumn != null ? spreadsheetAddress(item.rightRow - 1, item.rightColumn) : '—'}: ${item.left} → ${item.right}${item.leftFormula || item.rightFormula ? ` [${item.leftFormula} → ${item.rightFormula}]` : ''}`)
          : tab.type === 'images' ? tab.result.regions.map((item: any, index: number) => `Region ${index + 1}: (${item.x}, ${item.y}) ${item.width} × ${item.height}, ${item.pixels} changed pixels`)
          : tab.result.chunks?.map((chunk: any) => chunk.type.toUpperCase() + ' ' + chunk.text) || [];
        await window.api.exportPdf({ title: tab.title, lines, ...(tab.type === 'images' ? { imageView: { result: tab.result, options: tab.options, flickerRight: flickerFrames.current.get(tab.id) } } : {}) });
      }
    } catch (error) { showNotice(humanError(error)); }
  }
  async function openFolderPair(left: string, right: string) {
    try { routeInputs(await window.api.describeInputs([left, right])); }
    catch (error) { showNotice(humanError(error)); }
  }
  async function appClose() {
    try {
      if (primaryWindow.current) await window.api.setSettings({ tabs: tabsRef.current.map(persistentTab), activeTabId: activeId || undefined });
      await window.api.closeWindow();
    } catch (error) { showNotice('Unable to close the window: ' + humanError(error)); }
  }
  return <div className="app" onDragOverCapture={event => {
    if (event.dataTransfer.types.includes(tabTokenType)) {
      event.preventDefault();
      event.dataTransfer.dropEffect = 'link';
      document.body.classList.add('detaching-tab');
      return;
    }
    if (!event.dataTransfer.types.includes('Files')) return;
    const count = Array.from(event.dataTransfer.items).filter(item => item.kind === 'file').length || event.dataTransfer.files.length;
    setDropTarget(count === 1 ? (event.clientX < window.innerWidth / 2 ? 'left' : 'right') : 'multiple');
  }} onDragOver={event => { if (event.dataTransfer.types.includes('Files')) { event.preventDefault(); document.body.classList.add('dragging'); } }} onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node)) { document.body.classList.remove('dragging', 'detaching-tab'); setDropTarget(null); } }} onDrop={event => {
    if (event.dataTransfer.types.includes(tabTokenType)) { event.preventDefault(); document.body.classList.remove('detaching-tab'); return; }
    if (event.dataTransfer.types.includes('Files')) void fromDrop(event);
  }}>
    <Titlebar tabs={tabs} active={activeId} onSelect={activateTab} onNew={() => setWelcome(true)} onClose={closeTab}
      onReorder={(from, to, after) => { const next = [...tabsRef.current]; const fromIndex = next.findIndex(tab => tab.id === from), toIndex = next.findIndex(tab => tab.id === to); if (fromIndex < 0 || toIndex < 0 || fromIndex === toIndex) return; const moved = next.splice(fromIndex, 1)[0]; const adjustedTarget = next.findIndex(tab => tab.id === to); next.splice(adjustedTarget + (after ? 1 : 0), 0, moved); commitTabs(next); }}
      onReceive={receiveTab}
      onSettings={() => setSettingsOpen(true)} onAppClose={appClose} />
    {active ? <main className="workspace">
      <div className="workspace-top"><div><span className="small-caps">{active.type.toUpperCase()} COMPARISON</span><input aria-label="Comparison title" className="tab-title-edit" value={active.title} onChange={event => patchTab(active.id, { title: event.target.value })} /></div>
        <div className="workspace-actions"><span className="change-count">{active.result?.count ?? 0} changes</span>
          {active.busy ? <button onClick={() => { if (active.jobId) void window.api.cancelCompare(active.jobId); patchTab(active.id, { busy: false, progress: 0, phase: '', jobId: undefined }); }}>Cancel · {active.progress}%</button> : <button onClick={() => void run(active)}>Compare</button>}
          <select aria-label="Export comparison" value="" disabled={active.busy || !active.result} onChange={event => { if (event.target.value) void exportResult(active, event.target.value); }}>
            <option value="">Export…</option>
            {active.type === 'images' && <><option value="image-view">Image View</option><option value="image-view-clipboard">Image View to Clipboard</option></>}
            {active.type === 'text' && <><optgroup label="Save to File"><option value="text-file-original">Original Text</option><option value="text-file-changed">Changed Text</option><option value="text-file-unified">Unified Diff</option></optgroup><optgroup label="Copy to Clipboard"><option value="text-clipboard-original">Original Text</option><option value="text-clipboard-changed">Changed Text</option><option value="text-clipboard-unified">Unified Diff</option><option value="text-clipboard-unified-fenced">Diff Format</option></optgroup></>}
            {active.type === 'documents' && <><option value="docx">Word redline</option><option value="tracked">Word tracked changes</option></>}
            {active.type === 'excel' && <option value="xlsx">Excel change list</option>}
            {active.type === 'documents' && <><option value="pdfside">Side-by-side PDF</option><option value="pdfredline">Redline PDF</option></>}
            <option value="pdf">PDF report</option>
          </select></div></div>
      <div className="input-row"><InputSlot side="left" input={active.left} available={active.available} type={active.type} onBrowse={() => void browse(active, 'left')} onReplace={input => setInput(active, 'left', input)} onDrop={event => void fromDrop(event)} />
            <button className="swap" title="Swap sides" aria-label="Swap sides" onClick={() => { if (active.result?.assetId) void window.api.releaseCompareAssets(active.result.assetId); const next = { ...active, left: active.right, right: active.left, result: null, decisions: undefined }; patchTab(active.id, next); void run(next); }}><MaterialIcon name="swap_horiz" /></button>
        <InputSlot side="right" input={active.right} available={active.available} type={active.type} onBrowse={() => void browse(active, 'right')} onReplace={input => setInput(active, 'right', input)} onDrop={event => void fromDrop(event)} /></div>
      {active.error && <div className="error-banner"><span>{active.error}</span>{active.dependencyError && <button type="button" onClick={() => { setSettingsQuery(active.dependencyError === 'ocr' ? 'OCR' : active.dependencyError === 'pdfium' ? 'PDFium' : 'LibreOffice'); setSettingsOpen(true); }}>Open Settings</button>}</div>}
      {active.busy && <div className="progress"><div style={{ width: active.progress + '%' }} /></div>}
      <div className="content-layout"><div className="content-main">
        {active.type === 'text' && <TextView tab={active} onText={(side, text) => { const input = { ...(active[side] || { id: crypto.randomUUID(), name: side === 'left' ? 'Original text' : 'Changed text', types: ['text' as Mode] }), text }; setInput(active, side, input); }} onOption={patch => changeOptions(active, patch)} />}
        {active.type === 'documents' && <DocumentView tab={active} onDecision={(group, decision) => patchTab(active.id, { decisions: { ...active.decisions, [group]: decision } })} onOrder={rightPageOrder => changeOptions(active, { rightPageOrder })} />}
        {active.type === 'images' && <ImageView tab={active} onOption={patch => changeOptions(active, patch)} onFlickerChange={right => flickerFrames.current.set(active.id, right)} flickerProgressRef={flickerProgressRef} flickerPaused={pausedFlickerTabs.has(active.id)} manualFlickToken={manualFlickToken} transitionRunning={runningTransitionTabs.has(active.id)} />}
        {active.type === 'excel' && <ExcelView tab={active} onOption={patch => changeOptions(active, patch)} />}
        {active.type === 'folders' && <FolderView tab={active} onOpenPair={(left, right) => void openFolderPair(left, right)} />}
      </div><OptionsPanel tab={active} change={patch => changeOptions(active, patch)} flickerProgressRef={flickerProgressRef} flickerPaused={pausedFlickerTabs.has(active.id)} onToggleFlickerPaused={() => setPausedFlickerTabs(current => { const next = new Set(current); if (next.has(active.id)) next.delete(active.id); else next.add(active.id); return next; })} onManualFlick={() => setManualFlickToken(value => value + 1)} transitionRunning={runningTransitionTabs.has(active.id)} onToggleTransition={() => { const starting = !runningTransitionTabs.has(active.id); if (starting) changeOptions(active, { opacity: 0 }); setRunningTransitionTabs(current => { const next = new Set(current); if (starting) next.add(active.id); else next.delete(active.id); return next; }); }} /></div>
    </main> : <main className="empty-workspace"><MaterialIcon name="difference" className="empty-symbol" /><h2>Ready to compare</h2><p>Drop files or folders here, or start a new comparison.</p><button className="primary" onClick={() => setWelcome(true)}>New comparison</button></main>}
    {welcome && <Welcome recent={prefs.recentCompares || []} recentEnabled={prefs.recentCompareLimit > 0} onCreate={type => addTab(type)} onOpenRecent={item => void openRecent(item)} onRemoveRecent={item => void removeRecent(item)} onNotice={showNotice} onDismiss={() => setWelcome(false)} />}
    {dropTarget && <div className={'drop-overlay ' + (dropTarget === 'multiple' ? 'drop-multiple' : 'drop-single')} aria-hidden="true">
      {dropTarget === 'multiple' ? <span>Drop files or folders to compare</span> : <><div className={'drop-half ' + (dropTarget === 'left' ? 'active' : '')}>Original</div><div className={'drop-half ' + (dropTarget === 'right' ? 'active' : '')}>Changed</div></>}
    </div>}
    {pairing && <Pairing inputs={pairing.inputs} type={pairing.type} onChangeType={type => setPairing({ ...pairing, type })} onCancel={() => setPairing(null)} onConfirm={(left, right, others, type) => { addTab(type, left, right, others); setPairing(null); }} />}
    {settingsOpen && <Settings prefs={prefs} appDataPath={appDataPath} contextMenuInstalled={contextMenuInstalled} contextMenuBusy={contextMenuBusy} initialQuery={settingsQuery}
      onPrefs={value => { prefsRef.current = value; setPrefs(value); }} onContextMenuBusy={setContextMenuBusy} onContextMenuInstalled={setContextMenuInstalled}
      onNotice={showNotice} onClose={() => { setSettingsOpen(false); setSettingsQuery(''); }} />}
    {notice && <div className={'toast ' + noticeTone} role={noticeTone === 'error' ? 'alert' : 'status'} title={noticeTone === 'error' ? 'Click to copy error' : 'Click to dismiss'} onClick={() => {
      if (noticeTone === 'error') void window.api.writeClipboardText(notice);
      else setNotice('');
    }}>{notice}<button title="Dismiss" aria-label="Dismiss notification" onClick={event => { event.stopPropagation(); setNotice(''); }}><MaterialIcon name="close" /></button></div>}
  </div>;
}
createRoot(document.getElementById('root')!).render(<App />);
