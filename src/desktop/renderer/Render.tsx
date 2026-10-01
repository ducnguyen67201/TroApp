import { createRoot } from 'react-dom/client';
import { MantineProvider } from '@mantine/core';
import { App } from './App.js';
import { LocaleProvider } from './localization/LocaleProvider.js';
import { desktopTheme, resolveDesktopCssVariables } from './Theme.js';
import '@mantine/core/styles.css';
import './App.css';

const rootElement = document.getElementById('root');

if (!rootElement) {
  throw new Error('The application root is missing.');
}

createRoot(rootElement).render(
  <MantineProvider
    theme={desktopTheme}
    cssVariablesResolver={resolveDesktopCssVariables}
    forceColorScheme="light"
  >
    <LocaleProvider>
      <App />
    </LocaleProvider>
  </MantineProvider>,
);
