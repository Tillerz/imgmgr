import React, { useEffect, useState, useCallback, useRef } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api.js';
import StarRating from './StarRating.jsx';
import usePersistentState from '../usePersistentState.js';

// Small button that copies `text` to the clipboard with brief "Copied!" feedback.
function CopyButton({ text, className = '', label = 'Copy', title }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      className={className}
      title={title}
      onClick={(e) => {
        e.stopPropagation();
        navigator.clipboard.writeText(text || '').then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        });
      }}
    >
      {copied ? 'Copied!' : label}
    </button>
  );
}

// Collapse state persisted to localStorage so it carries across images/sessions.
// Parse a comma-separated "Steps: 30, Sampler: …, Model: …" params line.
function parseParams(tail) {
  const out = {};
  if (!tail) return out;
  const flat = tail.replace(/\s+/g, ' ');
  const re = /([A-Za-z][A-Za-z0-9 ]*?):\s*(.*?)(?=,\s*[A-Za-z][A-Za-z0-9 ]*?:\s|$)/g;
  let m;
  while ((m = re.exec(flat)) !== null) {
    const k = m[1].trim();
    const v = m[2].trim().replace(/,+$/, '').trim();
    if (k && v) out[k] = v;
  }
  return out;
}

// Split a full a1111 metadata string into its prompt / template / params parts.
// Sections may appear in any order; we anchor on their labels and slice between.
function parseSource(src) {
  const out = { positive: '', negative: '', template: '', negativeTemplate: '', params: {}, loras: [] };
  if (!src || typeof src !== 'string') return out;
  const anchors = [];
  const add = (key, re) => {
    const m = re.exec(src);
    if (!m) return;
    const leadWs = m[0].match(/^\s*/)[0].length;
    // labelStart = start of the label word (past leading whitespace);
    // contentStart = past the whole label (so section text excludes the label).
    anchors.push({ key, start: m.index, labelStart: m.index + leadWs, contentStart: m.index + m[0].length });
  };
  add('negative', /(?:^|\n)\s*Negative prompt:[ \t]*/);
  add('template', /(?:^|\n)\s*Template:[ \t]*/);
  add('negativeTemplate', /(?:^|\n)\s*Negative Template:[ \t]*/);
  add('params', /(?:^|\n)\s*Steps:[ \t]*/);
  anchors.sort((a, b) => a.start - b.start);

  const firstStart = anchors.length ? anchors[0].start : src.length;
  out.positive = src.slice(0, firstStart).trim();
  for (let i = 0; i < anchors.length; i++) {
    const a = anchors[i];
    const end = i + 1 < anchors.length ? anchors[i + 1].start : src.length;
    if (a.key === 'params') {
      // Keep the "Steps:" label so parseParams captures it as a key.
      out.params = parseParams(src.slice(a.labelStart, end).trim());
    } else {
      out[a.key] = src.slice(a.contentStart, end).trim();
    }
  }

  // LoRA network names from <lora:NAME:weight> tags in the positive + template.
  const loraRe = /<lora:([^:>]+)(?::[^>]*)?>/gi;
  const names = new Set();
  for (const text of [out.positive, out.template]) {
    let m;
    while ((m = loraRe.exec(text || '')) !== null) names.add(m[1].trim());
  }
  out.loras = [...names];
  return out;
}

// Render prompt text, coloring <lora:…> tags and __wildcards__ differently.
const TOKEN_RE = /(<lora:[^>]+>)|(__[^_\s][^_]*?__)/g;
function highlightTokens(text) {
  if (!text) return null;
  const nodes = [];
  let last = 0, m, key = 0;
  while ((m = TOKEN_RE.exec(text)) !== null) {
    if (m.index > last) nodes.push(text.slice(last, m.index));
    if (m[1]) nodes.push(<span key={key++} className="tok-lora">{m[1]}</span>);
    else nodes.push(<span key={key++} className="tok-wild">{m[2]}</span>);
    last = TOKEN_RE.lastIndex;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

// A collapsible, resizable prompt/template section with its own Copy button.
// Collapse state is keyed by `skey` and persists across images.
function PromptSection({ title, text, skey, defaultOpen = true, negative = false }) {
  const [open, setOpen] = usePersistentState(`imgmgr.section.${skey}`, defaultOpen);
  if (!text) return null;
  return (
    <div className="meta-section">
      <div className="meta-section-title meta-section-title-row collapsible" onClick={() => setOpen(o => !o)}>
        <span className="collapse-caret">{open ? '▾' : '▸'} {title}</span>
        <CopyButton text={text} className="btn-copy-inline" title={`Copy ${title}`} />
      </div>
      {open && <pre className={`meta-prompt resizable ${negative ? 'meta-negative' : ''}`}>{highlightTokens(text)}</pre>}
    </div>
  );
}

// Collapsible "Caption" section. Shows the stored caption (if any) and a button
// to (re)generate it via the SDNext VQA endpoint. Generation is slow, so the
// button reflects an in-progress state and errors are surfaced inline.
function CaptionSection({ imageId, caption }) {
  const qc = useQueryClient();
  const [open, setOpen] = usePersistentState('imgmgr.section.caption', true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  async function generate() {
    setLoading(true);
    setError('');
    try {
      const r = await api.caption(imageId);
      qc.setQueryData(['image', imageId], prev => (prev ? { ...prev, caption: r.caption } : prev));
    } catch (e) {
      setError(String(e.message || e));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="meta-section">
      <div className="meta-section-title meta-section-title-row collapsible" onClick={() => setOpen(o => !o)}>
        <span className="collapse-caret">{open ? '▾' : '▸'} Caption</span>
        {caption && <CopyButton text={caption} className="btn-copy-inline" title="Copy caption" />}
      </div>
      {open && (
        <div className="caption-body">
          {caption && <pre className="meta-prompt resizable">{caption}</pre>}
          {error && <div className="caption-error">Captioning failed: {error}</div>}
          <button
            className="btn btn-secondary btn-xs"
            onClick={generate}
            disabled={loading}
            title="Generate a caption with the SDNext VQA model"
          >
            {loading ? 'Captioning… (may take a while)' : caption ? '↻ Regenerate caption' : '✦ Generate caption'}
          </button>
        </div>
      )}
    </div>
  );
}

function TagEditor({ imageId }) {
  const qc = useQueryClient();
  const { data: tags = [] } = useQuery({
    queryKey: ['tags', imageId],
    queryFn: () => api.imageTags(imageId),
  });
  const [input, setInput] = useState('');

  async function add() {
    const t = input.trim();
    if (!t) return;
    await api.addTag(imageId, t);
    setInput('');
    qc.invalidateQueries({ queryKey: ['tags', imageId] });
    qc.invalidateQueries({ queryKey: ['allTags'] });
  }

  async function remove(tag) {
    await api.removeTag(imageId, tag);
    qc.invalidateQueries({ queryKey: ['tags', imageId] });
    qc.invalidateQueries({ queryKey: ['allTags'] });
  }

  function onKeyDown(e) {
    if (e.key === 'Enter') { e.preventDefault(); add(); }
  }

  return (
    <div className="meta-section">
      <div className="meta-section-title">Tags</div>
      <div className="tag-list">
        {tags.map(tag => (
          <span key={tag} className="tag-chip">
            {tag}
            <button className="tag-chip-remove" onClick={() => remove(tag)} title="Remove tag">×</button>
          </span>
        ))}
      </div>
      <div className="tag-input-row">
        <input
          className="tag-input"
          type="text"
          placeholder="Add tag…"
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={onKeyDown}
        />
        <button className="btn btn-secondary btn-xs" onClick={add}>Add</button>
      </div>
    </div>
  );
}

// Metadata keys hidden from the EXIF table, and those already shown up top.
const EXIF_HIDE = new Set(['ExifTag', 'Size', 'UserComment', 'parameters', 'Parameters']);
const EXIF_PRIORITY_KEYS = new Set(['Model', 'Sampler', 'Steps', 'CFG scale', 'Seed']);

function MetaPanel({ imageId, image }) {
  const { data: metaRows = [] } = useQuery({
    queryKey: ['metadata', imageId],
    queryFn: () => api.metadata(imageId),
  });

  const [copied, setCopied] = useState(false);

  // The raw a1111 string (if embedded) is the authoritative source for the
  // prompt / template / params — the DB columns can be polluted for some tools.
  // When a source string exists, trust its parse even if a field comes out empty
  // (e.g. a genuinely-empty Negative prompt) — falling back to the DB column only
  // when there's no source to parse at all. An `||` fallback here would silently
  // prefer a stale/mis-parsed DB value over a correct empty result.
  const source = metaRows.find(r => r.key === 'UserComment' || r.key === 'parameters' || r.key === 'Parameters')?.value || '';
  const parsed = parseSource(source);
  const positive = source ? parsed.positive : (image?.positive_prompt || '');
  const negative = source ? parsed.negative : (image?.negative_prompt || '');
  const template = parsed.template || '';
  const negativeTemplate = parsed.negativeTemplate || '';
  const templateText = template + (negativeTemplate ? `\n\nNegative Template:\n${negativeTemplate}` : '');
  const params = parsed.params;
  const unet = Object.entries(params).find(([k]) => /unet/i.test(k))?.[1] || '';

  // Ordered "important" rows shown first in the EXIF table.
  const priority = [
    ['Model', params.Model],
    ['Sampler', params.Sampler],
    ['Steps', params.Steps],
    ['CFG scale', params['CFG scale']],
    ['UNET', unet],
    ['LoRA networks', parsed.loras.join(', ')],
    ['Seed', params.Seed],
  ].filter(([, v]) => v);
  const rest = metaRows.filter(r => !EXIF_HIDE.has(r.key) && !EXIF_PRIORITY_KEYS.has(r.key));

  const allText = [
    image ? `File: ${image.filename}` : '',
    image ? `Path: ${image.path}` : '',
    image ? `Dimensions: ${image.width} × ${image.height}` : '',
    image ? `Size: ${(image.size / 1024).toFixed(1)} KB` : '',
    image ? `Date: ${new Date(image.mtime).toLocaleString()}` : '',
    image?.caption ? `\nCaption:\n${image.caption}` : '',
    positive ? `\nPrompt:\n${positive}` : '',
    negative ? `\nNegative prompt:\n${negative}` : '',
    templateText ? `\nTemplate:\n${templateText}` : '',
    source ? `\nParameters:\n${source}` : '',
  ].filter(Boolean).join('\n');

  function copyAll() {
    navigator.clipboard.writeText(allText).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }

  if (!image) return <div className="meta-panel loading">Loading…</div>;

  return (
    <div className="meta-panel">
      <div className="meta-section">
        <div className="meta-file-info">
          <div className="meta-filename">{image.filename}</div>
          <div className="meta-row"><span>Dimensions</span><span>{image.width} × {image.height}</span></div>
          <div className="meta-row"><span>Size</span><span>{(image.size / 1024).toFixed(1)} KB</span></div>
          <div className="meta-row"><span>Date</span><span>{new Date(image.mtime).toLocaleString()}</span></div>
          <div className="meta-row"><span>Folder</span><span className="meta-path">{image.folder_path}</span></div>
        </div>
      </div>

      <TagEditor imageId={imageId} />

      <PromptSection title="Prompt" text={positive} skey="prompt" />
      <PromptSection title="Negative prompt" text={negative} skey="negative" negative />
      <PromptSection title="Template" text={templateText} skey="template" />

      <CaptionSection imageId={imageId} caption={image.caption} />

      {(priority.length > 0 || rest.length > 0) && (
        <div className="meta-section">
          <div className="meta-section-title">EXIF / Metadata</div>
          <div className="meta-table">
            {priority.map(([k, v]) => (
              <div key={`p-${k}`} className="meta-row meta-row-priority">
                <span className="meta-key">{k}</span>
                <span className="meta-value">{v}</span>
              </div>
            ))}
            {rest.map((row, i) => (
              <div key={`${row.key}-${i}`} className="meta-row">
                <span className="meta-key">{row.key}</span>
                <span className="meta-value">{row.value}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {source && (
        <PromptSection title="UserComment (raw)" text={source} skey="usercomment" defaultOpen={false} />
      )}

      <div className="meta-copy-row">
        <button className="btn btn-secondary btn-sm" onClick={copyAll}>
          {copied ? 'Copied!' : 'Copy all'}
        </button>
      </div>
    </div>
  );
}

export default function ImageViewer({ imageId, imageIds, onClose, onNavigate, onFavoriteChange, onDelete, onLoadMore, hasMore, total, onFindSimilar }) {
  const [zoom, setZoom] = useState(false);
  const [flash, setFlash] = useState('');
  const imgRef = useRef(null);

  const { data: image } = useQuery({
    queryKey: ['image', imageId],
    queryFn: () => api.image(imageId),
  });

  const currentIdx = imageIds.indexOf(imageId);
  const canPrev = currentIdx > 0;
  const canNext = currentIdx < imageIds.length - 1 || hasMore;

  const nav = useCallback((dir) => {
    const next = imageIds[currentIdx + dir];
    if (next != null) { onNavigate(next); setZoom(false); }
    // Pull the next page as we approach the end of the loaded set so navigation
    // continues past the pagination boundary all the way to the last image.
    if (dir > 0 && hasMore && currentIdx + dir >= imageIds.length - 5) {
      onLoadMore?.();
    }
  }, [currentIdx, imageIds, onNavigate, hasMore, onLoadMore]);

  // Delete request from the viewer — starred images are protected.
  const attemptDelete = useCallback(() => {
    if (!image) return;
    if (image.favorite > 0) {
      setFlash('★ Starred — protected from deletion');
      setTimeout(() => setFlash(''), 1800);
      return;
    }
    onDelete(image.id);
  }, [image, onDelete]);

  useEffect(() => {
    function onKey(e) {
      if (e.key === 'Escape') onClose();
      if (e.key === 'ArrowLeft') nav(-1);
      if (e.key === 'ArrowRight') nav(1);
      const tag = e.target.tagName;
      const typing = tag === 'INPUT' || tag === 'TEXTAREA' || e.target.isContentEditable;
      if (typing) return;
      if (e.key >= '0' && e.key <= '5' && image) {
        onFavoriteChange(image.id, Number(e.key));
      }
      if (e.key === 'Delete') {
        attemptDelete();
      }
      if ((e.key === 'f' || e.key === 'F') && image) {
        onFavoriteChange(image.id, image.favorite === 5 ? 0 : 5); // toggle 5★
      }
      if (e.key === ' ') {
        e.preventDefault(); // don't scroll the page
        nav(1);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, nav, image, onFavoriteChange, attemptDelete]);

  // Prevent body scroll while viewer is open
  useEffect(() => {
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = ''; };
  }, []);

  // Resizable metadata panel — width persists across images/sessions.
  const [panelWidth, setPanelWidth] = usePersistentState('imgmgr.metaPanelWidth', 320);
  const panelRef = useRef(null);
  const startResize = useCallback((e) => {
    e.preventDefault();
    const rightEdge = panelRef.current ? panelRef.current.getBoundingClientRect().right : window.innerWidth;
    const onMove = (ev) => {
      const w = Math.max(240, Math.min(rightEdge - ev.clientX, window.innerWidth - 200));
      setPanelWidth(w);
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
    };
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'col-resize';
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }, [setPanelWidth]);

  return (
    <div className="viewer-backdrop" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="viewer-container">
        {flash && <div className="viewer-flash">{flash}</div>}
        <div className="viewer-topbar">
          <div className="viewer-nav">
            <button className="btn-icon" onClick={() => nav(-1)} disabled={!canPrev}>‹</button>
            <span className="viewer-counter">{currentIdx + 1} / {total || imageIds.length}</span>
            <button className="btn-icon" onClick={() => nav(1)} disabled={!canNext}>›</button>
          </div>
          <div className="viewer-topbar-right">
            {image && onFindSimilar && (
              <button
                className="btn btn-secondary btn-sm"
                onClick={() => onFindSimilar(image.id)}
                title="Find visually similar images"
              >
                🔍 Similar
              </button>
            )}
            {image && (
              <StarRating value={image.favorite} onChange={v => onFavoriteChange(image.id, v)} size="lg" />
            )}
            <button className="btn-icon btn-close" onClick={onClose} title="Close (Esc)">✕</button>
          </div>
        </div>

        <div className="viewer-body">
          <div className={`viewer-image-area ${zoom ? 'zoomed' : ''}`} onClick={() => setZoom(v => !v)}>
            {image?.missing_at ? (
              // The original is offline (unplugged drive, unmounted share). Fall
              // back to the cached thumbnail so there's still something to look
              // at, and say why it's blurry.
              <div className="viewer-offline">
                <img src={api.thumb(imageId)} alt={image.filename} className="viewer-offline-thumb" draggable={false} />
                <div className="viewer-offline-note">
                  <strong>⚠ File offline</strong>
                  <span>Showing the cached thumbnail — the original isn't reachable right now.</span>
                  <code>{image.path}</code>
                  <span className="viewer-offline-since">Missing since {new Date(image.missing_at).toLocaleString()}</span>
                </div>
              </div>
            ) : (
              <>
                <img
                  ref={imgRef}
                  src={api.full(imageId)}
                  alt={image?.filename || ''}
                  className="viewer-img"
                  draggable={false}
                />
                <div className="viewer-zoom-hint">{zoom ? 'Click to fit' : 'Click to zoom'}</div>
              </>
            )}
          </div>

          <div className="meta-resizer" onPointerDown={startResize} title="Drag to resize" />
          <div className="meta-panel-wrap" ref={panelRef} style={{ width: `${panelWidth}px` }}>
            <MetaPanel imageId={imageId} image={image} />
          </div>
        </div>
      </div>
    </div>
  );
}
