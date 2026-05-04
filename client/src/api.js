async function json(res) {
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json();
}

export const api = {
  images: (params) => fetch('/api/images?' + new URLSearchParams(params)).then(json),
  imageIds: (params) => fetch('/api/images/ids?' + new URLSearchParams(params)).then(json),
  image:  (id) => fetch(`/api/images/${id}`).then(json),
  metadata: (id) => fetch(`/api/images/${id}/metadata`).then(json),
  setFavorite: (id, level) => fetch(`/api/images/${id}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ favorite: level }),
  }).then(json),
  move: (ids, targetFolder) => fetch('/api/images/move', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids, targetFolder }),
  }).then(json),
  delete: (ids) => fetch('/api/images', {
    method: 'DELETE', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids }),
  }).then(json),
  thumb: (id) => `/api/thumb/${id}`,
  full:  (id) => `/api/full/${id}`,
  folders: () => fetch('/api/folders').then(json),
  createFolder: (path) => fetch('/api/folders', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path }),
  }).then(json),
  duplicates: (type = 'exact') => fetch(`/api/duplicates?type=${type}`).then(json),
  deleteDuplicates: (ids) => fetch('/api/duplicates', {
    method: 'DELETE', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids }),
  }).then(json),
  scan: () => fetch('/api/scan', { method: 'POST' }).then(json),
  scanStatus: () => fetch('/api/scan/status').then(json),
  metaKeys: () => fetch('/api/images/meta/keys').then(json),
  favoriteCounts: (params) => fetch('/api/images/counts?' + new URLSearchParams(params)).then(json),
  imageTags: (id) => fetch(`/api/images/${id}/tags`).then(json),
  addTag: (id, tag) => fetch(`/api/images/${id}/tags`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tag }),
  }).then(json),
  removeTag: (id, tag) => fetch(`/api/images/${id}/tags/${encodeURIComponent(tag)}`, {
    method: 'DELETE',
  }).then(json),
  allTags: () => fetch('/api/tags').then(json),
  bulkAddTag: (ids, tag) => fetch('/api/tags/bulk', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids, tag }),
  }).then(json),
  bulkRemoveTag: (ids, tag) => fetch('/api/tags/bulk', {
    method: 'DELETE', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids, tag }),
  }).then(json),
};
