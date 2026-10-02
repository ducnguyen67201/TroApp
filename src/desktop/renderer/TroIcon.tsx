import type { ReactElement } from 'react';
import troMark from '../assets/TroMark.png';

interface TroIconProps {
  size: number;
}

/** Decorative brand artwork; the surrounding label supplies its accessible name. */
export function TroIcon({ size }: TroIconProps): ReactElement {
  return (
    <img src={troMark} width={size} height={size} alt="" aria-hidden="true" className="tro-icon" />
  );
}
