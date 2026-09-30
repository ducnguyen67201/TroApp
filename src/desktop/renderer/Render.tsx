import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import './App.css';

const rootElement = document.getElementById('root');

if (!rootElement) {
  throw new Error('The application root is missing.');
}

createRoot(rootElement).render(<App />);
