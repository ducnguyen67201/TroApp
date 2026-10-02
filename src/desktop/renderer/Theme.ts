import { Button, Paper, createTheme, type CSSVariablesResolver } from '@mantine/core';
import { DesktopWindowAppearance, TroPalette } from '../DesktopAppearance.js';

const fontFamily = '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';

export const desktopTheme = createTheme({
  fontFamily,
  white: TroPalette.CREAM,
  black: TroPalette.BLACK,
  primaryColor: 'charcoal',
  primaryShade: 8,
  defaultRadius: 'md',
  colors: {
    charcoal: [
      TroPalette.CREAM,
      `color-mix(in srgb, ${TroPalette.CREAM}, ${TroPalette.GRAY} 25%)`,
      `color-mix(in srgb, ${TroPalette.CREAM}, ${TroPalette.GRAY} 50%)`,
      TroPalette.GRAY,
      `color-mix(in srgb, ${TroPalette.GRAY}, ${TroPalette.CHARCOAL} 25%)`,
      `color-mix(in srgb, ${TroPalette.GRAY}, ${TroPalette.CHARCOAL} 50%)`,
      `color-mix(in srgb, ${TroPalette.GRAY}, ${TroPalette.CHARCOAL} 75%)`,
      TroPalette.CHARCOAL,
      TroPalette.BLACK,
      `color-mix(in srgb, ${TroPalette.BLACK}, black 20%)`,
    ],
  },
  headings: { fontFamily, fontWeight: '600' },
  components: {
    Button: Button.extend({ defaultProps: { size: 'sm', fw: 500 } }),
    Paper: Paper.extend({ defaultProps: { radius: 'lg' } }),
  },
});

/** Semantic tokens keep layout styles free of duplicated palette values. */
export const resolveDesktopCssVariables: CSSVariablesResolver = () => ({
  variables: {
    '--tro-surface': TroPalette.CREAM,
    '--tro-sidebar': DesktopWindowAppearance.BACKGROUND,
    '--tro-muted-surface': `color-mix(in srgb, ${TroPalette.CREAM}, ${TroPalette.GRAY} 12%)`,
    '--tro-selection': `color-mix(in srgb, ${TroPalette.CREAM}, ${TroPalette.GRAY} 42%)`,
    '--tro-border': `color-mix(in srgb, ${TroPalette.CREAM}, ${TroPalette.GRAY} 65%)`,
    '--tro-text': TroPalette.BLACK,
    '--tro-muted': TroPalette.CHARCOAL,
    '--tro-accent': TroPalette.ORANGE,
    '--tro-panel-radius': '24px',
  },
  light: {
    '--mantine-color-body': TroPalette.CREAM,
    '--mantine-color-text': TroPalette.BLACK,
    '--mantine-color-dimmed': TroPalette.CHARCOAL,
    '--mantine-color-placeholder': TroPalette.CHARCOAL,
    '--mantine-color-disabled': 'var(--tro-selection)',
    '--mantine-color-disabled-color': TroPalette.CHARCOAL,
    '--mantine-color-default': TroPalette.CREAM,
    '--mantine-color-default-color': TroPalette.BLACK,
    '--mantine-color-default-border': 'var(--tro-border)',
    '--mantine-color-default-hover': 'var(--tro-selection)',
  },
  dark: {},
});
