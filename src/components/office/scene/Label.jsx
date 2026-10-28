import { createContext, useContext } from 'react';
import { Html } from '@react-three/drei';

/**
 * In-scene HTML labels render into an overlay element the scene owns.
 * drei's default target is swapped once the canvas connects its event layer,
 * which empties any label mounted before that moment; a fixed portal avoids it.
 */
export const LabelLayer = createContext(null);

export function Label(props) {
  const layer = useContext(LabelLayer);
  return (
    <Html
      center
      style={{ pointerEvents: 'none' }}
      {...props}
      portal={layer ?? undefined}
    />
  );
}
