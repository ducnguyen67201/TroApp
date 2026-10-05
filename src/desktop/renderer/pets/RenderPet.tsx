import { createRoot } from 'react-dom/client';
import { PetOverlay } from './PetOverlay.js';

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error('Pet root is missing.');
}
createRoot(rootElement).render(<PetOverlay />);
