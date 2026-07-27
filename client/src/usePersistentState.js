import { useState, useEffect } from 'react';

// useState that mirrors its value to localStorage, so UI preferences (panel
// widths, open/closed sections, the similar-images threshold, …) survive reloads.
export default function usePersistentState(key, initial) {
  const [v, setV] = useState(() => {
    try { const s = localStorage.getItem(key); return s === null ? initial : JSON.parse(s); }
    catch { return initial; }
  });
  useEffect(() => { try { localStorage.setItem(key, JSON.stringify(v)); } catch {} }, [key, v]);
  return [v, setV];
}
