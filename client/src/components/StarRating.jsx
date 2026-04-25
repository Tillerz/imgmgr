import React, { useState } from 'react';

export default function StarRating({ value = 0, onChange, size = 'sm' }) {
  const [hover, setHover] = useState(-1);

  function handleClick(e, level) {
    e.stopPropagation();
    onChange?.(value === level ? 0 : level);
  }

  const display = hover >= 0 ? hover : value;

  return (
    <div className={`stars stars-${size}`} onMouseLeave={() => setHover(-1)}>
      {[1, 2, 3, 4, 5].map(n => (
        <span
          key={n}
          className={`star ${n <= display ? 'star-on' : 'star-off'}`}
          onMouseEnter={() => setHover(n)}
          onClick={e => handleClick(e, n)}
          title={`${n} star${n > 1 ? 's' : ''}`}
        >★</span>
      ))}
    </div>
  );
}
