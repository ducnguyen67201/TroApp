import type { ReactElement } from 'react';

interface ClassArtworkProps {
  kind: 'lesson' | 'code' | 'design' | 'books';
  className?: string;
}

/** Decorative artwork from the approved mock; it conveys no class status or subject. */
export function ClassArtwork({ kind, className }: ClassArtworkProps): ReactElement {
  if (kind === 'lesson') {
    return (
      <svg viewBox="0 0 180 160" className={className} aria-hidden="true">
        <ellipse cx="89" cy="139" rx="68" ry="8" fill="#eddec7" />
        <rect
          x="17"
          y="47"
          width="105"
          height="76"
          rx="7"
          fill="#faf4e5"
          stroke="#384653"
          strokeWidth="2"
        />
        <path d="M17 64h105" stroke="#384653" strokeWidth="2" />
        <circle cx="26" cy="55" r="2" fill="#d6a368" />
        <circle cx="34" cy="55" r="2" fill="#d6a368" />
        <path d="M41 81h57v15H41Z" fill="#95c5ed" />
        <path d="M47 96h58v15H47Z" fill="#a68acb" />
        <path d="M50 86h19m-13 17h27" stroke="#fff" strokeWidth="2" strokeLinecap="round" />
        <path
          d="m124 60 4-22 16 13 15-7 4 22c9 14 9 29 2 40l-19 6-20-10c-7-12-9-29-2-42Z"
          fill="#edb266"
          stroke="#384653"
          strokeWidth="2"
          strokeLinejoin="round"
        />
        <path d="m133 48 7 8m14-3 2 8" stroke="#384653" strokeWidth="2" />
        <ellipse cx="143" cy="81" rx="12" ry="10" fill="#fff5de" />
        <circle cx="135" cy="70" r="3" fill="#384653" />
        <circle cx="154" cy="70" r="3" fill="#384653" />
        <path
          d="m140 78 4 3 4-3m-4 3v6m-10-3-14-2m34 2 15-3"
          fill="none"
          stroke="#384653"
          strokeWidth="1.5"
          strokeLinecap="round"
        />
        <path
          d="m126 105-7 28h16l4-17m16-6 4 24h15"
          fill="#edb266"
          stroke="#384653"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path
          d="M167 99c25-2 15 30 7 15"
          fill="none"
          stroke="#384653"
          strokeWidth="5"
          strokeLinecap="round"
        />
        <path
          d="M167 99c25-2 15 30 7 15"
          fill="none"
          stroke="#edb266"
          strokeWidth="2"
          strokeLinecap="round"
        />
        <path
          d="m20 32 4-8m-1 11-8-2m90-6 5-7"
          stroke="#d1a174"
          strokeWidth="2"
          strokeLinecap="round"
        />
      </svg>
    );
  }
  if (kind === 'code') {
    return (
      <svg viewBox="0 0 180 160" className={className} aria-hidden="true">
        <ellipse cx="88" cy="139" rx="67" ry="7" fill="#e7e7ee" />
        <rect
          x="29"
          y="54"
          width="111"
          height="77"
          rx="5"
          fill="#edf3fb"
          stroke="#384653"
          strokeWidth="2"
        />
        <path d="M29 71h111" stroke="#384653" strokeWidth="2" />
        <circle cx="38" cy="62" r="2" fill="#9eabc2" />
        <path
          d="m60 90-9 8 9 8m44-16 9 8-9 8m-19-20-7 27"
          stroke="#8c79bc"
          strokeWidth="3"
          fill="none"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path
          d="M138 92V33c0-9-5-13-14-13h-19c-8 0-13 5-13 13v14h33v8H80c-10 0-14 6-14 15v9"
          fill="#85aed9"
          stroke="#384653"
          strokeWidth="2"
          strokeLinejoin="round"
        />
        <circle cx="106" cy="31" r="3" fill="#fff" />
        <path
          d="M112 67h37v35c0 9-5 14-14 14h-18c-8 0-13-5-13-13v-14h31v-8h-23"
          fill="#efcf7c"
          stroke="#384653"
          strokeWidth="2"
          strokeLinejoin="round"
        />
        <circle cx="135" cy="104" r="3" fill="#fff" />
        <path
          d="m18 48-6-5m136-18 5-5m7 8 7-1"
          stroke="#b4a0d0"
          strokeWidth="2"
          strokeLinecap="round"
        />
      </svg>
    );
  }
  if (kind === 'design') {
    return (
      <svg viewBox="0 0 180 160" className={className} aria-hidden="true">
        <ellipse cx="93" cy="139" rx="65" ry="7" fill="#ede6f0" />
        <rect
          x="34"
          y="43"
          width="86"
          height="91"
          rx="4"
          fill="#faf6ed"
          stroke="#384653"
          strokeWidth="2"
          transform="rotate(-7 77 89)"
        />
        <rect
          x="68"
          y="49"
          width="76"
          height="87"
          rx="4"
          fill="#daceec"
          stroke="#384653"
          strokeWidth="2"
          transform="rotate(8 106 92)"
        />
        <path
          d="m89 97 10-22 15 7-10 22-10 6-6-13Z"
          fill="#f0c77b"
          stroke="#384653"
          strokeWidth="2"
        />
        <path d="m98 77 14 6m-22 17 12 4" stroke="#384653" strokeWidth="1.5" />
        <path
          d="m41 69 17-2m-17 9 22-3m-17 16 13-2m43 36 23 3"
          stroke="#b59dc8"
          strokeWidth="2"
          strokeLinecap="round"
        />
        <path d="M34 124 21 95l10-5 13 29Z" fill="#86b4d1" stroke="#384653" strokeWidth="2" />
        <path d="m24 96 7-3m-1 12 6-3" stroke="#384653" strokeWidth="1.5" />
        <path
          d="m148 43 4-9m1 14 8-3m-131-7-4-8"
          stroke="#b59dc8"
          strokeWidth="2"
          strokeLinecap="round"
        />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 290 175" className={className} aria-hidden="true">
      <path d="M19 153h252" stroke="#384653" strokeWidth="4" strokeLinecap="round" />
      <path d="m36 97 35-4 5 58-35 2Z" fill="#efc57b" stroke="#384653" strokeWidth="2" />
      <path d="m51 111 3 31m8-36 3 35" stroke="#384653" strokeWidth="1.5" />
      <rect
        x="78"
        y="78"
        width="43"
        height="73"
        rx="3"
        fill="#a28bc8"
        stroke="#384653"
        strokeWidth="2"
      />
      <path
        d="M88 87h23M90 135h18m-18-34c14-10 26 8 12 12-16 5-8 18 4 15"
        fill="none"
        stroke="#f8f2fc"
        strokeWidth="2"
        strokeLinecap="round"
      />
      <rect
        x="127"
        y="52"
        width="34"
        height="100"
        rx="3"
        fill="#88b6a0"
        stroke="#384653"
        strokeWidth="2"
      />
      <path
        d="M135 62h17m-17 80h17m-13-62 9 9-9 9"
        stroke="#384653"
        strokeWidth="1.7"
        fill="none"
      />
      <path d="m168 48 32-3 8 107-32 1Z" fill="#efac88" stroke="#384653" strokeWidth="2" />
      <path d="m179 62 8 73m8-68 5 66" stroke="#384653" strokeWidth="1.5" />
      <path d="m207 40 26 3-8 108-25-2Z" fill="#a4c5e2" stroke="#384653" strokeWidth="2" />
      <path d="m214 53 8 1m-12 84 8 1" stroke="#384653" strokeWidth="1.5" />
      <path
        d="M50 69V41m0 16C34 52 30 36 34 25c18 6 21 15 16 32m0-10c13-8 23-21 20-31-17 4-24 16-20 31m0-8c-8-9-11-20-4-29 10 7 12 16 4 29"
        fill="#9fc1a8"
        stroke="#384653"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
      <path d="M32 60h35l-4 28H36Z" fill="#dfa271" stroke="#384653" strokeWidth="2" />
      <path d="m42 67 2 11m13-11-2 11" stroke="#a97350" strokeWidth="1.4" />
      <path d="m242 106 12-8 10 8-2 45h-24Z" fill="#fcf9ef" stroke="#384653" strokeWidth="2" />
      <circle cx="247" cy="120" r="2" fill="#384653" />
      <circle cx="256" cy="120" r="2" fill="#384653" />
      <path
        d="m249 130 4 3 5-3m-14-40 2-10m-8 8-7-3"
        fill="none"
        stroke="#384653"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}
