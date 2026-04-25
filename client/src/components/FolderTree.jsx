import React, { useState, useCallback } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useDroppable } from '@dnd-kit/core';
import { api } from '../api.js';

function buildTree(folders) {
  const byPath = {};
  for (const f of folders) byPath[f.path] = { ...f, children: [] };

  const roots = [];
  for (const f of folders) {
    const node = byPath[f.path];
    const parent = byPath[f.parent_path];
    if (parent) {
      parent.children.push(node);
    } else {
      roots.push(node);
    }
  }

  function sortChildren(node) {
    node.children.sort((a, b) => a.name.localeCompare(b.name));
    node.children.forEach(sortChildren);
  }
  roots.sort((a, b) => a.name.localeCompare(b.name));
  roots.forEach(sortChildren);

  return roots;
}

function FolderNode({ node, currentFolder, onNavigate, expanded, onToggle, depth }) {
  const hasChildren = node.children.length > 0;
  const isExpanded = expanded.has(node.path);
  const isActive = currentFolder === node.path;

  const { isOver, setNodeRef } = useDroppable({
    id: `folder-${node.id}`,
    data: { type: 'folder', path: node.path },
  });

  return (
    <>
      <div
        ref={setNodeRef}
        className={`folder-item ${isActive ? 'active' : ''} ${isOver ? 'drop-over' : ''}`}
        style={{ paddingLeft: `${8 + depth * 16}px` }}
        title={node.path}
      >
        <span
          className="folder-toggle"
          onClick={e => { e.stopPropagation(); if (hasChildren) onToggle(node.path); }}
          aria-label={isExpanded ? 'collapse' : 'expand'}
        >
          {hasChildren ? (isExpanded ? '▾' : '▸') : <span className="folder-toggle-leaf" />}
        </span>
        <span className="folder-icon-name" onClick={() => onNavigate(node.path)}>
          <span className="folder-icon">{isExpanded ? '📂' : '📁'}</span>
          <span className="folder-name">{node.name}</span>
        </span>
      </div>

      {isExpanded && node.children.map(child => (
        <FolderNode
          key={child.id}
          node={child}
          currentFolder={currentFolder}
          onNavigate={onNavigate}
          expanded={expanded}
          onToggle={onToggle}
          depth={depth + 1}
        />
      ))}
    </>
  );
}

export default function FolderTree({ currentFolder, onNavigate }) {
  const qc = useQueryClient();
  const [expanded, setExpanded] = useState(new Set());
  const [newFolderName, setNewFolderName] = useState('');
  const [showCreate, setShowCreate] = useState(false);

  const { data: folders = [] } = useQuery({
    queryKey: ['folders'],
    queryFn: api.folders,
  });

  const tree = buildTree(folders);

  const handleToggle = useCallback((path) => {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path); else next.add(path);
      return next;
    });
  }, []);

  async function handleCreate() {
    if (!newFolderName.trim()) return;
    const base = currentFolder || (folders[0]?.path || '/mnt/sd/imgmgr');
    const newPath = `${base}/${newFolderName.trim()}`;
    await api.createFolder(newPath);
    qc.invalidateQueries(['folders']);
    setNewFolderName('');
    setShowCreate(false);
  }

  const { isOver: rootOver, setNodeRef: rootRef } = useDroppable({
    id: 'folder-root',
    data: { type: 'folder', path: folders[0]?.parent_path || '' },
  });

  return (
    <div className="folder-tree">
      <div className="folder-tree-header">
        <span>Folders</span>
        <button className="btn-icon" onClick={() => setShowCreate(v => !v)} title="New folder">+</button>
      </div>

      {showCreate && (
        <div className="folder-create">
          <input
            className="input-sm"
            placeholder="folder name"
            value={newFolderName}
            onChange={e => setNewFolderName(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleCreate()}
            autoFocus
          />
          <button className="btn btn-primary btn-xs" onClick={handleCreate}>Create</button>
          <button className="btn btn-secondary btn-xs" onClick={() => setShowCreate(false)}>✕</button>
        </div>
      )}

      <div
        ref={rootRef}
        className={`folder-item all-item ${!currentFolder ? 'active' : ''} ${rootOver ? 'drop-over' : ''}`}
        onClick={() => onNavigate('')}
      >
        <span className="folder-toggle folder-toggle-leaf" />
        <span className="folder-icon-name">
          <span className="folder-icon">🗂</span>
          <span className="folder-name">All images</span>
        </span>
      </div>

      {tree.map(node => (
        <FolderNode
          key={node.id}
          node={node}
          currentFolder={currentFolder}
          onNavigate={onNavigate}
          expanded={expanded}
          onToggle={handleToggle}
          depth={0}
        />
      ))}
    </div>
  );
}
