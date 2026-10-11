import type { ReactElement } from 'react';
import { PetBackdropId } from '#contracts/Pet.js';

/** Trusted bundled scenery, independent of the animated pet provider and its hit region. */
export function PetBackdrop({ backdropId }: { backdropId: PetBackdropId }): ReactElement {
  return (
    <svg
      className="pet-backdrop"
      viewBox="0 0 136 100"
      aria-hidden="true"
      focusable="false"
      data-backdrop={backdropId}
    >
      {backdropId === PetBackdropId.MEADOW && (
        <>
          <ellipse cx="68" cy="80" rx="65" ry="18" fill="#dce7bf" />
          <ellipse cx="68" cy="83" rx="50" ry="11" fill="#b5cc9b" />
          <path
            d="M20 78V60m0 9q-12-13-11-1 1 7 11 6m0-10q10-17 13-4 0 7-13 11"
            stroke="#719263"
            fill="#8fab76"
            strokeWidth="2"
          />
          <path
            d="M115 80V60m0 9q-10-13-12-3 1 7 12 8m0-9q9-16 12-4 0 6-12 12"
            stroke="#719263"
            fill="#8fab76"
            strokeWidth="2"
          />
          <circle cx="29" cy="84" r="3" fill="#f5cf83" />
          <circle cx="108" cy="87" r="3" fill="#e9b9bb" />
        </>
      )}
      {backdropId === PetBackdropId.READING_NOOK && (
        <>
          <rect x="6" y="18" width="124" height="72" rx="23" fill="#efe3cc" />
          <path d="M16 82h104" stroke="#cfb98d" strokeWidth="3" />
          <rect x="12" y="28" width="29" height="42" rx="4" fill="#b3beaa" />
          <path d="M15 49h23" stroke="#7a947e" strokeWidth="3" />
          <path d="M20 34v12m7-12v12m7-12v12" stroke="#f9efd8" strokeWidth="4" />
          <path d="M111 39v37m-9 0h18" stroke="#9a8a68" strokeWidth="3" />
          <path d="m99 40 6-15h13l6 15z" fill="#e4bf72" />
          <ellipse cx="70" cy="85" rx="35" ry="7" fill="#d2b997" />
        </>
      )}
      {backdropId === PetBackdropId.STARRY_SKY && (
        <>
          <rect x="6" y="12" width="124" height="78" rx="27" fill="#303e60" />
          <path d="M100 23a12 12 0 1 0 12 16 11 11 0 0 1-12-16" fill="#f6dfa3" />
          <path
            d="M29 25v7m-3-3h6m36-9v7m-3-3h6m-21 17v6m-3-3h6m63 16v6m-3-3h6"
            stroke="#e7dcbb"
            strokeWidth="2"
          />
          <ellipse cx="68" cy="84" rx="57" ry="9" fill="#586a82" />
        </>
      )}
    </svg>
  );
}
