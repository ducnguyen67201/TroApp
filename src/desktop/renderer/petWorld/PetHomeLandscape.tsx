import type { ReactElement } from 'react';
import { PetBackdropId } from '#contracts/Pet.js';

interface PetHomeLandscapeProps {
  backdropId: PetBackdropId | null;
}

/** Bundled scenery contains no uploaded markup, URLs or student content. */
export function PetHomeLandscape({ backdropId }: PetHomeLandscapeProps): ReactElement {
  const night = backdropId === PetBackdropId.STARRY_SKY;
  const reading = backdropId === PetBackdropId.READING_NOOK;
  return (
    <svg
      className="pet-home-landscape"
      viewBox="0 0 600 360"
      preserveAspectRatio="xMidYMid slice"
      aria-hidden="true"
    >
      <rect width="600" height="360" fill={night ? '#303c5b' : reading ? '#eee2cc' : '#e9efdf'} />
      {night ? (
        <>
          <circle cx="470" cy="63" r="26" fill="#f5edc4" />
          <circle cx="483" cy="54" r="25" fill="#303c5b" />
          {[110, 220, 350, 420, 535].map((x, index) => (
            <circle key={x} cx={x} cy={35 + index * 19} r="2" fill="#fff6d3" />
          ))}
        </>
      ) : (
        <>
          <circle cx="476" cy="66" r="34" fill="#eddda8" />
          <path d="M392 50h38a12 12 0 0 0-24-5 10 10 0 0 0-14 5" fill="#fffdf1" />
          <path d="M105 83h42a13 13 0 0 0-25-7 11 11 0 0 0-17 7" fill="#fffdf1" />
        </>
      )}
      <path d="M0 190Q90 140 195 191T390 184T600 165V360H0Z" fill={night ? '#586c65' : '#cadbb3'} />
      <path d="M0 245Q145 195 310 233T600 225V360H0Z" fill={night ? '#6f806b' : '#dbe4b9'} />
      <path
        d="M275 360Q317 294 292 260Q266 225 285 204"
        stroke="#e5ddb6"
        strokeWidth="42"
        fill="none"
      />
      <path d="M125 231V151L196 106 269 151V231Z" fill="#e5d4a0" />
      <path d="M109 153 196 92 285 153 273 164 196 111 121 164Z" fill="#c98f77" />
      <path d="M176 231V190a20 20 0 0 1 40 0v41" fill="#c3a568" stroke="#a98b54" strokeWidth="4" />
      <path
        d="M142 172h24v28h-24Zm88 0h24v28h-24Z"
        fill="#7e9d89"
        stroke="#f7e8bc"
        strokeWidth="4"
      />
      <path d="M154 172v28m-12-14h24m76-14v28m-12-14h24" stroke="#f7e8bc" strokeWidth="2" />
      <path d="M462 225 466 131l12-2 5 96" fill="#a5976b" />
      <path d="M444 189 471 156 492 178" stroke="#8e8a60" strokeWidth="5" fill="none" />
      <ellipse cx="474" cy="125" rx="67" ry="48" fill={night ? '#647e6c' : '#94b98c'} />
      <ellipse cx="451" cy="104" rx="38" ry="33" fill={night ? '#6b8573' : '#a4c497'} />
      <path
        d="M403 255q57-29 111 1t-61 34q-57-7-50-35"
        fill="#b1c3cb"
        stroke="#dce1c2"
        strokeWidth="8"
      />
      <path d="M423 258q37-13 68 0m-54 17q22 6 43-1" stroke="#edf2e5" strokeWidth="2" fill="none" />
      <path d="M0 341q122-33 238 0t362-7v26H0" fill={night ? '#61745d' : '#c4d59e'} />
      {reading && (
        <>
          <path d="M323 205h49v63h-49Z" fill="#ac986b" />
          <path
            d="M329 212h7v20h-7Zm10 0h8v20h-8Zm12 0h13v20h-13Zm-22 28h12v21h-12Zm16 0h7v21h-7Zm11 0h8v21h-8Z"
            fill="#e8d3a4"
          />
        </>
      )}
    </svg>
  );
}
